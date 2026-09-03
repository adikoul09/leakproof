/**
 * Tunable constants for systemic-failure detection (blueprint 6.5).
 *
 * 🔸 ASSUMPTION. Every number here is a guess until it has been tuned against
 * the synthetic generator's injected outage. The bar, stated in the blueprint:
 * precision AND recall both clear 0.8 on the injected window. Do not treat
 * these as settled; they are the first thing to move if the Outage Radar's
 * agreement scorecard looks bad.
 */
export const TRIAGE = {
  /** Rolling window over which a cohort's decline rate is measured. */
  windowMinutes: 15,
  /** Counter bucket granularity. windowMinutes must be a multiple of this. */
  bucketMinutes: 5,

  /** Guard against small-sample noise. Below this, never call systemic. */
  minCohortN: 8,
  /** Decline rate must exceed baseline + sigmaMultiplier × σ (EWMA baseline). */
  sigmaMultiplier: 3,
  /** ...and clear this absolute floor, regardless of how quiet the baseline is. */
  absoluteFloor: 0.25,
  /** EWMA smoothing factor for the baseline decline rate. */
  ewmaAlpha: 0.3,
  /** Seed baseline for a cohort dimension seen for the first time. */
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
