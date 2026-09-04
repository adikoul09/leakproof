/**
 * Tower status: the circuit breaker, and any outage currently being ridden out.
 *
 * The blueprint sources the outage banner from `outage_windows`, which is
 * written by an `outage.detect` cron that is not in the first eight milestones.
 * Rather than ship a banner backed by an empty table, the live outage is
 * derived on read from the classifications themselves — the same signal the
 * detector would have persisted, computed rather than cached. When
 * `outage.detect` lands this becomes a read of its output and the shape here
 * does not change.
 */
import { and, desc, eq, gte, sql as raw } from 'drizzle-orm';
import { db } from '@/db/client';
import { breakerState, classifications, paymentEvents } from '@/db/schema';
import { TRIAGE } from '@/core/triage/config';

export interface LiveOutage {
  cohort: string;
  issuer: string | null;
  method: string | null;
  events: number;
  decline_rate: number;
  paise_parked: number;
  first_seen: string;
  last_seen: string;
  peak_confidence: number;
  downtime_api_agrees: boolean | null;
}

export interface TowerStatus {
  breaker: { scope: string; state: string; reason: string | null; opened_at: string | null }[];
  breaker_open: boolean;
  outages: LiveOutage[];
  window_minutes: number;
}

/**
 * Cohorts with systemic classifications inside the recent window.
 *
 * Scoped to the *event's* failed_at, not the classification timestamp: a batch
 * ingested now can carry an outage that happened hours ago, and keying off
 * classification time would show a stale incident as live.
 */
export async function loadStatus(windowMinutes = 60): Promise<TowerStatus> {
  const since = new Date(Date.now() - windowMinutes * 60_000);

  const breakers = await db
    .select()
    .from(breakerState)
    .where(eq(breakerState.state, 'open'))
    .orderBy(desc(breakerState.openedAt));

  const rows = await db
    .select({
      issuer: paymentEvents.issuer,
      method: paymentEvents.method,
      events: raw<number>`count(*)::int`,
      paise: raw<number>`coalesce(sum(${paymentEvents.amountPaise}), 0)::bigint`,
      declineRate: raw<number>`max(${classifications.cohortDeclineRate})::float8`,
      firstSeen: raw<string>`min(${paymentEvents.failedAt})`,
      lastSeen: raw<string>`max(${paymentEvents.failedAt})`,
      peakConfidence: raw<number>`max(${classifications.confidence})::float8`,
      // NULL means "no signal", which is a different fact from "disagreed".
      agrees: raw<boolean | null>`bool_or(${classifications.downtimeApiAgrees})`,
    })
    .from(classifications)
    .innerJoin(paymentEvents, eq(paymentEvents.id, classifications.eventId))
    .where(and(eq(classifications.kind, 'systemic'), gte(paymentEvents.failedAt, since)))
    .groupBy(paymentEvents.issuer, paymentEvents.method)
    .orderBy(raw`count(*) desc`);

  return {
    breaker: breakers.map((b) => ({
      scope: b.scope,
      state: b.state,
      reason: b.overrideReason ?? b.triggerSource,
      opened_at: b.openedAt?.toISOString() ?? null,
    })),
    breaker_open: breakers.length > 0,
    outages: rows.map((r) => ({
      cohort: `${r.issuer ?? 'unknown'}|${r.method ?? 'unknown'}`,
      issuer: r.issuer,
      method: r.method,
      events: r.events,
      decline_rate: r.declineRate ?? 0,
      paise_parked: Number(r.paise),
      first_seen: new Date(r.firstSeen).toISOString(),
      last_seen: new Date(r.lastSeen).toISOString(),
      peak_confidence: r.peakConfidence ?? 0,
      downtime_api_agrees: r.agrees,
    })),
    window_minutes: windowMinutes,
  };
}

/** Failure-class mix for the right rail's donut. */
export async function failureMix(windowMinutes = 60) {
  const since = new Date(Date.now() - windowMinutes * 60_000);
  const rows = await db
    .select({
      failureClass: classifications.failureClass,
      n: raw<number>`count(*)::int`,
      paise: raw<number>`coalesce(sum(${paymentEvents.amountPaise}), 0)::bigint`,
    })
    .from(classifications)
    .innerJoin(paymentEvents, eq(paymentEvents.id, classifications.eventId))
    .where(gte(paymentEvents.failedAt, since))
    .groupBy(classifications.failureClass)
    .orderBy(raw`count(*) desc`);
  return rows.map((r) => ({ failure_class: r.failureClass, n: r.n, paise: Number(r.paise) }));
}

export const TRIAGE_THRESHOLDS = {
  min_cohort_n: TRIAGE.minCohortN,
  sigma_multiplier: TRIAGE.sigmaMultiplier,
  absolute_floor: TRIAGE.absoluteFloor,
};
