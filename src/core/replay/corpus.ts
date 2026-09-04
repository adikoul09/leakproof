/**
 * Loading a historical corpus for replay.
 *
 * Two things come out of here and both are needed: the events themselves, and
 * the cohort counter buckets covering their time span. `payment_events` holds
 * only failures — the successes that form the decline rate's *denominator*
 * survive solely as aggregates in `cohort_counters`, so a replay that skipped
 * them would classify against a corpus where every cohort declined 100% of the
 * time, and every classification would differ from the live one for a reason
 * having nothing to do with the what-if being tested.
 */
import { and, count, desc, eq, gte, inArray, isNotNull, lte, sql as raw } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  armAssignments,
  classifications,
  cohortCounters,
  customers,
  messages,
  paymentEvents,
  policyEvaluations,
  recoveryAttempts,
} from '@/db/schema';
import { cohortDim } from '@/core/triage/classifier';
import type { Arm } from '@/core/experiment/assign';
import type { CohortBucketSeed, ReplayEvent } from './engine';

export type CorpusName = 'recent' | 'outage_window' | 'adversarial' | 'batch';

export interface CorpusQuery {
  corpus: CorpusName;
  limit?: number;
  batchId?: string;
}

export interface LoadedCorpus {
  events: ReplayEvent[];
  seeds: CohortBucketSeed[];
  description: string;
  from: Date | null;
  to: Date | null;
}

const MAX_CORPUS = 20_000;

export async function loadCorpus(q: CorpusQuery): Promise<LoadedCorpus> {
  const limit = Math.min(MAX_CORPUS, Math.max(1, q.limit ?? 3000));

  const scope = [
    q.batchId ? eq(paymentEvents.batchId, q.batchId) : undefined,
    // The outage corpus is the events the detector actually called systemic.
    // Not "events inside a time window" — the interesting subset is the one the
    // system acted on, because that is what a different threshold would move.
    q.corpus === 'outage_window' ? eq(classifications.kind, 'systemic') : undefined,
    // The adversarial subset: everything the taxonomy could not label. These are
    // the events where a policy or threshold change bites hardest.
    q.corpus === 'adversarial' ? eq(classifications.failureClass, 'unknown') : undefined,
  ].filter(Boolean);

  const rows = await db
    .select({
      id: paymentEvents.id,
      amountPaise: paymentEvents.amountPaise,
      method: paymentEvents.method,
      issuer: paymentEvents.issuer,
      failedAt: paymentEvents.failedAt,
      customerId: paymentEvents.customerId,
      optedOutAt: customers.optedOutAt,
      errCode: paymentEvents.errCode,
      errDescription: paymentEvents.errDescription,
      errSource: paymentEvents.errSource,
      errStep: paymentEvents.errStep,
      errReason: paymentEvents.errReason,
      state: paymentEvents.state,
      recoveredAt: paymentEvents.recoveredAt,
      recoveredPaise: paymentEvents.recoveredPaise,
      kind: classifications.kind,
      failureClass: classifications.failureClass,
      arm: armAssignments.arm,
    })
    .from(paymentEvents)
    .leftJoin(classifications, eq(classifications.eventId, paymentEvents.id))
    .leftJoin(armAssignments, eq(armAssignments.eventId, paymentEvents.id))
    .leftJoin(customers, eq(customers.id, paymentEvents.customerId))
    .where(scope.length ? and(...scope) : undefined)
    .orderBy(desc(paymentEvents.failedAt))
    .limit(limit);

  if (rows.length === 0) {
    return { events: [], seeds: [], description: 'empty corpus', from: null, to: null };
  }

  const ids = rows.map((r) => r.id);

  // What actually happened, per event: the last gate verdict, the last rail,
  // and how much was spent. Three grouped queries rather than one per event.
  const gates = await db
    .select({
      eventId: policyEvaluations.eventId,
      gateResult: raw<string>`(array_agg(${policyEvaluations.gateResult} order by ${policyEvaluations.evaluatedAt} desc))[1]`,
    })
    .from(policyEvaluations)
    .where(inArray(policyEvaluations.eventId, ids))
    .groupBy(policyEvaluations.eventId);
  const gateBy = new Map(gates.map((g) => [g.eventId, g.gateResult]));

  const attempts = await db
    .select({
      eventId: recoveryAttempts.eventId,
      rail: raw<string>`(array_agg(${recoveryAttempts.rail} order by ${recoveryAttempts.attemptNo} desc))[1]`,
      costPaise: raw<number>`coalesce(sum(${recoveryAttempts.costPaise}), 0)::int`,
    })
    .from(recoveryAttempts)
    .where(inArray(recoveryAttempts.eventId, ids))
    .groupBy(recoveryAttempts.eventId);
  const attemptBy = new Map(attempts.map((a) => [a.eventId, a]));

  const msgs = await db
    .select({
      eventId: recoveryAttempts.eventId,
      n: count(messages.id),
      costPaise: raw<number>`coalesce(sum(${messages.costPaise}), 0)::int`,
    })
    .from(messages)
    .innerJoin(recoveryAttempts, eq(recoveryAttempts.id, messages.attemptId))
    .where(inArray(recoveryAttempts.eventId, ids))
    .groupBy(recoveryAttempts.eventId);
  const msgBy = new Map(msgs.map((m) => [m.eventId, m]));

  const events: ReplayEvent[] = rows.map((r) => {
    const a = attemptBy.get(r.id);
    const m = msgBy.get(r.id);
    return {
      id: r.id,
      amountPaise: r.amountPaise,
      method: r.method,
      issuer: r.issuer,
      failedAt: r.failedAt,
      customerId: r.customerId,
      customerOptedOut: r.optedOutAt !== null,
      error: {
        code: r.errCode,
        description: r.errDescription,
        source: r.errSource,
        step: r.errStep,
        reason: r.errReason,
      },
      actual: {
        kind: r.kind,
        failureClass: r.failureClass,
        arm: (r.arm as Arm | null) ?? null,
        gateResult: gateBy.get(r.id) ?? null,
        rail: a?.rail ?? null,
        state: r.state,
        // The timestamp, not the state label — see FAILURES.md #19.
        recovered: r.recoveredAt !== null,
        recoveredPaise: r.recoveredPaise,
        messagesSent: m?.n ?? 0,
        costPaise: (a?.costPaise ?? 0) + (m?.costPaise ?? 0),
      },
    };
  });

  const times = events.map((e) => e.failedAt.getTime());
  const from = new Date(Math.min(...times));
  const to = new Date(Math.max(...times));

  // The counter buckets covering the corpus, plus a window's lead-in so the
  // first events are classified against the same history the live system saw
  // rather than an empty store.
  const LEAD_IN_MS = 60 * 60_000;
  const dims = new Set(
    events.map((e) => cohortDim({ issuer: e.issuer, method: e.method, amountPaise: e.amountPaise })),
  );
  const counterRows = await db
    .select()
    .from(cohortCounters)
    .where(
      and(
        gte(cohortCounters.bucketStart, new Date(from.getTime() - LEAD_IN_MS)),
        lte(cohortCounters.bucketStart, to),
        inArray(cohortCounters.cohortDim, [...dims]),
      ),
    );

  return {
    events,
    seeds: counterRows.map((c) => ({
      cohortDim: c.cohortDim,
      bucketStartMs: c.bucketStart.getTime(),
      nTotal: c.nTotal,
      nFailed: c.nFailed,
    })),
    description: describeCorpus(q.corpus, events.length),
    from,
    to,
  };
}

function describeCorpus(corpus: CorpusName, n: number): string {
  switch (corpus) {
    case 'outage_window':
      return `${n} events the detector called systemic`;
    case 'adversarial':
      return `${n} events the taxonomy could not label`;
    case 'batch':
      return `${n} events from one generated batch`;
    default:
      return `the last ${n} at-risk events`;
  }
}

/** Corpora that currently have events, for the config card's selector. */
export async function corpusSizes(): Promise<Record<CorpusName, number>> {
  const [all] = await db.select({ n: count() }).from(paymentEvents);
  const [systemic] = await db
    .select({ n: count() })
    .from(classifications)
    .where(eq(classifications.kind, 'systemic'));
  const [unknown] = await db
    .select({ n: count() })
    .from(classifications)
    .where(eq(classifications.failureClass, 'unknown'));
  const [batched] = await db
    .select({ n: count() })
    .from(paymentEvents)
    .where(isNotNull(paymentEvents.batchId));

  return {
    recent: all?.n ?? 0,
    outage_window: systemic?.n ?? 0,
    adversarial: unknown?.n ?? 0,
    batch: batched?.n ?? 0,
  };
}
