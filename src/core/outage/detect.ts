/**
 * Outage window detection — blueprint 6.5 step 5, M3.
 *
 * Opens, extends and closes `outage_windows` rows from the classifications the
 * detector has already made, then cross-checks each window against Razorpay's
 * Payment Downtime API.
 *
 * ── The one rule that makes this worth anything ──────────────────────────
 *
 * **Agreement with the Downtime API is RECORDED, never consulted.**
 *
 * It would be trivial — and much more flattering — to feed the API into the
 * classifier, or to open windows only when Razorpay confirms them. Then
 * "we agree with Razorpay's downtime feed 94% of the time" would be a
 * statement about a copy, not a detector, and the agreement number would mean
 * exactly nothing. The classifier never sees this data. It runs on cohort
 * evidence alone, and the API is scored against it afterwards like a marker
 * against an exam already sat.
 *
 * `downtime_api_agrees` is deliberately three-valued. NULL means the API had no
 * signal for this cohort at all, which is a different fact from `false`,
 * meaning it had a signal and disagreed. Collapsing the two would turn silence
 * into contradiction and understate agreement.
 */
import { and, eq, gte, inArray, isNull, lte, sql as raw } from 'drizzle-orm';
import { db } from '@/db/client';
import { classifications, outageWindows, paymentEvents } from '@/db/schema';
import { type Downtime, listDowntimes } from '@/core/rails/razorpay';
import { type AgreementVerdict, checkDowntime, issuerCodes, matchDowntime } from './downtime';
import { TRIAGE } from '@/core/triage/config';

// Re-exported so existing callers keep working after the pure split.
export { checkDowntime, issuerCodes, matchDowntime };
export type { AgreementVerdict };

/**
 * A cohort is considered still degraded while systemic classifications keep
 * arriving. Two consecutive quiet windows close it — one is too twitchy on a
 * cohort whose traffic is thin at 04:00.
 */
export const QUIET_WINDOWS_TO_CLOSE = 2;

export interface DetectOptions {
  /** Evaluation instant. Passed in so the job is testable and replayable. */
  now: Date;
  /** How far back to look for systemic activity. */
  lookbackMinutes?: number;
  /** Skip the Razorpay call — used when the API is down or in tests. */
  skipDowntimeApi?: boolean;
}

export interface DetectResult {
  opened: number;
  extended: number;
  closed: number;
  downtimeRows: number;
  agreementSet: number;
  windows: Array<{
    cohortKey: string;
    issuer: string | null;
    method: string | null;
    events: number;
    peakDeclineRate: number;
    paiseParked: number;
    agrees: boolean | null;
    detectionLeadS: number | null;
  }>;
  /**
   * Why the agreement column may be uninformative. Surfaced rather than left
   * for someone to infer from a wall of NULLs.
   */
  notes: string[];
}

/** Cohort activity over the lookback, from classifications the detector made. */
interface CohortActivity {
  issuer: string | null;
  method: string | null;
  cohortKey: string;
  systemic: number;
  events: number;
  peakDeclineRate: number;
  paiseParked: number;
  firstSeen: Date;
  lastSeen: Date;
}

async function systemicActivity(now: Date, lookbackMinutes: number): Promise<CohortActivity[]> {
  const since = new Date(now.getTime() - lookbackMinutes * 60_000);
  const rows = await db
    .select({
      issuer: paymentEvents.issuer,
      method: paymentEvents.method,
      systemic: raw<number>`count(*)::int`,
      peak: raw<number>`coalesce(max(${classifications.cohortDeclineRate}), 0)::float8`,
      paise: raw<number>`coalesce(sum(${paymentEvents.amountPaise}), 0)::bigint`,
      firstSeen: raw<string>`min(${paymentEvents.failedAt})`,
      lastSeen: raw<string>`max(${paymentEvents.failedAt})`,
    })
    .from(classifications)
    .innerJoin(paymentEvents, eq(paymentEvents.id, classifications.eventId))
    .where(and(eq(classifications.kind, 'systemic'), gte(paymentEvents.failedAt, since)))
    .groupBy(paymentEvents.issuer, paymentEvents.method);

  return rows.map((r) => ({
    issuer: r.issuer,
    method: r.method,
    cohortKey: `${r.issuer ?? 'unknown'}|${r.method ?? 'unknown'}`,
    systemic: r.systemic,
    events: r.systemic,
    peakDeclineRate: r.peak,
    paiseParked: Number(r.paise),
    firstSeen: new Date(r.firstSeen),
    lastSeen: new Date(r.lastSeen),
  }));
}

export async function detectOutages(opts: DetectOptions): Promise<DetectResult> {
  const now = opts.now;
  const lookbackMinutes = opts.lookbackMinutes ?? TRIAGE.windowMinutes * QUIET_WINDOWS_TO_CLOSE;
  const notes: string[] = [];

  const activity = await systemicActivity(now, lookbackMinutes);
  const active = new Map(activity.map((a) => [a.cohortKey, a]));

  const open = await db
    .select()
    .from(outageWindows)
    .where(isNull(outageWindows.endedAt));

  let opened = 0;
  let extended = 0;
  let closed = 0;

  // ── close windows whose cohort has gone quiet ──
  for (const w of open) {
    if (active.has(w.cohortKey)) continue;
    await db
      .update(outageWindows)
      .set({ endedAt: now })
      .where(eq(outageWindows.id, w.id));
    closed += 1;
  }

  // ── open or extend ──
  const openByKey = new Map(open.filter((w) => active.has(w.cohortKey)).map((w) => [w.cohortKey, w]));

  for (const a of activity) {
    const existing = openByKey.get(a.cohortKey);
    if (existing) {
      await db
        .update(outageWindows)
        .set({
          eventsAffected: (existing.eventsAffected ?? 0) + a.events,
          paiseParked: (existing.paiseParked ?? 0) + a.paiseParked,
          peakDeclineRate: Math.max(
            Number(existing.peakDeclineRate ?? 0),
            a.peakDeclineRate,
          ).toFixed(4),
        })
        .where(eq(outageWindows.id, existing.id));
      extended += 1;
    } else {
      await db.insert(outageWindows).values({
        cohortKey: a.cohortKey,
        issuer: a.issuer,
        method: a.method,
        startedAt: a.firstSeen,
        peakDeclineRate: a.peakDeclineRate.toFixed(4),
        eventsAffected: a.events,
        paiseParked: a.paiseParked,
        // Set to 'classifier' on open. The cross-check below promotes it to
        // 'both' if Razorpay independently saw the same thing.
        detectedBy: 'classifier',
      });
      opened += 1;
    }
  }

  // ── cross-check, recorded and never fed back ──
  let downtimes: Downtime[] = [];
  let agreementSet = 0;

  if (!opts.skipDowntimeApi) {
    try {
      downtimes = await listDowntimes();
    } catch (err) {
      notes.push(`Payment Downtime API unavailable: ${(err as Error).message}. Agreement left NULL.`);
    }
  } else {
    notes.push('Downtime API skipped by request. Agreement left NULL.');
  }

  if (downtimes.length > 0) {
    const unresolved = downtimes.filter((d) => d.end === null).length;
    if (unresolved === downtimes.length && downtimes.length > 5) {
      // FAILURES.md #6: on test-mode keys every row comes back simultaneous,
      // unresolved and high-severity, which is not a plausible production
      // state. Say so on the record rather than letting a scorecard imply
      // Razorpay confirmed anything.
      notes.push(
        `All ${downtimes.length} downtime rows are unresolved and simultaneous — the hallmark of test-mode fixtures rather than live data. Agreement recorded, but do not present it as corroboration.`,
      );
    }
  }

  const current = await db.select().from(outageWindows).where(isNull(outageWindows.endedAt));
  const windows: DetectResult['windows'] = [];

  for (const w of current) {
    const verdict = checkDowntime(downtimes, w.issuer, w.method);
    const { agrees, match } = verdict;
    const apiStart = match ? new Date(match.begin * 1000) : null;
    const apiEnd = match?.end ? new Date(match.end * 1000) : null;
    // Negative means Razorpay saw it before we did.
    const leadS = apiStart ? Math.round((apiStart.getTime() - w.startedAt.getTime()) / 1000) : null;

    await db
      .update(outageWindows)
      .set({
        detectedBy: agrees ? 'both' : 'classifier',
        downtimeApiAgrees: agrees,
        downtimeApiWhy: verdict.why,
        downtimeApiStart: apiStart,
        downtimeApiEnd: apiEnd,
        detectionLeadS: leadS,
      })
      .where(eq(outageWindows.id, w.id));

    // Backfill the per-classification agreement column, for the events in this
    // window that have no verdict yet. Only systemic ones: agreement is a
    // statement about an outage call, not about every failure in the cohort.
    if (agrees !== null) {
      const ids = await db
        .select({ id: paymentEvents.id })
        .from(paymentEvents)
        .innerJoin(classifications, eq(classifications.eventId, paymentEvents.id))
        .where(
          and(
            eq(classifications.kind, 'systemic'),
            eq(paymentEvents.issuer, w.issuer ?? ''),
            eq(paymentEvents.method, w.method ?? ''),
            gte(paymentEvents.failedAt, w.startedAt),
            lte(paymentEvents.failedAt, now),
          ),
        );
      if (ids.length > 0) {
        for (let i = 0; i < ids.length; i += 500) {
          await db
            .update(classifications)
            .set({ downtimeApiAgrees: agrees, outageWindowId: w.id })
            .where(inArray(classifications.eventId, ids.slice(i, i + 500).map((r) => r.id)));
        }
        agreementSet += ids.length;
      }
    }

    windows.push({
      cohortKey: w.cohortKey,
      issuer: w.issuer,
      method: w.method,
      events: w.eventsAffected ?? 0,
      peakDeclineRate: Number(w.peakDeclineRate ?? 0),
      paiseParked: w.paiseParked ?? 0,
      agrees,
      detectionLeadS: leadS,
    });
  }

  return { opened, extended, closed, downtimeRows: downtimes.length, agreementSet, windows, notes };
}

/** Agreement scorecard for the Outage Radar — blueprint Screen 4. */
export async function agreementScorecard() {
  const rows = await db.select().from(outageWindows);
  const withSignal = rows.filter((r) => r.downtimeApiAgrees === true);
  const classifierOnly = rows.filter((r) => r.detectedBy === 'classifier');
  const leads = rows.map((r) => r.detectionLeadS).filter((x): x is number => x !== null);
  // Windows the feed actually had an opinion on — it either flagged the cohort
  // or covered the method and did not. Windows where it carried nothing for the
  // method are excluded from the denominator entirely.
  const opinionated = rows.filter((r) => r.downtimeApiAgrees !== null);

  return {
    windows: rows.length,
    both: withSignal.length,
    classifier_only: classifierOnly.length,
    /**
     * Denominator is windows the feed had an opinion on, not all windows.
     * Counting "no signal" as disagreement would make this a measure of the
     * feed's coverage rather than of the detector.
     */
    windows_feed_had_an_opinion_on: opinionated.length,
    agreement_rate: opinionated.length === 0 ? null : withSignal.length / opinionated.length,
    median_detection_lead_s:
      leads.length === 0 ? null : leads.sort((a, b) => a - b)[Math.floor(leads.length / 2)],
    note: 'Agreement is recorded, never fed into the classifier. Feeding it in would make validating the classifier against it circular.',
  };
}

// ── Backfill ─────────────────────────────────────────────────────────

export interface BackfillOptions {
  /** Only reconstruct windows for events in this range. */
  from?: Date;
  to?: Date;
  /**
   * Systemic events more than this far apart start a new window. One rolling
   * window is the natural gap: if the cohort went quiet for longer than the
   * detector's own memory, whatever comes next is a separate incident.
   */
  gapMinutes?: number;
  batchId?: string;
  skipDowntimeApi?: boolean;
}

/**
 * Reconstruct historical outage windows from systemic classifications.
 *
 * The live path only looks back far enough to open and close windows as events
 * arrive, which is right for a stream and useless for a corpus that was
 * backfilled — a generated batch replays a whole day in eight minutes, and by
 * the time anyone looks the incident is hours in the past.
 *
 * This groups a cohort's systemic events into runs separated by more than
 * `gapMinutes` and writes one window per run. Same data, same rule, applied to
 * history instead of to the last five minutes.
 */
export async function backfillOutages(opts: BackfillOptions = {}): Promise<DetectResult> {
  const gapMs = (opts.gapMinutes ?? TRIAGE.windowMinutes) * 60_000;
  const notes: string[] = [];

  const rows = await db
    .select({
      issuer: paymentEvents.issuer,
      method: paymentEvents.method,
      failedAt: paymentEvents.failedAt,
      amountPaise: paymentEvents.amountPaise,
      declineRate: classifications.cohortDeclineRate,
    })
    .from(classifications)
    .innerJoin(paymentEvents, eq(paymentEvents.id, classifications.eventId))
    .where(
      and(
        ...[
          eq(classifications.kind, 'systemic'),
          opts.from ? gte(paymentEvents.failedAt, opts.from) : undefined,
          opts.to ? lte(paymentEvents.failedAt, opts.to) : undefined,
          opts.batchId ? eq(paymentEvents.batchId, opts.batchId) : undefined,
        ].filter(Boolean),
      ),
    )
    .orderBy(paymentEvents.failedAt);

  if (rows.length === 0) {
    return {
      opened: 0,
      extended: 0,
      closed: 0,
      downtimeRows: 0,
      agreementSet: 0,
      windows: [],
      notes: ['No systemic classifications in range — nothing to reconstruct.'],
    };
  }

  // Group by cohort, then split each cohort's timeline on gaps.
  const byCohort = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.issuer ?? 'unknown'}|${r.method ?? 'unknown'}`;
    const list = byCohort.get(key) ?? [];
    list.push(r);
    byCohort.set(key, list);
  }

  let opened = 0;
  for (const [cohortKey, events] of byCohort) {
    let run: typeof events = [];
    const flush = async () => {
      if (run.length === 0) return;
      const first = run[0];
      const last = run[run.length - 1];
      await db.insert(outageWindows).values({
        cohortKey,
        issuer: first.issuer,
        method: first.method,
        startedAt: first.failedAt,
        // A reconstructed window is closed by definition — it is history.
        endedAt: last.failedAt,
        peakDeclineRate: Math.max(...run.map((r) => Number(r.declineRate ?? 0))).toFixed(4),
        eventsAffected: run.length,
        paiseParked: run.reduce((a, r) => a + r.amountPaise, 0),
        detectedBy: 'classifier',
      });
      opened += 1;
      run = [];
    };

    for (const e of events) {
      if (run.length > 0 && e.failedAt.getTime() - run[run.length - 1].failedAt.getTime() > gapMs) {
        await flush();
      }
      run.push(e);
    }
    await flush();
  }

  notes.push(
    `Reconstructed ${opened} window(s) from ${rows.length} systemic classifications, splitting on gaps over ${opts.gapMinutes ?? TRIAGE.windowMinutes} minutes.`,
  );

  // Cross-check the reconstructed windows the same way the live path does.
  let downtimes: Downtime[] = [];
  if (!opts.skipDowntimeApi) {
    try {
      downtimes = await listDowntimes();
    } catch (err) {
      notes.push(`Payment Downtime API unavailable: ${(err as Error).message}. Agreement left NULL.`);
    }
  }
  if (downtimes.length > 0 && downtimes.every((d) => d.end === null) && downtimes.length > 5) {
    notes.push(
      `All ${downtimes.length} downtime rows are unresolved and simultaneous — test-mode fixtures, not live data. Recorded, but not corroboration.`,
    );
  }

  const written = await db
    .select()
    .from(outageWindows)
    .orderBy(outageWindows.startedAt);
  const windows: DetectResult['windows'] = [];
  let agreementSet = 0;

  for (const w of written) {
    const verdict = checkDowntime(downtimes, w.issuer, w.method);
    const { agrees, match } = verdict;
    const apiStart = match ? new Date(match.begin * 1000) : null;
    const leadS = apiStart ? Math.round((apiStart.getTime() - w.startedAt.getTime()) / 1000) : null;

    await db
      .update(outageWindows)
      .set({
        detectedBy: agrees ? 'both' : 'classifier',
        downtimeApiAgrees: agrees,
        downtimeApiWhy: verdict.why,
        downtimeApiStart: apiStart,
        downtimeApiEnd: match?.end ? new Date(match.end * 1000) : null,
        detectionLeadS: leadS,
      })
      .where(eq(outageWindows.id, w.id));

    if (agrees !== null && w.issuer && w.method) {
      const ids = await db
        .select({ id: paymentEvents.id })
        .from(paymentEvents)
        .innerJoin(classifications, eq(classifications.eventId, paymentEvents.id))
        .where(
          and(
            eq(classifications.kind, 'systemic'),
            eq(paymentEvents.issuer, w.issuer),
            eq(paymentEvents.method, w.method),
            gte(paymentEvents.failedAt, w.startedAt),
            lte(paymentEvents.failedAt, w.endedAt ?? new Date()),
          ),
        );
      for (let i = 0; i < ids.length; i += 500) {
        await db
          .update(classifications)
          .set({ downtimeApiAgrees: agrees, outageWindowId: w.id })
          .where(inArray(classifications.eventId, ids.slice(i, i + 500).map((r) => r.id)));
      }
      agreementSet += ids.length;
    }

    windows.push({
      cohortKey: w.cohortKey,
      issuer: w.issuer,
      method: w.method,
      events: w.eventsAffected ?? 0,
      peakDeclineRate: Number(w.peakDeclineRate ?? 0),
      paiseParked: w.paiseParked ?? 0,
      agrees,
      detectionLeadS: leadS,
    });
  }

  return {
    opened,
    extended: 0,
    closed: opened,
    downtimeRows: downtimes.length,
    agreementSet,
    windows,
    notes,
  };
}
