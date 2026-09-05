/**
 * GET /api/ledger?from=&to=&arm=&outcome=&action=&event_id=&limit=&cursor=
 *
 * Keyset pagination on `seq`. Offset pagination would let rows shift between
 * pages as the chain grows; on an append-only table `seq` is a stable cursor.
 */
import { NextResponse } from 'next/server';
import { and, desc, eq, gte, lte, lt, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { auditLedger } from '@/db/schema';
import { errorResponse, requestId } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  arm: z.enum(['control', 'naive', 'leakproof']).optional(),
  outcome: z.string().optional(),
  action: z.string().optional(),
  event_id: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  /** `seq` of the last row of the previous page. */
  cursor: z.coerce.number().int().optional(),
});

export async function GET(req: Request) {
  const reqId = requestId();
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));

  if (!parsed.success) {
    return errorResponse(
      422,
      'BAD_REQUEST',
      'Invalid query parameters',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      reqId,
    );
  }

  const q = parsed.data;
  const filters: SQL[] = [];
  if (q.from) filters.push(gte(auditLedger.ts, new Date(q.from)));
  if (q.to) filters.push(lte(auditLedger.ts, new Date(q.to)));
  if (q.arm) filters.push(eq(auditLedger.arm, q.arm));
  if (q.outcome) filters.push(eq(auditLedger.outcome, q.outcome));
  if (q.action) filters.push(eq(auditLedger.action, q.action));
  if (q.event_id) filters.push(eq(auditLedger.eventId, q.event_id));
  if (q.cursor !== undefined) filters.push(lt(auditLedger.seq, q.cursor));

  const rows = await db
    .select()
    .from(auditLedger)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(auditLedger.seq))
    .limit(q.limit + 1);

  const hasMore = rows.length > q.limit;
  const items = hasMore ? rows.slice(0, q.limit) : rows;

  return NextResponse.json(
    {
      items: items.map((r) => ({
        seq: r.seq,
        ts: r.ts,
        event_id: r.eventId,
        failure_class: r.failureClass,
        policy_version: r.policyVersion,
        gate_result: r.gateResult,
        arm: r.arm,
        // Part of the hashed payload, so it has to be here: without it the
        // Ledger screen cannot recompute a row's hash in the browser, and the
        // chain becomes something the server merely asserts.
        llm_prompt_hash: r.llmPromptHash,
        action: r.action,
        outcome: r.outcome,
        cost_paise: r.costPaise,
        actor: r.actor,
        detail: r.detail,
        prev_hash: r.prevHash,
        hash: r.hash,
      })),
      next_cursor: hasMore ? items[items.length - 1].seq : null,
    },
    { headers: { 'x-request-id': reqId } },
  );
}

