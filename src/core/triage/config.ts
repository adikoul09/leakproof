/**
 * Tunable constants for systemic-failure detection (blueprint 6.5).
 *
 * TUNED — `npm run tune:triage`, 6 seeds × ~6,250 failures, 90-minute HDFC/card
 * outage at 62% decline, 1,165 ground-truth systemic events. Re-run it after
 * changing anything here; it exits non-zero if the bar is missed.
 *
 *   precision 94.6%   recall 93.6%   1.69 false alarms per 1,000 failures
 *   detection lag 346s on the degraded cohort
 *
 * The bar, from the blueprint: precision AND recall both clear 0.8.
 *
 * Two findings from the sweep are recorded below where they bite, and both are
 * in FAILURES.md: the sigma guard is inert at these settings, and advancing the
 * EWMA baseline the way the blueprint implies destroys recall outright.
 */
export const TRIAGE = {
  /** Rolling window over which a cohort's decline rate is measured. */
  windowMinutes: 15,
  /** Counter bucket granularity. windowMinutes must be a multiple of this. */
  bucketMinutes: 5,

  /**
   * Guard against small-sample noise. Below this, never call systemic.
   *
   * The sweep says raising this to 24 buys the best F1 of any configuration
   * (0.961). It is deliberately NOT taken. A minCohortN of 24 means a cohort
   * needs 24 attempts inside a 15-minute window before it can be judged at
   * all, which no cohort at a merchant quieter than this corpus ever reaches —
   * the detector would score beautifully here and be permanently blind in
   * production. The floor below is the honest knob; this one buys precision by
   * declining to look.
   */
  minCohortN: 8,
  /**
   * Decline rate must exceed baseline + sigmaMultiplier × σ (EWMA baseline).
   *
   * ⚠️ Inert at the current settings, and the tuner says so out loud. With the
   * seeded prior the threshold is 0.08 + 3 × 0.05 = 0.23, below the 0.35
   * absolute floor, so the floor always binds first and 1.5σ scores identically
   * to 3σ across the entire grid. The systemic test is honestly two guards, not
   * three. Kept because it starts to bind past k ≈ 5.4 and on any cohort whose
   * baseline has genuinely been measured — but it is not doing work today.
   */
  sigmaMultiplier: 3,
  /**
   * ...and clear this absolute floor, regardless of how quiet the baseline is.
   *
   * 0.25 → 0.35 after tuning. At 0.25 the detector scored precision 77.4% /
   * recall 96.7% — it missed the bar by firing on small-sample noise, 9 false
   * alarms per 1,000 failures. A false systemic call parks a recoverable
   * payment behind the circuit breaker, so on this product a false positive
   * costs real revenue by declining to act, which makes precision the more
   * expensive side to be wrong on. 0.35 gives 94.6% / 93.6% at 1.7 false
   * alarms per 1,000. The price is detection lag: 153s → 346s.
   */
  absoluteFloor: 0.35,
  /** EWMA smoothing factor for the baseline decline rate. */
  ewmaAlpha: 0.3,
  /**
   * Seed baseline for a cohort dimension seen for the first time.
   *
   * ⚠️ In practice this is the ONLY baseline: nothing calls `updateBaseline`,
   * so every cohort is judged against this prior forever. That is not an
   * oversight, it is the tuned answer. Advancing the EWMA from closed 5-minute
   * buckets — the maintenance the blueprint assigns to `outage.detect` — drops
   * recall from 96% to 0.8%. A 5-minute bucket holds ~6 attempts, so its
   * observed rate carries a sampling SD near 0.14; the EWMA absorbs that noise
   * as if it were real volatility, σ inflates to ~0.14, and the 3σ threshold
   * climbs to ~0.55 — above the outage it is meant to catch. Same failure as
   * FAILURES #3, one level up. The real fix is a binomial test that knows n
   * rather than an EWMA that does not; noted in FAILURES.md, not built.
   */
  seedBaselineRate: 0.08,
  seedBaselineVar: 0.0025, // σ ≈ 0.05

  /**
   * Dimensions the rolling decline rate is computed over.
   *
   * The blueprint's stored `cohort_key` is issuer|method|amount_band|5-min
   * bucket, and that is exactly what lands in `classifications.cohort_key`.
   * But the *rate* is measured over issuer|method only: an issuer outage hits
   * every amount band at once, and splitting by band fragments the sample
   * below the minCohortN ≥ 8 guard, which is the single fastest way to make
   * recall collapse. Tunable — flip to include 'amountBand' if tuning says so.
   */
  rateDimensions: ['issuer', 'method'] as const,

  /** Confidence is logistic(z) clipped to this range. */
  confidenceFloor: 0.5,
  confidenceCeil: 0.99,
} as const;

/** Amount bands, blueprint 6.2. Paise, inclusive lower / exclusive upper. */
export const AMOUNT_BANDS = [
  { label: '<500', maxPaise: 50_000 },
  { label: '500-1k', maxPaise: 100_000 },
  { label: '1k-5k', maxPaise: 500_000 },
  { label: '5k-25k', maxPaise: 2_500_000 },
  { label: '25k+', maxPaise: Number.POSITIVE_INFINITY },
] as const;

export function amountBand(amountPaise: number): string {
  for (const b of AMOUNT_BANDS) if (amountPaise < b.maxPaise) return b.label;
  return '25k+';
}

export const IST_OFFSET_MINUTES = 330;

/** Hour of day in IST, 0–23 — the `time_bucket` column. */
export function istHour(at: Date): number {
  return new Date(at.getTime() + IST_OFFSET_MINUTES * 60_000).getUTCHours();
}

/** Floor a timestamp to the start of its counter bucket. */
export function bucketStart(at: Date, minutes: number = TRIAGE.bucketMinutes): Date {
  const ms = minutes * 60_000;
  return new Date(Math.floor(at.getTime() / ms) * ms);
}

/** Index of the 5-minute bucket within the IST day, 0–287. */
export function istBucketIndex(at: Date, minutes: number = TRIAGE.bucketMinutes): number {
  const ist = new Date(at.getTime() + IST_OFFSET_MINUTES * 60_000);
  return Math.floor((ist.getUTCHours() * 60 + ist.getUTCMinutes()) / minutes);
}
