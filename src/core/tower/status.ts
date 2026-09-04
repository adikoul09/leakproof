/**
 * Tower status: the circuit breaker, and any outage currently being ridden out.
 *
 * Reads `outage_windows`, which `outage.detect` maintains. It used to derive
 * the banner from classifications on every request, because that table was
 * empty; now the detector owns it, and two implementations of "what counts as
 * an outage" would drift the moment one was tuned.
 *
 * Windows are reported open or closed rather than only open. A batch replays a
 * whole day in minutes, so by the time anyone looks the incident has ended —
 * and a control tower that shows nothing because the outage finished four
 * minutes ago is not much of a control tower.
 */
import { desc, eq, gte, isNull, or, sql as raw } from 'drizzle-orm';
import { db } from '@/db/client';
import { breakerState, classifications, outageWindows, paymentEvents } from '@/db/schema';
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
  /** Why the feed said what it said, in words. Null when it had no opinion. */
  downtime_api_why: string | null;
  /** False once the cohort has recovered — still worth showing, greyed. */
  open: boolean;
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

  // Windows that overlap the status window: still open, or ended inside it.
  const rows = await db
    .select()
    .from(outageWindows)
    .where(or(isNull(outageWindows.endedAt), gte(outageWindows.endedAt, since)))
    .orderBy(desc(outageWindows.startedAt))
    .limit(20);

  return {
    breaker: breakers.map((b) => ({
      scope: b.scope,
      state: b.state,
      reason: b.overrideReason ?? b.triggerSource,
      opened_at: b.openedAt?.toISOString() ?? null,
    })),
    breaker_open: breakers.length > 0,
    outages: rows.map((r) => ({
      cohort: r.cohortKey,
      issuer: r.issuer,
      method: r.method,
      events: r.eventsAffected ?? 0,
      decline_rate: Number(r.peakDeclineRate ?? 0),
      paise_parked: r.paiseParked ?? 0,
      first_seen: r.startedAt.toISOString(),
      last_seen: (r.endedAt ?? r.startedAt).toISOString(),
      peak_confidence: 0,
      downtime_api_agrees: r.downtimeApiAgrees,
      downtime_api_why: r.downtimeApiWhy,
      open: r.endedAt === null,
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
