/**
 * In-memory CohortStore.
 *
 * Same interface as `postgresCohortStore`, no database. Two callers need it:
 *
 *  - `scripts/tune-triage.ts`, which sweeps thousands of threshold combinations
 *    over a synthetic corpus. Doing that against Postgres would take hours and
 *    would tune the detector against whatever happened to be in the table.
 *  - the replay engine (milestone 8), which must reconstruct the cohort state
 *    as it stood at a historical moment without touching live counters.
 *
 * Because it is the same interface, the classifier being tuned is the exact
 * classifier that runs in production. A tuning harness that re-implements the
 * thing it is tuning measures nothing.
 */
import { TRIAGE, bucketStart } from './config';
import type { CohortBaseline, CohortStore, CohortWindow } from './cohort-store';

interface Bucket {
  nTotal: number;
  nFailed: number;
}

export interface MemoryCohortStoreOptions {
  /** Overrides for the tunable constants. Anything omitted keeps its TRIAGE value. */
  windowMinutes?: number;
  bucketMinutes?: number;
  ewmaAlpha?: number;
  seedBaselineRate?: number;
  seedBaselineVar?: number;
}

export class MemoryCohortStore implements CohortStore {
  private readonly buckets = new Map<string, Map<number, Bucket>>();
  private readonly baselines = new Map<string, { mean: number; variance: number; samples: number }>();
  private readonly opts: Required<MemoryCohortStoreOptions>;

  constructor(options: MemoryCohortStoreOptions = {}) {
    this.opts = {
      windowMinutes: options.windowMinutes ?? TRIAGE.windowMinutes,
      bucketMinutes: options.bucketMinutes ?? TRIAGE.bucketMinutes,
      ewmaAlpha: options.ewmaAlpha ?? TRIAGE.ewmaAlpha,
      seedBaselineRate: options.seedBaselineRate ?? TRIAGE.seedBaselineRate,
      seedBaselineVar: options.seedBaselineVar ?? TRIAGE.seedBaselineVar,
    };
  }

  async observe(cohortDim: string, at: Date, failed: boolean): Promise<void> {
    this.observeSync(cohortDim, at, failed);
  }

  async window(cohortDim: string, at: Date): Promise<CohortWindow> {
    return this.windowSync(cohortDim, at);
  }

  async baseline(cohortDim: string): Promise<CohortBaseline> {
    return this.baselineSync(cohortDim);
  }

  async updateBaseline(cohortDim: string, observedRate: number): Promise<void> {
    this.updateBaselineSync(cohortDim, observedRate);
  }

  /**
   * The synchronous core. The async methods above exist only to satisfy the
   * CohortStore interface, which is shaped by the Postgres implementation.
   * The tuner classifies hundreds of thousands of events per sweep and there
   * is nothing to await, so it calls these directly.
   */
  observeSync(cohortDim: string, at: Date, failed: boolean): void {
    const key = bucketStart(at, this.opts.bucketMinutes).getTime();
    let dim = this.buckets.get(cohortDim);
    if (!dim) {
      dim = new Map();
      this.buckets.set(cohortDim, dim);
    }
    const b = dim.get(key) ?? { nTotal: 0, nFailed: 0 };
    b.nTotal += 1;
    if (failed) b.nFailed += 1;
    dim.set(key, b);
  }

  windowSync(cohortDim: string, at: Date): CohortWindow {
    // Mirrors the SQL exactly: buckets from (bucketStart(at) - (window - bucket))
    // forward. Any drift between the two implementations would tune the
    // detector against a window the production system never sees.
    const end = bucketStart(at, this.opts.bucketMinutes).getTime();
    const from = end - (this.opts.windowMinutes - this.opts.bucketMinutes) * 60_000;
    const dim = this.buckets.get(cohortDim);
    let nTotal = 0;
    let nFailed = 0;
    if (dim) {
      for (const [k, b] of dim) {
        if (k >= from) {
          nTotal += b.nTotal;
          nFailed += b.nFailed;
        }
      }
    }
    return {
      nTotal,
      nFailed,
      declineRate: nTotal === 0 ? 0 : nFailed / nTotal,
      windowMinutes: this.opts.windowMinutes,
    };
  }

  baselineSync(cohortDim: string): CohortBaseline {
    const row = this.baselines.get(cohortDim);
    if (!row) {
      return {
        mean: this.opts.seedBaselineRate,
        variance: this.opts.seedBaselineVar,
        samples: 0,
        seeded: true,
      };
    }
    return { ...row, seeded: false };
  }

  updateBaselineSync(cohortDim: string, observedRate: number): void {
    const prior = this.baselineSync(cohortDim);
    const a = this.opts.ewmaAlpha;
    const mean = a * observedRate + (1 - a) * prior.mean;
    const dev = observedRate - prior.mean;
    const variance = Math.max(1e-6, a * dev * dev + (1 - a) * prior.variance);
    this.baselines.set(cohortDim, { mean, variance, samples: prior.samples + 1 });
  }

  /**
   * Every cohort dimension with a closed bucket at or before `before`, with
   * that bucket's observed rate. This is what a baseline-maintenance cron would
   * read: rates for *completed* windows, never the one currently filling.
   *
   * Advancing the baseline per classified event is what poisoned it the first
   * time round (FAILURES #3) — one n=1 bucket at rate 1.0 pushed the 3σ
   * threshold above 1.0 and detection died silently.
   */
  closedBuckets(before: Date, minN: number): Array<{ cohortDim: string; rate: number; bucket: number }> {
    const cutoff = bucketStart(before, this.opts.bucketMinutes).getTime();
    const out: Array<{ cohortDim: string; rate: number; bucket: number }> = [];
    for (const [cohortDim, dim] of this.buckets) {
      for (const [k, b] of dim) {
        if (k < cutoff && b.nTotal >= minN) {
          out.push({ cohortDim, rate: b.nFailed / b.nTotal, bucket: k });
        }
      }
    }
    return out.sort((x, y) => x.bucket - y.bucket);
  }

  /** Total observations, for assertions in tests. */
  get size(): number {
    let n = 0;
    for (const dim of this.buckets.values()) for (const b of dim.values()) n += b.nTotal;
    return n;
  }
}
