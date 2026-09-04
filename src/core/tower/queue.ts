/**
 * The at-risk queue — blueprint Screen 2.
 *
 * One query per page, joining everything a row shows: classification, arm,
 * latest attempt, and the policy verdict. The alternative (fetch ids, then
 * fan out) is what turns a 50-row table into 200 round trips to Singapore.
 *
 * Keyset pagination on (failed_at, id) rather than OFFSET. The queue is
 * live-appending, so an offset silently skips or repeats rows as new events
 * land above the cursor — the classic pagination bug, and on this screen it
 * would look like events vanishing.
 */
import { and, desc, eq, isNotNull, isNull, lt, or, sql as raw } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  armAssignments,
  classifications,
  paymentEvents,
  policyEvaluations,
  recoveryAttempts,
} from '@/db/schema';

export type QueueFilter =
  | 'all'
  | 'systemic'
  | 'idiosyncratic'
  | 'blocked'
  | 'control'
  | 'recovered';

export interface QueueRow {
  id: string;
  surface: string;
  failed_at: string;
  amount_paise: number;
  customer_masked: string | null;
  method: string | null;
  issuer: string | null;
  failure_class: string | null;
  kind: string | null;
  confidence: number | null;
  cohort_key: string | null;
  arm: string | null;
  state: string;
  rail: string | null;
  attempt_no: number | null;
  scheduled_for: string | null;
  attempt_outcome: string | null;
  gate_result: string | null;
  recovered_at: string | null;
  recovered_paise: number | null;
  is_synthetic: boolean;
}

export interface QueuePage {
  rows: QueueRow[];
  /** Opaque; pass back as `cursor`. Null when the page is the last one. */
  next_cursor: string | null;
  counts: Record<QueueFilter, number>;
}

const encodeCursor = (failedAt: Date, id: string) =>
  Buffer.from(`${failedAt.toISOString()}|${id}`).toString('base64url');

function decodeCursor(cursor: string): { failedAt: Date; id: string } | null {
  try {
    const [ts, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const failedAt = new Date(ts);
    if (Number.isNaN(failedAt.getTime()) || !id) return null;
    return { failedAt, id };
  } catch {
    return null;
  }
}

function filterClause(filter: QueueFilter) {
  switch (filter) {
    case 'systemic':
      return eq(classifications.kind, 'systemic');
    case 'idiosyncratic':
      return eq(classifications.kind, 'idiosyncratic');
    case 'blocked':
      return eq(paymentEvents.state, 'blocked_by_policy');
    case 'control':
      return eq(armAssignments.arm, 'control');
    case 'recovered':
      // The timestamp, not the state label — see FAILURES.md #19.
      return isNotNull(paymentEvents.recoveredAt);
    default:
      return undefined;
  }
}

export interface QueueQuery {
  filter?: QueueFilter;
  limit?: number;
  cursor?: string;
  batchId?: string;
}

export async function loadQueue(q: QueueQuery = {}): Promise<QueuePage> {
  const filter = q.filter ?? 'all';
  const limit = Math.min(200, Math.max(1, q.limit ?? 50));
  const cursor = q.cursor ? decodeCursor(q.cursor) : null;

  /**
   * The most recent attempt per event. A left join straight onto
   * recovery_attempts would multiply rows once an event has been retried,
   * and the queue would show the same payment three times.
   */
  const latestAttempt = db
    .select({
      eventId: recoveryAttempts.eventId,
      rail: recoveryAttempts.rail,
      attemptNo: recoveryAttempts.attemptNo,
      scheduledFor: recoveryAttempts.scheduledFor,
      outcome: recoveryAttempts.outcome,
      rn: raw<number>`row_number() over (partition by ${recoveryAttempts.eventId} order by ${recoveryAttempts.attemptNo} desc)`.as('rn'),
    })
    .from(recoveryAttempts)
    .as('la');

  const latestGate = db
    .select({
      eventId: policyEvaluations.eventId,
      gateResult: policyEvaluations.gateResult,
      rn: raw<number>`row_number() over (partition by ${policyEvaluations.eventId} order by ${policyEvaluations.evaluatedAt} desc)`.as('grn'),
    })
    .from(policyEvaluations)
    .as('lg');

  const where = and(
    ...[
      q.batchId ? eq(paymentEvents.batchId, q.batchId) : undefined,
      filterClause(filter),
      cursor
        ? or(
            lt(paymentEvents.failedAt, cursor.failedAt),
            and(eq(paymentEvents.failedAt, cursor.failedAt), lt(paymentEvents.id, cursor.id)),
          )
        : undefined,
    ].filter(Boolean),
  );

  const rows = await db
    .select({
      id: paymentEvents.id,
      surface: paymentEvents.surface,
      failedAt: paymentEvents.failedAt,
      amountPaise: paymentEvents.amountPaise,
      customerMasked: raw<string | null>`(select c.phone_masked from customers c where c.id = ${paymentEvents.customerId})`,
      method: paymentEvents.method,
      issuer: paymentEvents.issuer,
      state: paymentEvents.state,
      isSynthetic: paymentEvents.isSynthetic,
      recoveredAt: paymentEvents.recoveredAt,
      recoveredPaise: paymentEvents.recoveredPaise,
      failureClass: classifications.failureClass,
      kind: classifications.kind,
      confidence: classifications.confidence,
      cohortKey: classifications.cohortKey,
      arm: armAssignments.arm,
      rail: latestAttempt.rail,
      attemptNo: latestAttempt.attemptNo,
      scheduledFor: latestAttempt.scheduledFor,
      attemptOutcome: latestAttempt.outcome,
      gateResult: latestGate.gateResult,
    })
    .from(paymentEvents)
    .leftJoin(classifications, eq(classifications.eventId, paymentEvents.id))
    .leftJoin(armAssignments, eq(armAssignments.eventId, paymentEvents.id))
    .leftJoin(latestAttempt, and(eq(latestAttempt.eventId, paymentEvents.id), eq(latestAttempt.rn, 1)))
    .leftJoin(latestGate, and(eq(latestGate.eventId, paymentEvents.id), eq(latestGate.rn, 1)))
    .where(where)
    .orderBy(desc(paymentEvents.failedAt), desc(paymentEvents.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];

  return {
    rows: page.map((r) => ({
      id: r.id,
      surface: r.surface,
      failed_at: r.failedAt.toISOString(),
      amount_paise: r.amountPaise,
      customer_masked: r.customerMasked,
      method: r.method,
      issuer: r.issuer,
      failure_class: r.failureClass,
      kind: r.kind,
      confidence: r.confidence === null ? null : Number(r.confidence),
      cohort_key: r.cohortKey,
      arm: r.arm,
      state: r.state,
      rail: r.rail,
      attempt_no: r.attemptNo,
      scheduled_for: r.scheduledFor ? new Date(r.scheduledFor).toISOString() : null,
      attempt_outcome: r.attemptOutcome,
      gate_result: r.gateResult,
      recovered_at: r.recoveredAt ? new Date(r.recoveredAt).toISOString() : null,
      recovered_paise: r.recoveredPaise,
      is_synthetic: r.isSynthetic,
    })),
    next_cursor: rows.length > limit && last ? encodeCursor(last.failedAt, last.id) : null,
    counts: await queueCounts(q.batchId),
  };
}

/** Tab badges. One pass, not six queries. */
export async function queueCounts(batchId?: string): Promise<Record<QueueFilter, number>> {
  const scope = batchId ? eq(paymentEvents.batchId, batchId) : undefined;
  const [r] = await db
    .select({
      all: raw<number>`count(*)::int`,
      systemic: raw<number>`count(*) filter (where ${classifications.kind} = 'systemic')::int`,
      idiosyncratic: raw<number>`count(*) filter (where ${classifications.kind} = 'idiosyncratic')::int`,
      blocked: raw<number>`count(*) filter (where ${paymentEvents.state} = 'blocked_by_policy')::int`,
      control: raw<number>`count(*) filter (where ${armAssignments.arm} = 'control')::int`,
      recovered: raw<number>`count(*) filter (where ${paymentEvents.recoveredAt} is not null)::int`,
    })
    .from(paymentEvents)
    .leftJoin(classifications, eq(classifications.eventId, paymentEvents.id))
    .leftJoin(armAssignments, eq(armAssignments.eventId, paymentEvents.id))
    .where(scope);

  return {
    all: r?.all ?? 0,
    systemic: r?.systemic ?? 0,
    idiosyncratic: r?.idiosyncratic ?? 0,
    blocked: r?.blocked ?? 0,
    control: r?.control ?? 0,
    recovered: r?.recovered ?? 0,
  };
}

/** Events still genuinely open, for the "AT RISK NOW" tile. */
export async function atRiskNow(batchId?: string): Promise<{ n: number; paise: number }> {
  const [r] = await db
    .select({
      n: raw<number>`count(*)::int`,
      paise: raw<number>`coalesce(sum(${paymentEvents.amountPaise}), 0)::bigint`,
    })
    .from(paymentEvents)
    .where(
      and(
        isNull(paymentEvents.recoveredAt),
        raw`${paymentEvents.state} not in ('lost','stopped')`,
        batchId ? eq(paymentEvents.batchId, batchId) : undefined,
      ),
    );
  return { n: r?.n ?? 0, paise: Number(r?.paise ?? 0) };
}
