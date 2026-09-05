/**
 * Statistics for the incrementality result — blueprint 6.5.
 *
 * Everything here is pure and deterministic, including the bootstrap: the RNG
 * is seeded, so the same corpus and seed always produce the same interval. A
 * confidence interval that moves when you refresh the page is not evidence,
 * and a judge re-running the replay must get the number they were shown.
 *
 * No statistics library. Each estimator is ~15 lines, and writing them out
 * means the assumptions are visible and testable rather than inherited.
 */

/** 95% two-sided. */
export const Z_95 = 1.959963984540054;

/**
 * Smallest p-value we will report. Beyond |z| ≈ 8 the normal CDF saturates to
 * exactly 1 in double precision, and "p = 0" is a claim no sample can support.
 */
export const P_FLOOR = 1e-16;

export interface Interval {
  lo: number;
  hi: number;
}

/* ────────────────────────────── normal ────────────────────────────── */

/**
 * Abramowitz & Stegun 7.1.26. Max absolute error 1.5e-7 — several orders of
 * magnitude finer than anything that could change a decision here.
 */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/** Standard normal CDF. */
export const normalCdf = (z: number): number => 0.5 * (1 + erf(z / Math.SQRT2));

/**
 * Inverse standard normal CDF (Acklam's rational approximation, relative error
 * < 1.15e-9). Needed by the BCa bootstrap's bias and acceleration corrections.
 */
export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p > pHigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

/* ─────────────────────────── proportions ──────────────────────────── */

/**
 * Wilson score interval for a single proportion.
 *
 * Chosen over the textbook normal approximation because recovery rates are
 * small and some cohorts are thin: the normal interval produces bounds below
 * zero at low rates and degenerates entirely at x = 0 or x = n, both of which
 * happen constantly in a two-day corpus. Wilson stays inside [0, 1] and stays
 * sane at the edges.
 */
export function wilsonInterval(successes: number, n: number, z = Z_95): Interval {
  if (n === 0) return { lo: 0, hi: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/**
 * Newcombe's hybrid score interval for the difference of two proportions
 * (treatment − control), built from the two Wilson intervals.
 *
 * The naive approach — subtracting the two intervals, or a normal interval on
 * the difference — misbehaves in exactly the conditions this experiment runs
 * in: small rates, unequal arm sizes. Newcombe's method is the standard fix
 * and keeps coverage near nominal when a rate approaches 0.
 */
export function proportionDiffInterval(
  treatSuccesses: number,
  treatN: number,
  ctrlSuccesses: number,
  ctrlN: number,
  z = Z_95,
): Interval {
  if (treatN === 0 || ctrlN === 0) return { lo: -1, hi: 1 };
  const p1 = ctrlSuccesses / ctrlN;
  const p2 = treatSuccesses / treatN;
  const w1 = wilsonInterval(ctrlSuccesses, ctrlN, z);
  const w2 = wilsonInterval(treatSuccesses, treatN, z);
  const diff = p2 - p1;
  return {
    lo: diff - Math.sqrt((p2 - w2.lo) ** 2 + (w1.hi - p1) ** 2),
    hi: diff + Math.sqrt((w2.hi - p2) ** 2 + (p1 - w1.lo) ** 2),
  };
}

export interface ZTestResult {
  z: number;
  pValue: number;
}

/** Pooled two-proportion z-test, two-sided. */
export function twoProportionZTest(
  treatSuccesses: number,
  treatN: number,
  ctrlSuccesses: number,
  ctrlN: number,
): ZTestResult {
  if (treatN === 0 || ctrlN === 0) return { z: 0, pValue: 1 };
  const pooled = (treatSuccesses + ctrlSuccesses) / (treatN + ctrlN);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / treatN + 1 / ctrlN));
  if (se === 0) return { z: 0, pValue: 1 };
  const z = (treatSuccesses / treatN - ctrlSuccesses / ctrlN) / se;
  // Clamped at both ends, for opposite reasons.
  //
  // Above 1: the erf approximation carries ~1e-9 of error at z = 0, and a
  // p-value above 1 on screen would rightly destroy confidence in every other
  // number on the page.
  //
  // Below P_FLOOR: normalCdf saturates to exactly 1 past |z| ≈ 8, which makes
  // p come out as literally 0. A p-value of zero is a claim of impossibility,
  // which no finite sample can support. Report the floor and let the reader
  // see it is a floor.
  const raw = 2 * (1 - normalCdf(Math.abs(z)));
  const pValue = Math.min(1, Math.max(P_FLOOR, raw));
  return { z, pValue };
}

/* ──────────────────────────── bootstrap ───────────────────────────── */

/**
 * mulberry32 — small, fast, seeded. The point is reproducibility, not
 * cryptographic quality: the same seed must give the same interval on every
 * machine, forever, so a replay run can be checked against a published number.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function percentile(sortedAscending: number[], q: number): number {
  if (sortedAscending.length === 0) return 0;
  if (sortedAscending.length === 1) return sortedAscending[0];
  const idx = q * (sortedAscending.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAscending[lo];
  return sortedAscending[lo] + (sortedAscending[hi] - sortedAscending[lo]) * (idx - lo);
}

export interface BootstrapOptions {
  iterations?: number;
  seed?: number;
  /** Two-sided level; 0.05 → a 95% interval. */
  alpha?: number;
  /** BCa correction, on by default. Set false for the plain percentile interval. */
  bca?: boolean;
}

/**
 * Percentile bootstrap over the *per-event recovered value* in each arm.
 *
 * `values` holds one number per event: the amount recovered, or 0 if the event
 * never recovered. Resampling those directly — rather than bootstrapping a
 * rate and multiplying by a mean amount — carries the rate and the amount
 * distribution together, which matters because recovery is not independent of
 * ticket size. A ₹40,000 failure and a ₹200 failure do not recover at the same
 * rate, and an estimator that assumes they do will understate its own
 * uncertainty.
 *
 * Returns the interval for `n_treat × (mean(treat) − mean(control))`: the
 * rupees the treated population recovered above what the same population would
 * have recovered at the control arm's per-event rate.
 */
export function bootstrapIncrementalPaise(
  treatValues: number[],
  ctrlValues: number[],
  opts: BootstrapOptions = {},
): Interval {
  const iterations = opts.iterations ?? 2000;
  const alpha = opts.alpha ?? 0.05;
  const rng = mulberry32(opts.seed ?? 42);

  const nT = treatValues.length;
  const nC = ctrlValues.length;
  if (nT === 0 || nC === 0) return { lo: 0, hi: 0 };

  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const sumT = sum(treatValues);
  const sumC = sum(ctrlValues);
  const theta = (mt: number, mc: number) => nT * (mt - mc);
  const observed = theta(sumT / nT, sumC / nC);

  const draws: number[] = new Array(iterations);
  for (let i = 0; i < iterations; i += 1) {
    let st = 0;
    for (let j = 0; j < nT; j += 1) st += treatValues[(rng() * nT) | 0];
    let sc = 0;
    for (let j = 0; j < nC; j += 1) sc += ctrlValues[(rng() * nC) | 0];
    draws[i] = theta(st / nT, sc / nC);
  }
  draws.sort((a, b) => a - b);

  if (!(opts.bca ?? true)) {
    return { lo: percentile(draws, alpha / 2), hi: percentile(draws, 1 - alpha / 2) };
  }

  // ── BCa: bias-correction and acceleration ───────────────────────────
  // The plain percentile interval under-covers here — measured at ~92%
  // against a nominal 95% — because recovered revenue is heavily skewed by a
  // few large tickets. BCa corrects for both the median bias of the bootstrap
  // distribution and its skewness, which is exactly the pair of problems this
  // estimand has.
  let below = 0;
  for (const d of draws) if (d < observed) below += 1;
  const propBelow = below / iterations;
  // Degenerate bootstrap distribution: fall back rather than divide by zero.
  if (propBelow <= 0 || propBelow >= 1) {
    return { lo: percentile(draws, alpha / 2), hi: percentile(draws, 1 - alpha / 2) };
  }
  const z0 = normalQuantile(propBelow);

  // Two-sample jackknife. Leave-one-out means are O(1) each, so the whole
  // acceleration term costs one pass over the data.
  const jack: number[] = new Array(nT + nC);
  const meanC = sumC / nC;
  const meanT = sumT / nT;
  for (let i = 0; i < nT; i += 1) jack[i] = theta((sumT - treatValues[i]) / (nT - 1), meanC);
  for (let j = 0; j < nC; j += 1) jack[nT + j] = theta(meanT, (sumC - ctrlValues[j]) / (nC - 1));

  const jackMean = sum(jack) / jack.length;
  let num = 0;
  let den = 0;
  for (const v of jack) {
    const d = jackMean - v;
    num += d * d * d;
    den += d * d;
  }
  const a = den === 0 ? 0 : num / (6 * Math.pow(den, 1.5));

  const adjust = (q: number): number => {
    const z = normalQuantile(q);
    const denom = 1 - a * (z0 + z);
    if (denom === 0) return q;
    return normalCdf(z0 + (z0 + z) / denom);
  };

  const loQ = Math.min(0.9999, Math.max(0.0001, adjust(alpha / 2)));
  const hiQ = Math.min(0.9999, Math.max(0.0001, adjust(1 - alpha / 2)));

  return {
    lo: percentile(draws, Math.min(loQ, hiQ)),
    hi: percentile(draws, Math.max(loQ, hiQ)),
  };
}

export const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

/* ─────────────────────── randomisation balance ────────────────────── */

export interface BalanceTest {
  /** Observed (max − min) / min across arm mean ticket sizes, in percent. */
  spread_pct: number;
  /**
   * P(a clean split produces a spread at least this large). Small means the
   * split looks genuinely lopsided; large means the gap is ordinary sampling
   * noise on a heavy tail.
   */
  p_value: number;
  /** What a clean split typically produces at these arm sizes. */
  null_median_pct: number;
  /** The spread a clean split exceeds 5% of the time — the honest threshold. */
  null_p95_pct: number;
  iterations: number;
}

/**
 * Permutation test for randomisation balance on mean ticket size.
 *
 * The question a balance check should answer is not "is the spread bigger than
 * 15%" but "is it bigger than chance alone would produce at these arm sizes,
 * on this ticket distribution". Those are very different tests when the
 * distribution is heavy-tailed. Measured on the demo corpus (18,358 events,
 * CV = 2.95, ticket sizes spanning 200×) by repeatedly partitioning the real
 * pool 18/20/62 — i.e. under a split that is clean by construction:
 *
 *   corpus n        6,432   12,860   19,300   25,700
 *   null median      12.3%     8.4%     6.9%     5.9%
 *   null p95         27.6%    18.9%    14.9%    13.2%
 *   P(spread > 15%)    36%      14%       5%       2%
 *
 * So at the size the Lab actually runs at, a fixed 15% threshold accuses a
 * correct randomisation of being broken about a third of the time. It is the
 * same mistake `RECOVERED_CONTROL_FOR_NOMINAL_COVERAGE` avoids by being
 * measured rather than assumed.
 *
 * Under the null the arm labels are exchangeable, so the null distribution is
 * obtained by reshuffling the labels and recomputing the spread. Seeded, so
 * the same corpus always yields the same p-value and a published number can be
 * rechecked.
 *
 * Only the smaller arms are drawn: once they are fixed the largest arm holds
 * whatever is left, and its mean falls out of the pooled total. That keeps the
 * work at ~38% of the corpus per iteration on a 18/20/62 split rather than
 * 100%, which is what makes 2,000 iterations affordable on a request path.
 */
export function permutationBalanceTest(
  armAmounts: number[][],
  opts: { iterations?: number; seed?: number } = {},
): BalanceTest {
  const iterations = opts.iterations ?? 2000;
  const rng = mulberry32(opts.seed ?? 42);

  const spreadOf = (means: number[]): number => {
    const lo = Math.min(...means);
    const hi = Math.max(...means);
    return lo <= 0 ? 0 : ((hi - lo) / lo) * 100;
  };

  const present = armAmounts.filter((a) => a.length > 0);
  if (present.length < 2) {
    return { spread_pct: 0, p_value: 1, null_median_pct: 0, null_p95_pct: 0, iterations: 0 };
  }

  const observed = spreadOf(present.map((a) => mean(a)));

  // One flat pool, permuted in place across iterations. It stays the same
  // multiset throughout, so every iteration is a fresh draw from it.
  const pool: number[] = [];
  for (const a of present) for (const x of a) pool.push(x);
  const n = pool.length;
  const total = pool.reduce((s, x) => s + x, 0);

  const sizes = present.map((a) => a.length).sort((x, y) => x - y);
  const sampled = sizes.slice(0, -1);
  const largest = sizes[sizes.length - 1];

  const nulls: number[] = new Array(iterations);
  let atLeastObserved = 0;

  for (let it = 0; it < iterations; it += 1) {
    let cursor = 0;
    let sampledSum = 0;
    const means: number[] = [];

    for (const k of sampled) {
      let sum = 0;
      // Partial Fisher-Yates — shuffle only the positions actually consumed.
      for (let j = 0; j < k; j += 1) {
        const pick = cursor + ((rng() * (n - cursor)) | 0);
        const held = pool[cursor];
        pool[cursor] = pool[pick];
        pool[pick] = held;
        sum += pool[cursor];
        cursor += 1;
      }
      sampledSum += sum;
      means.push(sum / k);
    }
    means.push((total - sampledSum) / largest);

    const spread = spreadOf(means);
    nulls[it] = spread;
    if (spread >= observed) atLeastObserved += 1;
  }

  nulls.sort((a, b) => a - b);

  return {
    spread_pct: observed,
    // Add-one correction: a p-value of exactly zero would claim more certainty
    // than `iterations` draws can support.
    p_value: (atLeastObserved + 1) / (iterations + 1),
    null_median_pct: percentile(nulls, 0.5),
    null_p95_pct: percentile(nulls, 0.95),
    iterations,
  };
}
