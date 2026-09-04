/**
 * Tune the systemic detector against a known outage.
 *
 *   npm run tune:triage
 *   npm run tune:triage -- --seeds 8 --count 6000 --duration 90 --spike 62
 *
 * The blueprint states the bar plainly: the thresholds `n>=8`, `3σ`, `0.25`
 * are assumptions until precision AND recall both clear 0.8 on the generator's
 * injected outage. This script is what closes that. It exits non-zero if the
 * live configuration misses the bar, so the assumption cannot quietly survive.
 *
 * Method
 * ------
 * 1. Generate corpora with an injected issuer outage, ACROSS SEVERAL VOLUMES.
 *    Tuning at a single volume is how the first pass went wrong: thresholds
 *    picked against 6,000 failures a day and a 90-minute outage scored 94.6%
 *    precision there and 78% on the 3,000-failure demo preset, because a
 *    thinner corpus means smaller cohorts and more small-sample false alarms.
 *    A configuration that only works at the density it was tuned on is
 *    overfitted, and the bar has to be cleared at the worst scenario, not the
 *    average. Ground truth is per event and comes from the failure payload the
 *    generator planted, not from membership of the window: an insufficient-funds
 *    decline that happens to land mid-outage is idiosyncratic, and counting it
 *    as systemic would hand the detector precision it did not earn.
 * 2. Replay each corpus in timestamp order through the real `MemoryCohortStore`
 *    and the real `classify()`. No re-implementation — a harness that reimplements
 *    the thing it is tuning measures the harness.
 * 3. The cohort window and the baseline do not depend on the three thresholds,
 *    so they are computed once per baseline mode and every threshold
 *    combination is scored against that cached table.
 *
 * No database, no network. Runs in seconds and is reproducible from the seeds.
 */
import {
  DEFAULT_THRESHOLDS,
  type SystemicThresholds,
  classify,
  cohortDim,
} from '../src/core/triage/classifier';
import { MemoryCohortStore } from '../src/core/triage/memory-cohort-store';
import { bucketStart } from '../src/core/triage/config';
import { type Method, generateBatch } from '../src/core/simulator';
import type { CohortBaseline, CohortWindow } from '../src/core/triage/cohort-store';

const arg = (name: string, dflt: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : Number(process.argv[i + 1]);
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

/** Snapshot of everything the three guards need, per failed event. */
interface Sample {
  id: string;
  window: CohortWindow;
  baseline: CohortBaseline;
  issuer: string | null;
  method: string | null;
  amountPaise: number;
  failedAt: Date;
  error: { code: string | null; description: string | null; source: string | null; step: string | null; reason: string | null };
  truthSystemic: boolean;
  inOutageWindow: boolean;
  /** On the degraded issuer+method, inside the window — the cohort under test. */
  onOutageCohort: boolean;
}

type BaselineMode = 'seeded' | 'adaptive';

/** Minimum bucket volume before a closed bucket is allowed to move the baseline. */
const BASELINE_MIN_BUCKET_N = 5;

function replay(
  events: ReturnType<typeof generateBatch>['events'],
  truth: Set<string>,
  outage: { startedAt: string; endedAt: string; issuer: string; method: string } | null,
  mode: BaselineMode,
): Sample[] {
  const store = new MemoryCohortStore();
  const samples: Sample[] = [];
  const advanced = new Set<string>();
  let lastBucket = 0;

  // Emission order is deliberately not always time order (the generator plants
  // out-of-order deliveries). The cohort counters key off `failed_at`, so the
  // replay must too, or the window is assembled from the wrong buckets.
  const ordered = [...events].sort(
    (a, b) => Date.parse(a.failed_at) - Date.parse(b.failed_at),
  );

  const outageStart = outage ? Date.parse(outage.startedAt) : 0;
  const outageEnd = outage ? Date.parse(outage.endedAt) : 0;
  const outageDim = outage ? cohortDim({ issuer: outage.issuer, method: outage.method, amountPaise: 0 }) : null;

  for (const e of ordered) {
    const at = new Date(e.failed_at);
    const dim = cohortDim({ issuer: e.issuer, method: e.method, amountPaise: e.amount_paise });

    if (mode === 'adaptive') {
      const b = bucketStart(at).getTime();
      if (b !== lastBucket) {
        // Advance the baseline only on buckets that have closed. Nudging it per
        // classified event is what silently killed detection the first time
        // round — see FAILURES #3.
        for (const c of store.closedBuckets(at, BASELINE_MIN_BUCKET_N)) {
          const key = `${c.cohortDim}@${c.bucket}`;
          if (advanced.has(key)) continue;
          advanced.add(key);
          store.updateBaselineSync(c.cohortDim, c.rate);
        }
        lastBucket = b;
      }
    }

    // Production order: the ingest route observes the cohort, then triage reads
    // the window. The event is therefore inside its own window.
    store.observeSync(dim, at, e.outcome === 'failed');
    if (e.outcome !== 'failed') continue;

    samples.push({
      id: e.id,
      window: store.windowSync(dim, at),
      baseline: store.baselineSync(dim),
      issuer: e.issuer,
      method: e.method,
      amountPaise: e.amount_paise,
      failedAt: at,
      error: {
        code: e.err_code ?? null,
        description: e.err_description ?? null,
        source: e.err_source ?? null,
        step: e.err_step ?? null,
        reason: e.err_reason ?? null,
      },
      truthSystemic: truth.has(e.id),
      inOutageWindow: outage !== null && at.getTime() >= outageStart && at.getTime() < outageEnd,
      onOutageCohort:
        outageDim !== null &&
        dim === outageDim &&
        at.getTime() >= outageStart &&
        at.getTime() < outageEnd,
    });
  }
  return samples;
}

interface Score {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
  /**
   * Seconds from outage start to the first systemic call ON THE DEGRADED
   * COHORT. Measuring "first systemic anywhere" instead reports the earliest
   * false positive, which on a 24-hour corpus is hours before the outage —
   * a lag of minus twenty-two hours, which is not a detection time.
   */
  detectionLagS: number | null;
  /** False positives that fell outside the injected window entirely. */
  fpOutsideWindow: number;
}

function score(samples: Sample[], thresholds: SystemicThresholds, outageStart: number | null): Score {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let fpOutside = 0;
  let firstSystemicAt: number | null = null;

  for (const s of samples) {
    const r = classify({
      issuer: s.issuer,
      method: s.method,
      amountPaise: s.amountPaise,
      failedAt: s.failedAt,
      error: s.error,
      window: s.window,
      baseline: s.baseline,
      thresholds,
    });
    const predicted = r.kind === 'systemic';
    if (predicted && s.onOutageCohort && firstSystemicAt === null) {
      firstSystemicAt = s.failedAt.getTime();
    }
    if (predicted && s.truthSystemic) tp += 1;
    else if (predicted) {
      fp += 1;
      if (!s.inOutageWindow) fpOutside += 1;
    } else if (s.truthSystemic) fn += 1;
  }

  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  return {
    tp,
    fp,
    fn,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    detectionLagS:
      firstSystemicAt === null || outageStart === null
        ? null
        : Math.round((firstSystemicAt - outageStart) / 1000),
    fpOutsideWindow: fpOutside,
  };
}

const pctf = (x: number) => `${(x * 100).toFixed(1)}%`;

interface Scenario {
  name: string;
  count: number;
  durationMin: number;
  spikePct: number;
  windowHours: number;
}

/**
 * The conditions the detector actually has to work under. The demo preset is
 * the thin end and the stress preset the thick end; a configuration has to
 * clear the bar on ALL of them, because "works at high volume" is not a
 * property anyone can rely on.
 */
const SCENARIOS: Scenario[] = [
  { name: 'demo (3k/day, 45m outage)', count: 3000, durationMin: 45, spikePct: 62, windowHours: 24 },
  { name: 'busy (6k/day, 90m outage)', count: 6000, durationMin: 90, spikePct: 62, windowHours: 24 },
  { name: 'brief (3k/day, 20m outage)', count: 3000, durationMin: 20, spikePct: 70, windowHours: 24 },
  { name: 'dense (4k/6h, 180m outage)', count: 4000, durationMin: 180, spikePct: 78, windowHours: 6 },
];

async function main() {
  const SEEDS = arg('seeds', 3);
  const SPIKE = arg('spike', 62);
  const ISSUER = 'HDFC';
  const METHOD: Method = 'card';
  const only = process.argv.indexOf('--scenario');
  const scenarios = only === -1 ? SCENARIOS : SCENARIOS.filter((s) => s.name.includes(process.argv[only + 1]));

  console.log('\ntuning the systemic detector against an injected issuer outage');
  console.log(`  scenarios      : ${scenarios.length}, ${SEEDS} seeds each`);
  for (const s of scenarios) console.log(`                   ${s.name}`);
  console.log(`  bar            : precision ≥ 0.80 AND recall ≥ 0.80 on EVERY scenario\n`);
  void SPIKE;

  // Replay every corpus once per baseline mode, then score thresholds off the cache.
  type Cached = { samples: Sample[]; outageStart: number };
  const cache: Record<string, Record<BaselineMode, Cached[]>> = {};
  let truthTotal = 0;

  for (const sc of scenarios) {
    cache[sc.name] = { seeded: [], adaptive: [] };
    let scenarioTruth = 0;
    for (let s = 0; s < SEEDS; s += 1) {
      const seed = 20260900 + s * 7717;
      const batch = generateBatch({
        count: sc.count,
        seed,
        windowHours: sc.windowHours,
        endsAt: new Date('2026-09-04T18:30:00+05:30'),
        injectOutage: {
          issuer: ISSUER,
          method: METHOD,
          durationMin: sc.durationMin,
          spikePct: sc.spikePct,
        },
        organicRecoveryRate: 0.11,
        adversarialPct: 0.05,
        paydayStrength: 0.8,
      });
      const truth = new Set(batch.groundTruth.systemicEventIds);
      truthTotal += truth.size;
      scenarioTruth += truth.size;
      const outageStart = Date.parse(batch.groundTruth.outage!.startedAt);
      for (const mode of ['seeded', 'adaptive'] as BaselineMode[]) {
        cache[sc.name][mode].push({
          samples: replay(batch.events, truth, batch.groundTruth.outage, mode),
          outageStart,
        });
      }
    }
    console.log(`  ${sc.name.padEnd(28)} ${scenarioTruth} truly systemic events`);
  }

  console.log(`\n  ${truthTotal} systemic events across all scenarios`);

  /** Score one scenario. */
  const scoreScenario = (name: string, mode: BaselineMode, t: SystemicThresholds): Score => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let fpOutside = 0;
    const lags: number[] = [];
    for (const c of cache[name][mode]) {
      const r = score(c.samples, t, c.outageStart);
      tp += r.tp;
      fp += r.fp;
      fn += r.fn;
      fpOutside += r.fpOutsideWindow;
      if (r.detectionLagS !== null) lags.push(r.detectionLagS);
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    return {
      tp,
      fp,
      fn,
      precision,
      recall,
      f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
      detectionLagS: lags.length === 0 ? null : Math.round(lags.reduce((a, b) => a + b, 0) / lags.length),
      fpOutsideWindow: fpOutside,
    };
  };

  /**
   * The score that decides. A configuration is only as good as its WORST
   * scenario — averaging would let a strong result at high volume paper over a
   * failure at the volume the demo actually runs at, which is precisely the
   * mistake this harness now exists to prevent.
   */
  const aggregate = (mode: BaselineMode, t: SystemicThresholds): Score => {
    const per = scenarios.map((sc) => scoreScenario(sc.name, mode, t));
    let worst = per[0];
    for (const p of per) {
      if (Math.min(p.precision, p.recall) < Math.min(worst.precision, worst.recall)) worst = p;
    }
    return {
      ...worst,
      tp: per.reduce((a, p) => a + p.tp, 0),
      fp: per.reduce((a, p) => a + p.fp, 0),
      fn: per.reduce((a, p) => a + p.fn, 0),
    };
  };

  // ── where the live configuration lands ──
  console.log('\n── live configuration ──');
  for (const mode of ['seeded', 'adaptive'] as BaselineMode[]) {
    const r = aggregate(mode, DEFAULT_THRESHOLDS);
    console.log(
      `  ${mode.padEnd(8)} n≥${DEFAULT_THRESHOLDS.minCohortN} ${DEFAULT_THRESHOLDS.sigmaMultiplier}σ floor ${DEFAULT_THRESHOLDS.absoluteFloor}` +
        `  precision ${pctf(r.precision)}  recall ${pctf(r.recall)}  F1 ${r.f1.toFixed(3)}` +
        `  tp ${r.tp} fp ${r.fp} fn ${r.fn}  lag ${r.detectionLagS ?? '—'}s`,
    );
  }

  // ── sweep ──
  const N_GRID = [4, 6, 8, 12, 16, 24];
  const SIGMA_GRID = [1.5, 2, 2.5, 3, 4];
  const FLOOR_GRID = [0.15, 0.2, 0.25, 0.3, 0.35, 0.45];

  const results: Array<{ mode: BaselineMode; t: SystemicThresholds; r: Score }> = [];
  for (const mode of ['seeded', 'adaptive'] as BaselineMode[]) {
    for (const minCohortN of N_GRID) {
      for (const sigmaMultiplier of SIGMA_GRID) {
        for (const absoluteFloor of FLOOR_GRID) {
          const t = { minCohortN, sigmaMultiplier, absoluteFloor };
          results.push({ mode, t, r: aggregate(mode, t) });
        }
      }
    }
  }

  const passing = results.filter((x) => x.r.precision >= 0.8 && x.r.recall >= 0.8);
  passing.sort((a, b) => b.r.f1 - a.r.f1 || (a.r.detectionLagS ?? 1e9) - (b.r.detectionLagS ?? 1e9));

  console.log(`\n── sweep: ${results.length} configurations, ${passing.length} clear the bar ──`);
  const show = (xs: typeof results, n: number) => {
    for (const x of xs.slice(0, n)) {
      console.log(
        `  ${x.mode.padEnd(8)} n≥${String(x.t.minCohortN).padStart(2)} ${String(x.t.sigmaMultiplier).padStart(3)}σ floor ${x.t.absoluteFloor.toFixed(2)}` +
          `  P ${pctf(x.r.precision).padStart(6)}  R ${pctf(x.r.recall).padStart(6)}  F1 ${x.r.f1.toFixed(3)}` +
          `  lag ${String(x.r.detectionLagS ?? '—').padStart(4)}s  fp-outside ${x.r.fpOutsideWindow}`,
      );
    }
  };

  if (passing.length > 0) show(passing, 10);
  else {
    console.log('  none. best by F1:');
    show([...results].sort((a, b) => b.r.f1 - a.r.f1), 10);
  }

  // The sweep's headline answer is driven almost entirely by minCohortN, so
  // show the best each value can do. Raising it buys precision by refusing to
  // judge quiet cohorts at all, and that trade has to be made deliberately.
  console.log('\n── best per minCohortN (seeded baseline) ──');
  for (const n of N_GRID) {
    const best = results
      .filter((x) => x.mode === 'seeded' && x.t.minCohortN === n)
      .sort((a, b) => b.r.f1 - a.r.f1)[0];
    const totalFailures = scenarios.reduce(
      (acc, sc) => acc + cache[sc.name].seeded.reduce((a, c) => a + c.samples.length, 0),
      0,
    );
    console.log(
      `  n≥${String(n).padStart(2)}  ${String(best.t.sigmaMultiplier).padStart(3)}σ floor ${best.t.absoluteFloor.toFixed(2)}` +
        `  P ${pctf(best.r.precision).padStart(6)}  R ${pctf(best.r.recall).padStart(6)}  F1 ${best.r.f1.toFixed(3)}` +
        `  false alarms ${(1000 * best.r.fp / totalFailures).toFixed(2)}/1k failures` +
        `  lag ${String(best.r.detectionLagS ?? '—').padStart(4)}s`,
    );
  }

  // Hold minCohortN at the deployed value and vary only the floor. Raising
  // minCohortN buys precision by refusing to judge quiet cohorts at all, which
  // makes the detector blind at any merchant smaller than this corpus — a bad
  // trade to make silently. The floor is the honest knob.
  console.log(`\n── holding minCohortN at ${DEFAULT_THRESHOLDS.minCohortN}, varying the floor (seeded) ──`);
  const totalFailures = scenarios.reduce(
    (acc, sc) => acc + cache[sc.name].seeded.reduce((a, c) => a + c.samples.length, 0),
    0,
  );
  for (const floor of FLOOR_GRID) {
    const r = aggregate('seeded', {
      minCohortN: DEFAULT_THRESHOLDS.minCohortN,
      sigmaMultiplier: DEFAULT_THRESHOLDS.sigmaMultiplier,
      absoluteFloor: floor,
    });
    const bar = r.precision >= 0.8 && r.recall >= 0.8 ? '✓' : ' ';
    console.log(
      `  ${bar} floor ${floor.toFixed(2)}  P ${pctf(r.precision).padStart(6)}  R ${pctf(r.recall).padStart(6)}` +
        `  F1 ${r.f1.toFixed(3)}  false alarms ${(1000 * r.fp / totalFailures).toFixed(2)}/1k` +
        `  detection lag ${String(r.detectionLagS ?? '—').padStart(4)}s`,
    );
  }

  // Under the seeded prior the σ threshold is 0.08 + k×0.05. At the deployed
  // k=3 that is 0.23, below the 0.25 floor, so the floor binds first and the
  // sigma guard never changes an outcome — two guards, not three. It only
  // starts to bite past k≈3.4. Say so rather than presenting a three-factor
  // test that is really a two-factor one.
  const atK = (k: number) =>
    aggregate('seeded', { ...DEFAULT_THRESHOLDS, sigmaMultiplier: k }).f1.toFixed(6);
  if (atK(1.5) === atK(DEFAULT_THRESHOLDS.sigmaMultiplier)) {
    console.log(
      `\n  ⚠ sigmaMultiplier is inert at the deployed settings: 1.5σ and ` +
        `${DEFAULT_THRESHOLDS.sigmaMultiplier}σ score identically.\n` +
        `    Seeded prior puts the σ threshold at 0.08 + ${DEFAULT_THRESHOLDS.sigmaMultiplier}×0.05 = ` +
        `${(0.08 + DEFAULT_THRESHOLDS.sigmaMultiplier * 0.05).toFixed(2)}, below the ` +
        `${DEFAULT_THRESHOLDS.absoluteFloor} floor, so the floor always binds first.\n` +
        `    The systemic test is effectively two guards, not three.`,
    );
  }

  console.log('\n── the deployed configuration, per scenario ──');
  for (const sc of scenarios) {
    const r = scoreScenario(sc.name, 'seeded', DEFAULT_THRESHOLDS);
    const ok = r.precision >= 0.8 && r.recall >= 0.8 ? '✓' : '✗';
    console.log(
      `  ${ok} ${sc.name.padEnd(28)} P ${pctf(r.precision).padStart(6)}  R ${pctf(r.recall).padStart(6)}  F1 ${r.f1.toFixed(3)}  lag ${String(r.detectionLagS ?? '—').padStart(4)}s`,
    );
  }

  const live = aggregate('seeded', DEFAULT_THRESHOLDS);
  const ok = live.precision >= 0.8 && live.recall >= 0.8;
  console.log(
    `\n${ok ? '✓' : '✗'} live thresholds (seeded baseline, as deployed): ` +
      `precision ${pctf(live.precision)}, recall ${pctf(live.recall)} — bar is 80% / 80%`,
  );

  if (!ok && passing.length > 0) {
    const best = passing[0];
    console.log(
      `\n  best passing configuration: minCohortN ${best.t.minCohortN}, sigmaMultiplier ${best.t.sigmaMultiplier}, ` +
        `absoluteFloor ${best.t.absoluteFloor} (${best.mode} baseline)`,
    );
    console.log('  set these in src/core/triage/config.ts');
  }

  if (!ok && !flag('no-fail')) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
