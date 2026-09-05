/**
 * Chain verification — blueprint 6.3.
 *
 * Streams the ledger in `seq` order, recomputing every hash from the previous
 * one and the row's own content. Returns the first break rather than a boolean,
 * because "the chain is broken" is not actionable and "row 4,182 does not match
 * its stated hash" is.
 *
 * Three distinct failures are separated on purpose — they mean different
 * things to whoever is investigating:
 *
 *   bad_genesis   the first row does not start from 64 zeroes
 *   broken_link   a row's prev_hash does not match the previous row's hash
 *                 (a row was deleted, inserted, or reordered)
 *   content_edit  prev_hash is right but the row's own hash does not match its
 *                 content (the row itself was rewritten)
 */
import { asc, gt } from 'drizzle-orm';
import { db } from '@/db/client';
import { auditLedger } from '@/db/schema';
import { GENESIS_PREV_HASH } from './canonical';
import { chainHash } from './chain';
import { hashedPayload } from './append';

export type BreakKind = 'bad_genesis' | 'broken_link' | 'content_edit';

export interface ChainBreak {
  seq: number;
  kind: BreakKind;
  expected: string;
  actual: string;
  explanation: string;
}

export interface VerifyResult {
  intact: boolean;
  records: number;
  genesisHash: string | null;
  headHash: string | null;
  brokenAtSeq?: number;
  break?: ChainBreak;
  verifiedInMs: number;
}

/** Rows pulled per round trip. The chain can outgrow memory; the check cannot. */
const PAGE = 1000;

export async function verifyChain(): Promise<VerifyResult> {
  const started = Date.now();

  let prevHash = GENESIS_PREV_HASH;
  let records = 0;
  let genesisHash: string | null = null;
  let headHash: string | null = null;
  /** Keyset cursor: the `seq` of the last row already verified. */
  let afterSeq = -1;

  for (;;) {
    /**
     * Keyset, not OFFSET.
     *
     * `OFFSET n` makes Postgres walk and discard n rows before returning
     * anything, so verifying an m-row chain in pages costs O(m²) — at 11,533
     * records under concurrent write load this measured 148 seconds, which is
     * past the ceiling of every serverless platform this could deploy to and
     * would have taken the Ledger screen's headline check down in production.
     *
     * `seq` is a monotonic bigserial on an append-only table, so it is a
     * perfect cursor. `/api/ledger` already paginates this way and says why;
     * this function simply had not been given the same treatment.
     */
    const page = await db
      .select()
      .from(auditLedger)
      .where(gt(auditLedger.seq, afterSeq))
      .orderBy(asc(auditLedger.seq))
      .limit(PAGE);

    if (page.length === 0) break;

    for (const row of page) {
      if (records === 0) {
        genesisHash = row.hash;
        if (row.prevHash !== GENESIS_PREV_HASH) {
          return {
            intact: false,
            records,
            genesisHash,
            headHash,
            brokenAtSeq: row.seq,
            break: {
              seq: row.seq,
              kind: 'bad_genesis',
              expected: GENESIS_PREV_HASH,
              actual: row.prevHash,
              explanation:
                'the first row does not start from the genesis hash — rows before it were removed',
            },
            verifiedInMs: Date.now() - started,
          };
        }
      } else if (row.prevHash !== prevHash) {
        return {
          intact: false,
          records,
          genesisHash,
          headHash,
          brokenAtSeq: row.seq,
          break: {
            seq: row.seq,
            kind: 'broken_link',
            expected: prevHash,
            actual: row.prevHash,
            explanation:
              'this row does not point at the row before it — a row was deleted, inserted or reordered',
          },
          verifiedInMs: Date.now() - started,
        };
      }

      const recomputed = chainHash(row.prevHash, hashedPayload(
        {
          eventId: row.eventId,
          failureClass: row.failureClass,
          policyVersion: row.policyVersion,
          gateResult: row.gateResult,
          arm: row.arm,
          llmPromptHash: row.llmPromptHash,
          action: row.action,
          outcome: row.outcome,
          costPaise: row.costPaise,
          actor: row.actor,
          detail: row.detail as Record<string, unknown> | null,
        },
        row.ts,
      ));

      if (recomputed !== row.hash) {
        return {
          intact: false,
          records,
          genesisHash,
          headHash,
          brokenAtSeq: row.seq,
          break: {
            seq: row.seq,
            kind: 'content_edit',
            expected: recomputed,
            actual: row.hash,
            explanation: 'the row content does not produce its stored hash — this row was rewritten',
          },
          verifiedInMs: Date.now() - started,
        };
      }

      prevHash = row.hash;
      headHash = row.hash;
      afterSeq = row.seq;
      records += 1;
    }

    if (page.length < PAGE) break;
  }

  return {
    intact: true,
    records,
    genesisHash,
    headHash,
    verifiedInMs: Date.now() - started,
  };
}
