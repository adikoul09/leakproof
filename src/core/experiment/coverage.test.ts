/**
 * Does the confidence interval actually cover?
 *
 * Every other test here checks that the arithmetic matches a formula. This one
 * checks the thing that actually matters: if we plant a known effect and
 * measure it a hundred times over noisy samples, does the 95% interval contain
 * the truth about 95% of the time?
 *
 * A CI that does not cover is worse than no CI, because it launders a guess
 * into a claim. This is the test that would catch it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeMetrics, type MetricEvent } from './metrics';
import { mulberry32 } from './stats';

/** Ticket sizes spread over a realistic range rather than a single value. */
function ticket(rng: () => number): number {
  const bands = [20_000, 75_000, 250_000, 900_000, 4_000_000];
  return bands[(rng() * bands.length) | 0];
}

function simulateArm(n: number, trueRate: number, rng: () => number): MetricEvent[] {
  return Array.from({ length: n }, () => {
    const amountPaise = ticket(rng);
    const recovered = rng() < trueRate;
    return { amountPaise, recovered, recoveredPaise: recovered ? amountPaise : 0 };
  });
}

const empty = { events: [] as MetricEvent[], messagesSent: 0, costPaise: 0, customersContacted: 0 };

describe('interval coverage', () => {
  it('covers a planted effect close to 95% of the time', () => {
    const TRIALS = 120;
    const N_CONTROL = 400;
    const N_TREAT = 1200;
    const CONTROL_RATE = 0.1;
    const TREAT_RATE = 0.2;

    let covered = 0;
    let signCorrect = 0;

    for (let t = 0; t < TRIALS; t += 1) {
      const rng = mulberry32(1000 + t);
      const control = simulateArm(N_CONTROL, CONTROL_RATE, rng);
      const treat = simulateArm(N_TREAT, TREAT_RATE, rng);

      // The truth, in the same units the estimator reports: the treated
      // population's expected excess recovery over the control rate. Mean
      // ticket is identical by construction, so it is the rate gap × n × mean.
      const meanTicket =
        [...control, ...treat].reduce((s, e) => s + e.amountPaise, 0) / (N_CONTROL + N_TREAT);
      const truth = N_TREAT * (TREAT_RATE - CONTROL_RATE) * meanTicket;

      const m = computeMetrics(
        {
          control: { ...empty, events: control },
          naive: empty,
          leakproof: { ...empty, events: treat, messagesSent: N_TREAT, customersContacted: N_TREAT },
        },
        { bootstrapIterations: 250, bootstrapSeed: 7 + t },
      );

      const [lo, hi] = m.ci95_paise;
      if (lo <= truth && truth <= hi) covered += 1;
      if (m.incremental_paise > 0) signCorrect += 1;
    }

    const rate = covered / TRIALS;
    // Allowing 84–100%: with 120 trials the binomial noise around a true 95%
    // is itself a few points wide, and a percentile bootstrap is known to
    // under-cover slightly on skewed data. Anything below this band means the
    // interval is not doing its job.
    assert.ok(
      rate >= 0.84,
      `95% interval covered the truth only ${(rate * 100).toFixed(1)}% of ${TRIALS} trials`,
    );
    // A doubling of the recovery rate must never be reported as a loss.
    assert.equal(signCorrect, TRIALS, 'every trial should measure a positive effect');
  });

  it('does not manufacture an effect when there is none', () => {
    const TRIALS = 120;
    let falsePositives = 0;

    for (let t = 0; t < TRIALS; t += 1) {
      const rng = mulberry32(5000 + t);
      // Both arms drawn from the same distribution — the true effect is zero.
      const control = simulateArm(400, 0.12, rng);
      const treat = simulateArm(1200, 0.12, rng);

      const m = computeMetrics(
        {
          control: { ...empty, events: control },
          naive: empty,
          leakproof: { ...empty, events: treat, messagesSent: 1200, customersContacted: 1200 },
        },
        { bootstrapIterations: 250, bootstrapSeed: 7 + t },
      );

      if (m.powered) falsePositives += 1;
    }

    const rate = falsePositives / TRIALS;
    // A 95% interval should wrongly exclude zero about 5% of the time. Allow
    // headroom for noise, but a materially higher rate means the system would
    // routinely claim credit for nothing — the single most damaging failure
    // this project could have.
    assert.ok(
      rate <= 0.15,
      `claimed a powered result on ${(rate * 100).toFixed(1)}% of null experiments`,
    );
  });

  it('widens its interval rather than getting lucky when the control arm is thin', () => {
    const rng = mulberry32(99);
    const thin = simulateArm(40, 0.1, rng);
    const fat = simulateArm(2000, 0.1, rng);
    const treat = simulateArm(1200, 0.2, rng);

    const width = (ctrl: MetricEvent[]) => {
      const m = computeMetrics(
        {
          control: { ...empty, events: ctrl },
          naive: empty,
          leakproof: { ...empty, events: treat, messagesSent: 1200, customersContacted: 1200 },
        },
        { bootstrapIterations: 400, bootstrapSeed: 3 },
      );
      return m.ci95_paise[1] - m.ci95_paise[0];
    };

    assert.ok(width(thin) > width(fat), 'a 40-event control arm must produce a wider interval');
  });
});
