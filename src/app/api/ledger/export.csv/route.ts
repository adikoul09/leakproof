/**
 * GET /api/ledger/export.csv — the whole chain, streamed as CSV.
 *
 * Streamed rather than buffered: the ledger grows without bound and an
 * auditor's export must not be limited by the server's memory. Includes
 * prev_hash and hash so the export can be verified independently of this app.
 */
import { asc } from 'drizzle-orm';
import { db } from '@/db/client';
import { auditLedger } from '@/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PAGE = 500;

const COLUMNS = [
  'seq', 'ts', 'event_id', 'failure_class', 'policy_version', 'gate_result',
  'arm', 'action', 'outcome', 'cost_paise', 'actor', 'detail', 'prev_hash', 'hash',
] as const;

/** RFC 4180: quote everything, double embedded quotes. */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

export async function GET() {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(`${COLUMNS.join(',')}\n`));

      let offset = 0;
      try {
        for (;;) {
          const page = await db
            .select()
            .from(auditLedger)
            .orderBy(asc(auditLedger.seq))
            .limit(PAGE)
            .offset(offset);
          if (page.length === 0) break;

          for (const r of page) {
            controller.enqueue(
              encoder.encode(
                [
                  r.seq, r.ts, r.eventId, r.failureClass, r.policyVersion, r.gateResult,
                  r.arm, r.action, r.outcome, r.costPaise, r.actor, r.detail, r.prevHash, r.hash,
                ]
                  .map(csvCell)
                  .join(',') + '\n',
              ),
            );
          }

          if (page.length < PAGE) break;
          offset += PAGE;
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="leakproof-audit-ledger.csv"',
      'cache-control': 'no-store',
    },
  });
}
