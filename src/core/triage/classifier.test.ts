import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classify, cohortDim, cohortKey, testSystemic } from './classifier';
import { classifyRawError } from './taxonomy';
import type { CohortBaseline, CohortWindow } from './cohort-store';
import { TRIAGE } from './config';

const QUIET_BASELINE: CohortBaseline = {
  mean: 0.08,
  variance: 0.0025, // σ = 0.05, so the 3σ threshold sits at 0.23
  samples: 40,
  seeded: false,
};

const window = (nTotal: number, nFailed: number): CohortWindow => ({
  nTotal,
  nFailed,
  declineRate: nTotal === 0 ? 0 : nFailed / nTotal,
  windowMinutes: 15,
});

const ISSUER_DOWN = {
  code: 'GATEWAY_ERROR',
  description: 'Issuer is temporarily unavailable',
  source: 'issuer',
  step: 'payment_authorization',
  reason: 'issuer_down',
};

const INSUFFICIENT = {
  code: 'BAD_REQUEST_ERROR',
  description: 'Your card has insufficient funds',
  source: 'customer',
  step: 'payment_authorization',
  reason: 'insufficient_funds',
};

const base = { issuer: 'HDFC', method: 'card', amountPaise: 234_000, failedAt: new Date('2026-09-04T08:52:00Z') };

describe('taxonomy', () => {
  it('trusts an exact reason slug most', () => {
    const m = classifyRawError(INSUFFICIENT);
    assert.equal(m.failureClass, 'insufficient_funds');
    assert.equal(m.flavour, 'customer');
    assert.equal(m.confidence, 0.95);
    assert.equal(m.matchedOn, 'error_reason=insufficient_funds');
  });

  it('falls through Razorpay’s catch-all reason to weaker signals', () => {
    // 'payment_failed' means nothing on its own; the description carries it.
    const m = classifyRawError({ ...INSUFFICIENT, reason: 'payment_failed' });
    assert.equal(m.failureClass, 'insufficient_funds');
    assert.ok(m.confidence < 0.95);
  });

  it('answers unknown rather than guessing when the payload says nothing', () => {
    const m = classifyRawError({ code: null, description: null, source: null, step: null, reason: null });
    assert.equal(m.failureClass, 'unknown');
    assert.equal(m.flavour, 'indeterminate');
    assert.equal(m.confidence, 0.5);
  });
});

describe('systemic guards', () => {
  // Derived from the live constants rather than hardcoded. These thresholds
  // are tuned and they move; a test that pins yesterday's numbers fails for
  // the wrong reason and teaches everyone to edit tests when they retune.
  const tooSmall = TRIAGE.minCohortN - 1;
  const bigEnough = TRIAGE.minCohortN * 2;
  const underFloor = Math.floor(bigEnough * (TRIAGE.absoluteFloor / 2));
  const overFloor = Math.ceil(bigEnough * Math.min(0.95, TRIAGE.absoluteFloor + 0.25));

  it('needs all three to pass', () => {
    // Rate clears both thresholds, but the sample is too small.
    assert.equal(testSystemic(window(tooSmall, tooSmall), QUIET_BASELINE).passed, false);
    // Big enough sample, but the rate is under the absolute floor.
    assert.equal(testSystemic(window(bigEnough, underFloor), QUIET_BASELINE).passed, false);
    // Both cleared.
    assert.equal(testSystemic(window(bigEnough, overFloor), QUIET_BASELINE).passed, true);
  });

  it('names the numbers it tested against, for the decision trace', () => {
    const t = testSystemic(window(tooSmall, tooSmall), QUIET_BASELINE);
    const guard = t.checks.find((c) => c.rule === 'min_cohort_n');
    assert.equal(guard?.expected, `>= ${TRIAGE.minCohortN}`);
    assert.equal(guard?.actual, String(tooSmall));
  });

  it('refuses to call an outage when the baseline is already noisy', () => {
    const noisy: CohortBaseline = { mean: 0.3, variance: 0.04, samples: 40, seeded: false };
    // 50% declines looks alarming, but this cohort's σ is 0.2 — threshold 0.9.
    assert.equal(testSystemic(window(20, 10), noisy).passed, false);
  });
});

describe('classify', () => {
  it('promotes an infrastructure failure with cohort support to systemic', () => {
    const r = classify({ ...base, error: ISSUER_DOWN, window: window(20, 12), baseline: QUIET_BASELINE });
    assert.equal(r.kind, 'systemic');
    assert.equal(r.failureClass, 'issuer_degraded');
    assert.ok(r.confidence > 0.9);
  });

  it('calls it network_degraded when no issuer is named', () => {
    const r = classify({
      ...base,
      issuer: null,
      error: ISSUER_DOWN,
      window: window(20, 12),
      baseline: QUIET_BASELINE,
    });
    assert.equal(r.failureClass, 'network_degraded');
  });

  it('leaves an infrastructure failure as unknown without cohort support', () => {
    // Honest: one unlucky transaction and an outage look identical at n=1.
    const r = classify({ ...base, error: ISSUER_DOWN, window: window(1, 1), baseline: QUIET_BASELINE });
    assert.equal(r.kind, 'unknown');
    assert.equal(r.failureClass, 'gateway_error');
    assert.match(r.trace.verdict, /failed guard: min_cohort_n/);
  });

  it('never sweeps a customer-side failure into an outage', () => {
    // The single most important behaviour in the classifier: this event sits
    // inside a cohort running at 60% declines and still must not be systemic.
    const r = classify({ ...base, error: INSUFFICIENT, window: window(20, 12), baseline: QUIET_BASELINE });
    assert.equal(r.kind, 'idiosyncratic');
    assert.equal(r.failureClass, 'insufficient_funds');
    assert.match(r.trace.verdict, /cohort evidence not applicable/);
  });
});

describe('cohort keys', () => {
  it('stores the blueprint’s four-part printable key', () => {
    assert.equal(cohortKey(base), 'HDFC|card|1k-5k|172');
  });

  it('measures the rate over a narrower dimension than it prints', () => {
    // Amount band is excluded on purpose — an issuer outage hits every band,
    // and splitting by band starves the n >= 8 guard.
    assert.equal(cohortDim(base), 'HDFC|card');
    assert.equal(cohortDim({ ...base, amountPaise: 50 }), 'HDFC|card');
  });
});
