/**
 * Rolling cohort counters + EWMA baseline.
 *
 * The blueprint keeps these in a Redis sorted set. Upstash is not provisioned,
 * so this is the Postgres implementation behind the same interface — swapping
 * in Redis later is a one-file change and no caller moves.
 */
import { and, eq, gte, sql as raw } from 'drizzle-orm';
import { db } from '@/db/client';
import { cohortBaselines, cohortCounters } from '@/db/schema';
import { TRIAGE, bucketStart } from './config';

export interface CohortWindow {
  /** Payments observed in the cohort over the rolling window. */
  nTotal: number;
  nFailed: number;
  /** nFailed / nTotal, or 0 when nTotal is 0. */
  declineRate: number;
  windowMinutes: number;
}

export interface CohortBaseline {
  /** EWMA of the cohort's decline rate. */
  mean: number;
  /** EWMA of the variance; sqrt gives σ for the 3σ test. */
  variance: number;
  samples: number;
  /** True when this is the seed prior rather than observed history. */
  seeded: boolean;
}

export interface CohortStore {
  observe(cohortDim: string, at: Date, failed: boolean): Promise<void>;
  window(cohortDim: string, at: Date): Promise<CohortWindow>;
  baseline(cohortDim: string): Promise<CohortBaseline>;
  updateBaseline(cohortDim: string, observedRate: number): Promise<void>;
}

export const postgresCohortStore: CohortStore = {
  async observe(cohortDim, at, failed) {
    const bucket = bucketStart(at);
    await db
      .insert(cohortCounters)
      .values({ cohortDim, bucketStart: bucket, nTotal: 1, nFailed: failed ? 1 : 0 })
      .onConflictDoUpdate({
        target: [cohortCounters.cohortDim, cohortCounters.bucketStart],
        set: {
          nTotal: raw`${cohortCounters.nTotal} + 1`,
          nFailed: raw`${cohortCounters.nFailed} + ${failed ? 1 : 0}`,
          updatedAt: new Date(),
        },
      });
  },

  async window(cohortDim, at) {
    // The rolling window is [at - windowMinutes, at], snapped to bucket edges.
    const from = new Date(bucketStart(at).getTime() - (TRIAGE.windowMinutes - TRIAGE.bucketMinutes) * 60_000);
    const rows = await db
      .select({
        nTotal: raw<number>`coalesce(sum(${cohortCounters.nTotal}), 0)::int`,
        nFailed: raw<number>`coalesce(sum(${cohortCounters.nFailed}), 0)::int`,
      })
      .from(cohortCounters)
      .where(and(eq(cohortCounters.cohortDim, cohortDim), gte(cohortCounters.bucketStart, from)));

    const nTotal = rows[0]?.nTotal ?? 0;
    const nFailed = rows[0]?.nFailed ?? 0;
    return {
      nTotal,
      nFailed,
      declineRate: nTotal === 0 ? 0 : nFailed / nTotal,
      windowMinutes: TRIAGE.windowMinutes,
    };
  },

  async baseline(cohortDim) {
    const [row] = await db
      .select()
      .from(cohortBaselines)
      .where(eq(cohortBaselines.cohortDim, cohortDim))
      .limit(1);

    if (!row) {
      return {
        mean: TRIAGE.seedBaselineRate,
        variance: TRIAGE.seedBaselineVar,
        samples: 0,
        seeded: true,
      };
    }
    return {
      mean: Number(row.ewmaRate),
      variance: Number(row.ewmaVar),
      samples: row.samples,
      seeded: false,
    };
  },

  async updateBaseline(cohortDim, observedRate) {
    const prior = await postgresCohortStore.baseline(cohortDim);
    const a = TRIAGE.ewmaAlpha;
    const mean = a * observedRate + (1 - a) * prior.mean;
    // West's incremental EWMA variance: track the squared deviation from the
    // *previous* mean, so a live spike does not immediately widen its own σ.
    const dev = observedRate - prior.mean;
    const variance = Math.max(1e-6, a * dev * dev + (1 - a) * prior.variance);

    await db
      .insert(cohortBaselines)
      .values({
        cohortDim,
        ewmaRate: mean.toFixed(5),
        ewmaVar: variance.toFixed(7),
        samples: prior.samples + 1,
      })
      .onConflictDoUpdate({
        target: cohortBaselines.cohortDim,
        set: {
          ewmaRate: mean.toFixed(5),
          ewmaVar: variance.toFixed(7),
          samples: prior.samples + 1,
          updatedAt: new Date(),
        },
      });
  },
};
