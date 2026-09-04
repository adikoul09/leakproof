/**
 * Appending to the audit hash chain — blueprint 6.3.
 *
 * Every row carries the hash of the row before it, so any edit to any row
 * invalidates every hash after it. The database also refuses UPDATE and DELETE
 * on this table via a trigger (see drizzle/0000_init.sql), so the chain holds
 * even against a direct psql session.
 *
 * ── Concurrency ──────────────────────────────────────────────────────
 *
 * The blueprint says to `SELECT ... FOR UPDATE` the head row. That is the
 * right instinct and it does not quite work: `FOR UPDATE` locks rows that
 * exist, and the chain's first append has no head row to lock. Two concurrent
 * genesis appends would both read "no head", both use the genesis prev_hash,
 * and fork the chain at row one.
 *
 * So the lock is a transaction-scoped **advisory lock** on a fixed key. It
 * exists whether or not the table does, it is released automatically when the
 * transaction ends (commit or rollback), and it serialises appends without
 * blocking readers. Under it, read-head-then-insert is atomic.
 */
import { desc, eq } from 'drizzle-orm';
import { sql as raw } from 'drizzle-orm';
import { db } from '@/db/client';
import { auditLedger } from '@/db/schema';
import type { Arm } from '@/core/experiment/assign';
import { GENESIS_PREV_HASH, chainHash } from './canonical';

/** Arbitrary but fixed. Any other advisory lock in the app must not reuse it. */
const LEDGER_LOCK_KEY = 0x1eadbeef;

export interface LedgerInput {
  eventId?: string | null;
  failureClass?: string | null;
  policyVersion?: string | null;
  gateResult?: string | null;
  arm?: Arm | null;
  llmPromptHash?: string | null;
  /** What happened. Required — a ledger row with no action is not a record. */
  action: string;
  outcome?: string | null;
  costPaise?: number;
  /** 'system' or 'operator:<email>'. A human decision must say so. */
  actor?: string;
  detail?: Record<string, unknown> | null;
}

export interface LedgerRow {
  seq: number;
  ts: string;
  action: string;
  prevHash: string;
  hash: string;
}

/**
 * The exact object that gets hashed.
 *
 * `seq` is deliberately excluded: it is assigned by the database on insert, so
 * it is not knowable at hash time. Ordering is already protected by the chain
 * itself — a row cannot be moved without breaking every hash after it.
 *
 * `ts` is set here rather than by the column default, because a value the
 * database chooses after the hash is computed would not be covered by it.
 */
export function hashedPayload(input: LedgerInput, ts: Date) {
  return {
    ts: ts.toISOString(),
    event_id: input.eventId ?? null,
    failure_class: input.failureClass ?? null,
    policy_version: input.policyVersion ?? null,
    gate_result: input.gateResult ?? null,
    arm: input.arm ?? null,
    llm_prompt_hash: input.llmPromptHash ?? null,
    action: input.action,
    outcome: input.outcome ?? null,
    cost_paise: input.costPaise ?? 0,
    actor: input.actor ?? 'system',
    detail: (input.detail ?? null) as Record<string, unknown> | null,
  };
}

export async function appendLedger(input: LedgerInput): Promise<LedgerRow> {
  return db.transaction(async (tx) => {
    // Serialise appends. Transaction-scoped, so it is released on commit or
    // rollback without any cleanup path of our own.
    await tx.execute(raw`select pg_advisory_xact_lock(${LEDGER_LOCK_KEY})`);

    const [head] = await tx
      .select({ hash: auditLedger.hash })
      .from(auditLedger)
      .orderBy(desc(auditLedger.seq))
      .limit(1);

    const prevHash = head?.hash ?? GENESIS_PREV_HASH;
    const ts = new Date();
    const payload = hashedPayload(input, ts);
    const hash = chainHash(prevHash, payload);

    const [row] = await tx
      .insert(auditLedger)
      .values({
        ts,
        eventId: payload.event_id,
        failureClass: payload.failure_class,
        policyVersion: payload.policy_version,
        gateResult: payload.gate_result,
        arm: payload.arm,
        llmPromptHash: payload.llm_prompt_hash,
        action: payload.action,
        outcome: payload.outcome,
        costPaise: payload.cost_paise,
        actor: payload.actor,
        detail: payload.detail,
        prevHash,
        hash,
      })
      .returning({ seq: auditLedger.seq, ts: auditLedger.ts });

    return { seq: row.seq, ts: row.ts.toISOString(), action: payload.action, prevHash, hash };
  });
}

/**
 * Append without letting a ledger failure take down the thing being recorded.
 *
 * A deliberate trade-off, and it runs the opposite way to what you might
 * expect: recovery work that has already happened in the outside world (a link
 * created, a message sent) must not be rolled back because its receipt could
 * not be written. Losing the receipt is bad; re-sending a customer a second
 * payment link because the ledger was briefly unavailable is worse.
 *
 * The gap is visible rather than silent: `ledger.verify` runs hourly, and a
 * missing row shows up as a chain that is intact but shorter than the events
 * it should describe.
 */
export async function appendLedgerSafe(input: LedgerInput): Promise<LedgerRow | null> {
  try {
    return await appendLedger(input);
  } catch (err) {
    console.error(`[ledger] append failed for action=${input.action}`, err);
    return null;
  }
}

export async function ledgerHead(): Promise<{ seq: number; hash: string } | null> {
  const [row] = await db
    .select({ seq: auditLedger.seq, hash: auditLedger.hash })
    .from(auditLedger)
    .orderBy(desc(auditLedger.seq))
    .limit(1);
  return row ?? null;
}

export async function ledgerRowByHash(hash: string) {
  const [row] = await db.select().from(auditLedger).where(eq(auditLedger.hash, hash)).limit(1);
  return row ?? null;
}
