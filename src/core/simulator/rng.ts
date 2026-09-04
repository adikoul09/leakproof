/**
 * Seeded distributions for the synthetic generator.
 *
 * Everything here is built on `mulberry32`, the same PRNG the bootstrap uses,
 * for one reason: a batch must be reproducible from its seed alone. The batch
 * record stores the seed, so anyone can regenerate the exact corpus a reported
 * number was computed over. That is the difference between a generator that
 * makes the lift auditable and one that just makes it look busy.
 *
 * Pure. No clock, no environment, no I/O.
 */

export type Rng = () => number;

/**
 * A named sub-stream. Drawing every variate from one sequence makes the whole
 * corpus fragile — adding one draw in the amount sampler would shift every
 * subsequent issuer, method and failure reason, so a one-line change to the
 * model would look like a completely different dataset. Independent streams
 * keyed by name mean each dimension is stable under edits to the others.
 */
export function stream(seed: number, name: string): Rng {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < name.length; i += 1) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return mulberry32((seed ^ h) >>> 0);
}

/** Local copy so the simulator does not depend on the statistics module. */
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform integer in [lo, hi]. */
export function intBetween(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/**
 * Box–Muller. Returns one standard normal variate; the second is discarded,
 * which costs a draw and buys a stateless function.
 */
export function normal(rng: Rng): number {
  // Guard the log against exactly 0, which mulberry32 can return.
  const u = Math.max(rng(), Number.EPSILON);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Log-normal — the heavy tail.
 *
 * Payment ticket sizes are not normal and they are not uniform: most are
 * small, a few are enormous, and the enormous ones carry a wildly
 * disproportionate share of the rupees at risk. A generator that samples
 * amounts uniformly makes the incrementality interval look far tighter than
 * it has any right to be, because the variance that actually dominates the
 * rupee estimate has been engineered away. The tail is the hard part, so the
 * tail has to be there.
 */
export function lognormal(rng: Rng, mu: number, sigma: number): number {
  return Math.exp(mu + sigma * normal(rng));
}

export interface Weighted<T> {
  value: T;
  weight: number;
}

/** Categorical draw. Weights need not sum to 1. */
export function weightedPick<T>(rng: Rng, table: ReadonlyArray<Weighted<T>>): T {
  let total = 0;
  for (const t of table) total += t.weight;
  let r = rng() * total;
  for (const t of table) {
    r -= t.weight;
    if (r <= 0) return t.value;
  }
  return table[table.length - 1].value;
}

/**
 * Sample from a piecewise-constant density given as per-slot weights.
 * Returns a fractional index in [0, weights.length), so callers get a
 * continuous position rather than a slot number.
 */
export function sampleFromCurve(rng: Rng, weights: readonly number[]): number {
  let total = 0;
  for (const w of weights) total += w;
  let r = rng() * total;
  for (let i = 0; i < weights.length; i += 1) {
    if (r < weights[i]) return i + r / Math.max(weights[i], Number.EPSILON);
    r -= weights[i];
  }
  return weights.length - Number.EPSILON;
}

/** Fisher–Yates, seeded. Shuffles in place and returns the same array. */
export function shuffle<T>(rng: Rng, xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}
