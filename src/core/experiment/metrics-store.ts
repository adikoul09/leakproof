/**
 * Reads the experiment out of the database and into the pure metric functions.
 *
 * Kept separate from `metrics.ts` for the usual reason: the replay engine
 * builds the same `ArmsInput` from a historical corpus and calls the same
 * `computeMetrics`, so a what-if number and a live number are produced by one
 * implementation rather than two that drift.
 */
import { and, eq, gte, lte, sql as raw } from 'drizzle-orm';
import { db } from '@/db/client';
import { armAssignments, messages, paymentEvents, recoveryAttempts } from '@/db/schema';
import { getLivePolicy } from '@/core/policy/store';
import { RATES } from '@/core/cost/meter';
import type { Arm } from './assign';
import { type ArmsInput, type MetricEvent, computeMetrics, type MetricsSummary } from './metrics';

export interface MetricsWindow {
  from?: Date;
  to?: Date;
  /**
   * Restrict to one generated batch. Lets a synthetic run be measured against
   * the ground truth it was generated with, without the numbers being polluted
   * by whatever else is in the table.
   */
  batchId?: string;
}

const ARMS: Arm[] = ['control', 'naive', 'leakproof'];

function windowClause(w: MetricsWindow) {
  const parts = [];
  if (w.from) parts.push(gte(paymentEvents.failedAt, w.from));
  if (w.to) parts.push(lte(paymentEvents.failedAt, w.to));
  if (w.batchId) parts.push(eq(paymentEvents.batchId, w.batchId));
  return parts.length ? and(...parts) : undefined;
}

export async function loadArms(w: MetricsWindow = {}): Promise<ArmsInput> {
  const rows = await db
    .select({
      arm: armAssignments.arm,
      amountPaise: paymentEvents.amountPaise,
      recoveredPaise: paymentEvents.recoveredPaise,
      recoveredAt: paymentEvents.recoveredAt,
    })
    .from(paymentEvents)
    .innerJoin(armAssignments, eq(armAssignments.eventId, paymentEvents.id))
    .where(windowClause(w));

  // Messages, spend and distinct customers contacted, per arm.
  const spend = await db
    .select({
      arm: armAssignments.arm,
      messagesSent: raw<number>`count(${messages.id})::int`,
      costPaise: raw<number>`coalesce(sum(${recoveryAttempts.costPaise}), 0)::int`,
      customers: raw<number>`count(distinct ${paymentEvents.customerId})::int`,
    })
    .from(recoveryAttempts)
    .innerJoin(paymentEvents, eq(paymentEvents.id, recoveryAttempts.eventId))
    .innerJoin(armAssignments, eq(armAssignments.eventId, recoveryAttempts.eventId))
    .leftJoin(messages, eq(messages.attemptId, recoveryAttempts.id))
    .where(windowClause(w))
    .groupBy(armAssignments.arm);

  const out = Object.fromEntries(
    ARMS.map((a) => [a, { events: [] as MetricEvent[], messagesSent: 0, costPaise: 0, customersContacted: 0 }]),
  ) as ArmsInput;

  for (const r of rows) {
    out[r.arm].events.push({
      amountPaise: r.amountPaise,
      /**
       * `recovered_at` is the fact; `state` is a label four different jobs
       * write. When a recovery lands while triage is still in flight, the
       * later job's state write used to erase the label while leaving the
       * money — so the arm read zero recoveries and the headline number read
       * zero rupees. `setEventState` now refuses to leave a terminal state,
       * but the metrics read the timestamp regardless: the number that decides
       * whether this project worked should not depend on a label winning a
       * race. FAILURES.md #19.
       */
      recovered: r.recoveredAt !== null,
      recoveredPaise: r.recoveredPaise ?? 0,
    });
  }
  for (const s of spend) {
    out[s.arm].messagesSent = s.messagesSent;
    out[s.arm].costPaise = s.costPaise;
    out[s.arm].customersContacted = s.customers;
  }

  return out;
}

/** Spend split by channel, for the cost breakdown panel. */
export async function loadCostBreakdown(w: MetricsWindow = {}): Promise<Record<string, number>> {
  const rows = await db
    .select({
      channel: messages.channel,
      costPaise: raw<number>`coalesce(sum(${messages.costPaise}), 0)::int`,
    })
    .from(messages)
    .innerJoin(recoveryAttempts, eq(recoveryAttempts.id, messages.attemptId))
    .innerJoin(paymentEvents, eq(paymentEvents.id, recoveryAttempts.eventId))
    .where(windowClause(w))
    .groupBy(messages.channel);

  const breakdown: Record<string, number> = { whatsapp: 0, email: 0, sms: 0, voice: 0, llm: 0 };
  for (const r of rows) breakdown[r.channel] = (breakdown[r.channel] ?? 0) + r.costPaise;
  return breakdown;
}

export interface SummaryOptions {
  bootstrapSeed?: number;
  bootstrapIterations?: number;
}

export async function metricsSummary(
  w: MetricsWindow = {},
  opts: SummaryOptions = {},
): Promise<MetricsSummary & { unpriced_cost_items: string[] }> {
  const [arms, costBreakdown, live] = await Promise.all([
    loadArms(w),
    loadCostBreakdown(w),
    getLivePolicy(),
  ]);

  const summary = computeMetrics(arms, {
    bootstrapSeed: opts.bootstrapSeed,
    bootstrapIterations: opts.bootstrapIterations,
    weeklyContactCap: live?.policy.caps.max_contacts_per_customer_per_week ?? 2,
    costBreakdownPaise: costBreakdown,
  });

  return {
    ...summary,
    // Surfaced, not buried: every cost figure above is only as good as its
    // rate table, and these entries are still placeholders.
    unpriced_cost_items: (Object.keys(RATES) as Array<keyof typeof RATES>).filter((k) =>
      RATES[k].source.includes('PLACEHOLDER'),
    ),
  };
}

export interface TimeseriesPoint {
  bucket: string;
  arm: Arm;
  n: number;
  recovered: number;
  gross_paise: number;
  cumulative_gross_paise: number;
}

/** Cumulative recovered rupees per arm, for the Incrementality Lab chart. */
export async function metricsTimeseries(
  bucketMinutes: number,
  w: MetricsWindow = {},
): Promise<TimeseriesPoint[]> {
  const rows = await db
    .select({
      /**
       * `OF` emits a bare `+00` when the offset has no minutes, and
       * `2026-09-03T10:00:00+00` is not valid ISO-8601 — `new Date()` returns
       * Invalid Date on it, so the chart's axis silently rendered em-dashes.
       * Pinning the bucket to UTC and writing a literal `Z` is unambiguous
       * whatever the server's TimeZone happens to be set to.
       */
      bucket: raw<string>`to_char(date_bin(${`${bucketMinutes} minutes`}::interval, ${paymentEvents.failedAt}, timestamptz '2020-01-01') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
      arm: armAssignments.arm,
      n: raw<number>`count(*)::int`,
      recovered: raw<number>`count(*) filter (where ${paymentEvents.recoveredAt} is not null)::int`,
      grossPaise: raw<number>`coalesce(sum(${paymentEvents.recoveredPaise}) filter (where ${paymentEvents.recoveredAt} is not null), 0)::bigint`,
    })
    .from(paymentEvents)
    .innerJoin(armAssignments, eq(armAssignments.eventId, paymentEvents.id))
    .where(windowClause(w))
    .groupBy(raw`1`, armAssignments.arm)
    .orderBy(raw`1`);

  const running: Record<string, number> = { control: 0, naive: 0, leakproof: 0 };
  return rows.map((r) => {
    const gross = Number(r.grossPaise);
    running[r.arm] += gross;
    return {
      bucket: r.bucket,
      arm: r.arm,
      n: r.n,
      recovered: r.recovered,
      gross_paise: gross,
      cumulative_gross_paise: running[r.arm],
    };
  });
}
