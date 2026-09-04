import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MIN_CONTROL_N, computeMetrics, type ArmsInput, type MetricEvent } from './metrics';

/** n events of which exactly `recoveredCount` recover, each at `ticket` paise. */
function arm(n: number, recoveredCount: number, ticket = 100_000): MetricEvent[] {
  return Array.from({ length: n }, (_, i) => {
    const recovered = i < recoveredCount;
    return { amountPaise: ticket, recovered, recoveredPaise: recovered ? ticket : 0 };
  });
}

function arms(over: Partial<Record<keyof ArmsInput, Partial<ArmsInput['control']>>> = {}): ArmsInput {
  const base = (events: MetricEvent[], messagesSent = 0, costPaise = 0, customers = 0) => ({
    events,
    messagesSent,
    costPaise,
    customersContacted: customers,
  });
  return {
    // 10% organic recovery, never contacted.
    control: { ...base(arm(1000, 100)), ...over.control },
    // 15%, contacted once each.
    naive: { ...base(arm(1000, 150), 1000, 4000, 1000), ...over.naive },
    // 25%, contacted ~2.5 times each.
    leakproof: { ...base(arm(2000, 500), 5000, 100_000, 2000), ...over.leakproof },
  };
}

describe('computeMetrics — arm summaries', () => {
  const m = computeMetrics(arms());

  it('counts each arm', () => {
    assert.equal(m.arms.control.n, 1000);
    assert.equal(m.arms.control.recovered, 100);
    assert.equal(m.arms.leakproof.n, 2000);
    assert.equal(m.arms.leakproof.recovered, 500);
  });

  it('reports a rate with its own confidence interval', () => {
    assert.equal(m.arms.control.recovery_rate, 0.1);
    const [lo, hi] = m.arms.control.recovery_rate_ci95;
    assert.ok(lo < 0.1 && 0.1 < hi, `[${lo}, ${hi}] should contain 0.1`);
  });

  it('sums gross recovery in paise', () => {
    assert.equal(m.arms.control.gross_paise, 100 * 100_000);
    assert.equal(m.arms.leakproof.gross_paise, 500 * 100_000);
  });
});

describe('computeMetrics — the incrementality result', () => {
  const m = computeMetrics(arms());

  it('measures against the control arm, not against gross', () => {
    // Gross in leakproof is 500 × ₹1,000 = ₹500,000. But 10% would have
    // recovered anyway, so only 15pp of 2000 events is ours:
    // 2000 × (0.25 − 0.10) × ₹1,000 = ₹300,000 = 30,000,000 paise.
    assert.equal(m.incremental_paise, 30_000_000);
    // And that is well below the gross figure a dunning tool would claim.
    assert.ok(m.incremental_paise < m.arms.leakproof.gross_paise);
  });

  it('brackets the estimate with a bootstrap interval that excludes zero', () => {
    const [lo, hi] = m.ci95_paise;
    assert.ok(lo < m.incremental_paise && m.incremental_paise < hi, `[${lo}, ${hi}]`);
    assert.ok(lo > 0, `lower bound should exclude zero, got ${lo}`);
  });

  it('agrees with the blueprint decomposition when tickets are uniform', () => {
    // The two estimators coincide exactly when every recovered amount is equal.
    assert.equal(m.incremental_paise_rate_times_mean, m.incremental_paise);
  });

  it('reports lift in percentage points against both comparators', () => {
    assert.ok(Math.abs(m.lift_vs_control_pp - 15) < 1e-9);
    assert.ok(Math.abs(m.lift_vs_naive_pp - 10) < 1e-9);
    const [lo, hi] = m.lift_vs_control_ci95_pp;
    assert.ok(lo > 0 && lo < 15 && 15 < hi, `[${lo}, ${hi}] should exclude 0 and contain 15`);
  });

  it('is powered when the interval excludes zero and control is large enough', () => {
    assert.equal(m.powered, true);
    assert.deepEqual(m.power_blockers, []);
    assert.ok(m.p_value < 0.001);
  });

  it('is reproducible — same input, same interval, forever', () => {
    const a = computeMetrics(arms());
    const b = computeMetrics(arms());
    assert.deepEqual(a.ci95_paise, b.ci95_paise);
    assert.equal(a.provenance.bootstrap_seed, 42);
    assert.equal(a.provenance.bootstrap_iterations, 2000);
  });
});

describe('computeMetrics — refusing to overclaim', () => {
  it('is not powered when the control arm is too small, however good it looks', () => {
    const m = computeMetrics(
      arms({ control: { events: arm(50, 5), messagesSent: 0, costPaise: 0, customersContacted: 0 } }),
    );
    assert.equal(m.powered, false);
    assert.match(m.power_blockers.join(' '), new RegExp(String(MIN_CONTROL_N)));
  });

  it('is not powered when the interval still contains zero', () => {
    // Identical arms: no effect to find.
    const m = computeMetrics(
      arms({ leakproof: { events: arm(1000, 100), messagesSent: 500, costPaise: 1000, customersContacted: 1000 } }),
    );
    assert.equal(m.powered, false);
    assert.match(m.power_blockers.join(' '), /contains zero/);
  });

  it('reports harm as harm, and still calls the experiment powered', () => {
    const m = computeMetrics(
      arms({ leakproof: { events: arm(1000, 50), messagesSent: 500, costPaise: 1000, customersContacted: 1000 } }),
    );
    // 5% treated vs 10% control. The system actively made things worse.
    assert.ok(m.incremental_paise < 0, 'a losing arm must report a negative number, not zero');
    // 'powered' means the experiment can support a conclusion — not that the
    // conclusion is flattering. Reporting an adequately-powered harmful result
    // as "not powered" would be the dishonest reading.
    assert.equal(m.powered, true);
    assert.ok(m.ci95_paise[1] < 0, 'the whole interval should sit below zero');
    assert.equal(m.cost_per_100_recovered_paise, 0, 'cost per ₹100 is undefined when nothing is incremental');
  });

  it('survives an empty control arm without inventing a result', () => {
    const m = computeMetrics(
      arms({ control: { events: [], messagesSent: 0, costPaise: 0, customersContacted: 0 } }),
    );
    assert.equal(m.incremental_paise, 0);
    assert.deepEqual(m.ci95_paise, [0, 0]);
    assert.equal(m.powered, false);
  });

  it('survives a completely empty experiment', () => {
    const empty = { events: [], messagesSent: 0, costPaise: 0, customersContacted: 0 };
    const m = computeMetrics({ control: empty, naive: empty, leakproof: empty });
    assert.equal(m.incremental_paise, 0);
    assert.equal(m.powered, false);
    assert.equal(m.false_nudge_rate, 0);
  });
});

describe('computeMetrics — the honesty checks', () => {
  it('flags an unbalanced split rather than letting a judge find it', () => {
    const m = computeMetrics(
      arms({
        // Same recovery rate, but the control arm holds far smaller tickets —
        // which would mean the hash split is not clean.
        control: { events: arm(1000, 10, 10_000), messagesSent: 0, costPaise: 0, customersContacted: 0 },
      }),
    );
    assert.equal(m.balance.balanced, false);
    assert.ok(m.balance.mean_ticket_spread_pct > 15);
  });

  it('passes the balance check when arms carry comparable tickets', () => {
    assert.equal(computeMetrics(arms()).balance.balanced, true);
  });

  it('computes the false-nudge rate per message sent, not per event', () => {
    const m = computeMetrics(arms());
    // (3000 contacted events × 0.10 control rate) / 6000 messages = 0.05
    assert.ok(Math.abs(m.false_nudge_rate - 0.05) < 1e-9, `got ${m.false_nudge_rate}`);
  });

  it('prices spend against incremental revenue, not gross', () => {
    const m = computeMetrics(arms());
    // ₹1,040 spent for ₹300,000 incremental → 104000/(30000000/10000) = ~34.7 paise per ₹100.
    assert.equal(m.cost_per_100_recovered_paise, 35);
  });

  it('reports the contact budget against a cap derived from the policy', () => {
    const m = computeMetrics(arms(), { weeklyContactCap: 2 });
    assert.equal(m.contact_budget.used, 6000);
    assert.equal(m.contact_budget.cap, 2 * 3000);
  });
});

describe('computeMetrics — heterogeneous tickets', () => {
  it('diverges from the blueprint decomposition when recovered amounts differ by arm', () => {
    // Treated recovers small tickets, control recovers large ones. Multiplying
    // a rate difference by a pooled mean amount hides this; carrying the
    // amount per event does not.
    const m = computeMetrics({
      control: { events: arm(1000, 100, 500_000), messagesSent: 0, costPaise: 0, customersContacted: 0 },
      naive: { events: [], messagesSent: 0, costPaise: 0, customersContacted: 0 },
      leakproof: { events: arm(1000, 250, 50_000), messagesSent: 2000, costPaise: 5000, customersContacted: 1000 },
    });
    assert.notEqual(m.incremental_paise, m.incremental_paise_rate_times_mean);
    // Treated recovers 250 × ₹500 = ₹125,000; control's per-event rate would
    // have produced 1000 × 0.1 × ₹5,000 = ₹500,000. So this is a real loss,
    // even though the recovery *rate* is 2.5× better.
    assert.ok(m.incremental_paise < 0, 'a rate win with a value loss must show as a loss');
  });
});
