/**
 * Systemic vs idiosyncratic. Blueprint 6.5, steps 2–6.
 *
 * Pure and deterministic: every input is passed in, nothing is read from the
 * database or the clock here. That is what lets the replay engine drive the
 * *same* function over a historical corpus instead of a second implementation.
 */
import { TRIAGE, amountBand, istBucketIndex } from './config';
import {
  type FailureClass,
  type FailureKind,
  type RawError,
  type TaxonomyMatch,
  classifyRawError,
  escalateToSystemic,
} from './taxonomy';
import type { CohortBaseline, CohortWindow } from './cohort-store';

export interface CohortInputs {
  issuer: string | null;
  method: string | null;
  amountPaise: number;
  failedAt: Date;
}

/**
 * The printable cohort key stored on the classification row:
 * `issuer|method|amount_band|bucket` — blueprint 6.2, e.g. 'HDFC|card|1k-5k|172'.
 * `bucket` is the 5-minute bucket index within the IST day (0–287).
 */
export function cohortKey(c: CohortInputs): string {
  return [
    c.issuer ?? 'unknown',
    c.method ?? 'unknown',
    amountBand(c.amountPaise),
    istBucketIndex(c.failedAt),
  ].join('|');
}

/**
 * The dimension the decline *rate* is measured over. Narrower than cohortKey
 * on purpose — see TRIAGE.rateDimensions for why amount band is excluded.
 */
export function cohortDim(c: Pick<CohortInputs, 'issuer' | 'method' | 'amountPaise'>): string {
  const parts: string[] = [];
  for (const d of TRIAGE.rateDimensions) {
    if (d === 'issuer') parts.push(c.issuer ?? 'unknown');
    else if (d === 'method') parts.push(c.method ?? 'unknown');
    else parts.push(amountBand(c.amountPaise));
  }
  return parts.join('|');
}

/**
 * The three tunable guards, overridable per call.
 *
 * Defaulting to TRIAGE keeps every existing caller identical. Passing them in
 * is what lets `scripts/tune-triage.ts` sweep thresholds against the exact
 * production classifier rather than a copy of it, and what will let the replay
 * engine answer "what would we have caught at a 0.30 floor?" without a second
 * implementation drifting out of step with this one.
 */
export interface SystemicThresholds {
  minCohortN: number;
  sigmaMultiplier: number;
  absoluteFloor: number;
}

export const DEFAULT_THRESHOLDS: SystemicThresholds = {
  minCohortN: TRIAGE.minCohortN,
  sigmaMultiplier: TRIAGE.sigmaMultiplier,
  absoluteFloor: TRIAGE.absoluteFloor,
};

export interface SystemicTest {
  passed: boolean;
  /** Each guard, with the number it was tested against — this is the trace. */
  checks: Array<{ rule: string; expected: string; actual: string; pass: boolean }>;
  zScore: number;
  threshold: number;
}

/**
 * The three-guard systemic test. ALL must pass (blueprint 6.5 step 4):
 *   cohort_n ≥ 8, decline_rate > baseline + 3σ, decline_rate > 0.25 absolute.
 */
export function testSystemic(
  window: CohortWindow,
  baseline: CohortBaseline,
  thresholds: SystemicThresholds = DEFAULT_THRESHOLDS,
): SystemicTest {
  const sigma = Math.sqrt(baseline.variance);
  const threshold = baseline.mean + thresholds.sigmaMultiplier * sigma;
  const zScore = sigma > 0 ? (window.declineRate - baseline.mean) / sigma : 0;

  const checks = [
    {
      rule: 'min_cohort_n',
      expected: `>= ${thresholds.minCohortN}`,
      actual: String(window.nTotal),
      pass: window.nTotal >= thresholds.minCohortN,
    },
    {
      rule: 'above_baseline_sigma',
      expected: `> ${threshold.toFixed(4)} (baseline ${baseline.mean.toFixed(4)} + ${thresholds.sigmaMultiplier}σ, σ=${sigma.toFixed(4)})`,
      actual: window.declineRate.toFixed(4),
      pass: window.declineRate > threshold,
    },
    {
      rule: 'absolute_floor',
      expected: `> ${thresholds.absoluteFloor}`,
      actual: window.declineRate.toFixed(4),
      pass: window.declineRate > thresholds.absoluteFloor,
    },
  ];

  return { passed: checks.every((c) => c.pass), checks, zScore, threshold };
}

/** logistic(z), clipped — blueprint 6.5 step 6. */
export function systemicConfidence(zScore: number): number {
  const p = 1 / (1 + Math.exp(-zScore));
  return Math.min(TRIAGE.confidenceCeil, Math.max(TRIAGE.confidenceFloor, p));
}

export interface ClassificationResult {
  kind: FailureKind;
  failureClass: FailureClass;
  confidence: number;
  cohortKey: string;
  cohortDim: string;
  cohortDeclineRate: number;
  cohortN: number;
  /** Human-readable reasoning, surfaced verbatim in the Decision Trace drawer. */
  trace: {
    taxonomy: TaxonomyMatch;
    systemic: SystemicTest;
    /** Why the final kind was chosen, in one line. */
    verdict: string;
  };
}

export interface ClassifyInput extends CohortInputs {
  error: RawError;
  window: CohortWindow;
  baseline: CohortBaseline;
  /** Defaults to the live TRIAGE constants. */
  thresholds?: SystemicThresholds;
}

/**
 * The full decision.
 *
 * Note what is NOT here: the Payment Downtime API. Agreement with Razorpay's
 * own downtime feed is recorded alongside the classification, never fed into
 * it — if the API were an input, using the API to validate the detector would
 * be circular and the number would mean nothing. Blueprint 6.5 step 5.
 */
export function classify(input: ClassifyInput): ClassificationResult {
  const taxonomy = classifyRawError(input.error);
  const systemic = testSystemic(input.window, input.baseline, input.thresholds);
  const key = cohortKey(input);
  const dim = cohortDim(input);

  const base = {
    cohortKey: key,
    cohortDim: dim,
    cohortDeclineRate: input.window.declineRate,
    cohortN: input.window.nTotal,
  };

  // A customer-side failure stays customer-side no matter how many of them
  // arrive at once. Ten people short of funds is not an outage, and treating
  // it as one would park recoverable revenue behind a circuit breaker.
  if (taxonomy.flavour === 'customer') {
    return {
      ...base,
      kind: 'idiosyncratic',
      failureClass: taxonomy.failureClass,
      confidence: taxonomy.confidence,
      trace: {
        taxonomy,
        systemic,
        verdict: `customer-side failure class (${taxonomy.matchedOn}); cohort evidence not applicable`,
      },
    };
  }

  if (systemic.passed) {
    return {
      ...base,
      kind: 'systemic',
      failureClass: escalateToSystemic(input.issuer),
      confidence: systemicConfidence(systemic.zScore),
      trace: {
        taxonomy,
        systemic,
        verdict: `all three systemic guards passed on cohort ${dim} (n=${input.window.nTotal}, decline ${(input.window.declineRate * 100).toFixed(1)}%)`,
      },
    };
  }

  // Infra-flavoured but not enough cohort support to call an outage. This is
  // deliberately 'unknown' rather than 'idiosyncratic': we genuinely cannot
  // tell yet, and the policy engine treats unknown more cautiously.
  const failedGuard = systemic.checks.find((c) => !c.pass);
  if (taxonomy.flavour === 'infra') {
    return {
      ...base,
      kind: 'unknown',
      failureClass: 'gateway_error',
      confidence: Math.min(taxonomy.confidence, 0.7),
      trace: {
        taxonomy,
        systemic,
        verdict: `infrastructure-flavoured failure without cohort support (failed guard: ${failedGuard?.rule ?? 'none'})`,
      },
    };
  }

  return {
    ...base,
    kind: 'unknown',
    failureClass: 'unknown',
    confidence: TRIAGE.confidenceFloor,
    trace: {
      taxonomy,
      systemic,
      verdict: `error payload carried no usable signal (${taxonomy.matchedOn})`,
    },
  };
}
