import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { type BatchSpec, generateBatch } from './generate';
import { HOURLY_VOLUME } from './profile';
import { assignArm } from '@/core/experiment/assign';

const SALT = 'test-salt-not-the-real-one';
const ENDS_AT = new Date('2026-09-04T18:30:00+05:30');

const spec = (over: Partial<BatchSpec> = {}): BatchSpec => ({
  count: 2000,
  seed: 424242,
  windowHours: 24,
  endsAt: ENDS_AT,
  injectOutage: { issuer: 'HDFC', method: 'card', durationMin: 90, spikePct: 62 },
  organicRecoveryRate: 0.11,
  adversarialPct: 0.05,
  paydayStrength: 0.8,
  treatmentResponse: { naiveUpliftPp: 0.04, leakproofUpliftPp: 0.14, armSalt: SALT },
  ...over,
});

const digest = (b: ReturnType<typeof generateBatch>) =>
  createHash('sha256').update(JSON.stringify(b.events)).digest('hex');

describe('reproducibility', () => {
  it('is byte-identical for the same spec — the whole point of storing the seed', () => {
    assert.equal(digest(generateBatch(spec())), digest(generateBatch(spec())));
  });

  it('produces a different corpus for a different seed', () => {
    assert.notEqual(digest(generateBatch(spec())), digest(generateBatch(spec({ seed: 999 }))));
  });

  it('never leaks the arm salt into the spec it echoes back', () => {
    const s = JSON.stringify(generateBatch(spec()).spec);
    assert.ok(!s.includes(SALT), 'the salt is a secret and the spec is served to the browser');
  });
});

describe('batch size', () => {
  it('lands exactly on the requested baseline failure count', () => {
    for (const count of [500, 2000, 3000]) {
      const b = generateBatch(spec({ count }));
      assert.equal(b.summary.baselineFailed, count);
    }
  });

  it('adds the outage’s failures on top rather than stealing from the target', () => {
    const withOutage = generateBatch(spec());
    const without = generateBatch(spec({ injectOutage: null }));
    assert.equal(withOutage.summary.baselineFailed, without.summary.baselineFailed);
    assert.ok(withOutage.summary.outageFailed > 0);
    assert.ok(withOutage.summary.failed > without.summary.failed);
  });

  it('keeps the rebalance small enough not to distort the decline rate', () => {
    const b = generateBatch(spec());
    const shift = Math.abs(b.summary.rebalancedBy) / b.summary.attempts;
    assert.ok(shift < 0.005, `rebalance moved the decline rate by ${(shift * 100).toFixed(2)}pp`);
  });
});

describe('distribution shape', () => {
  it('has a heavy tail — the p99 ticket is many times the median', () => {
    const p = generateBatch(spec()).summary.amountPercentilesPaise;
    assert.ok(p.p99 / p.p50 > 15, `p99/p50 was only ${(p.p99 / p.p50).toFixed(1)}×`);
    assert.ok(p.max > p.p99 * 2, 'the extreme tail should run well past the p99');
  });

  it('follows the diurnal curve — the small hours are quiet', () => {
    const b = generateBatch(spec());
    const byHour = new Array(24).fill(0);
    for (const e of b.events) {
      byHour[new Date(new Date(e.failed_at).getTime() + 330 * 60_000).getUTCHours()] += 1;
    }
    const quiet = byHour[2] + byHour[3] + byHour[4];
    const busy = byHour[18] + byHour[19] + byHour[20];
    assert.ok(busy > quiet * 5, `evening ${busy} vs overnight ${quiet}`);
    assert.equal(HOURLY_VOLUME.length, 24);
  });
});

describe('injected outage', () => {
  it('drives the degraded cohort’s decline rate to roughly the requested spike', () => {
    const b = generateBatch(spec());
    const gt = b.groundTruth.outage!;
    const from = Date.parse(gt.startedAt);
    const to = Date.parse(gt.endedAt);
    const inWindow = b.events.filter((e) => {
      const t = Date.parse(e.failed_at);
      return e.issuer === 'HDFC' && e.method === 'card' && t >= from && t < to && !e.order_id?.startsWith('order_S') === false;
    });
    // Recoveries carry an order id and are not attempts; count only the
    // original attempts, which are every failure plus every plain success.
    const attempts = b.events.filter((e) => {
      const t = Date.parse(e.failed_at);
      const isRecovery = e.outcome === 'succeeded' && e.order_id !== null;
      return e.issuer === 'HDFC' && e.method === 'card' && t >= from && t < to && !isRecovery;
    });
    const failed = attempts.filter((e) => e.outcome === 'failed').length;
    const rate = failed / attempts.length;
    assert.ok(attempts.length > 30, `only ${attempts.length} attempts in the window`);
    assert.ok(Math.abs(rate - 0.62) < 0.12, `outage decline rate was ${rate.toFixed(3)}`);
    assert.ok(inWindow.length > 0);
  });

  it('does not label coincident customer failures as systemic', () => {
    const gt = generateBatch(spec()).groundTruth.outage!;
    assert.ok(
      gt.coincidentIdiosyncraticIds.length > 0,
      'a real outage window still contains ordinary failures; without them precision is free',
    );
    const overlap = gt.systemicEventIds.filter((id) => gt.coincidentIdiosyncraticIds.includes(id));
    assert.equal(overlap.length, 0);
  });

  it('plants no systemic events at all when no outage is injected', () => {
    const b = generateBatch(spec({ injectOutage: null }));
    assert.equal(b.groundTruth.outage, null);
    assert.equal(b.groundTruth.systemicEventIds.length, 0);
  });
});

describe('organic recovery', () => {
  it('threads a recovery to its failure by order id, with a NEW payment id', () => {
    const b = generateBatch(spec());
    const failures = new Map(
      b.events.filter((e) => e.outcome === 'failed').map((e) => [e.order_id, e]),
    );
    const recoveries = b.events.filter((e) => e.outcome === 'succeeded' && e.order_id);
    assert.ok(recoveries.length > 50, `only ${recoveries.length} recoveries`);
    for (const r of recoveries) {
      const f = failures.get(r.order_id);
      assert.ok(f, `recovery ${r.id} has no failure on order ${r.order_id}`);
      assert.notEqual(r.id, f!.id, 'Razorpay issues a new payment id for a retry');
      assert.equal(r.amount_paise, f!.amount_paise);
    }
  });

  it('leaves plain denominator successes unthreaded', () => {
    const b = generateBatch(spec());
    const plain = b.events.filter((e) => e.outcome === 'succeeded' && !e.order_id);
    assert.ok(plain.length > b.summary.failed, 'the denominator should dwarf the failures');
  });

  it('censors recoveries that would land after the window closes', () => {
    const b = generateBatch(spec());
    assert.ok(b.summary.censoredRecoveries > 0, 'a real corpus is censored at its right edge');
    for (const e of b.events) {
      assert.ok(Date.parse(e.failed_at) <= ENDS_AT.getTime(), `${e.id} lands after the window`);
    }
  });
});

describe('planted treatment effect', () => {
  it('knows the counterfactual, so ground truth is not a sample statistic', () => {
    const b = generateBatch(spec());
    const lp = b.groundTruth.armOutcomes.leakproof;
    assert.equal(b.groundTruth.trueIncrementalRecoveries, lp.causedByTreatment);
    assert.equal(b.groundTruth.trueIncrementalPaise, lp.causedByTreatmentPaise);
    // 14pp uplift over ~1,300 treated events, minus a few percent of censoring.
    const share = lp.causedByTreatment / lp.n;
    assert.ok(Math.abs(share - 0.14) < 0.03, `caused-by-treatment share was ${share.toFixed(3)}`);
  });

  it('never attributes a control recovery to treatment', () => {
    const c = generateBatch(spec()).groundTruth.armOutcomes.control;
    assert.equal(c.causedByTreatment, 0);
    assert.equal(c.causedByTreatmentPaise, 0);
  });

  it('assigns arms with the real hash, so the split matches the live system', () => {
    const b = generateBatch(spec());
    // Deduplicate: a duplicate delivery emits the same failure twice, and it is
    // one at-risk unit in one arm, not two.
    const failures = [
      ...new Set(b.events.filter((e) => e.outcome === 'failed').map((e) => e.id)),
    ];
    const counted = { control: 0, naive: 0, leakproof: 0 };
    for (const id of failures) counted[assignArm(id, SALT).arm] += 1;
    assert.equal(counted.control, b.groundTruth.armOutcomes.control.n);
    assert.equal(counted.naive, b.groundTruth.armOutcomes.naive.n);
    assert.equal(counted.leakproof, b.groundTruth.armOutcomes.leakproof.n);
  });

  it('plants exactly nothing in A/A mode — the test that catches a broken estimator', () => {
    const b = generateBatch(spec({ treatmentResponse: null }));
    assert.equal(b.groundTruth.realisedLiftPp, null);
    assert.equal(b.groundTruth.trueIncrementalPaise, null);
    // Every arm draws from the same rate, so recovery cannot correlate with arm.
    const byArm = { control: { n: 0, r: 0 }, naive: { n: 0, r: 0 }, leakproof: { n: 0, r: 0 } };
    const recovered = new Set(
      b.events.filter((e) => e.outcome === 'succeeded' && e.order_id).map((e) => e.order_id),
    );
    for (const f of b.events.filter((e) => e.outcome === 'failed')) {
      const a = byArm[assignArm(f.id, SALT).arm];
      a.n += 1;
      if (recovered.has(f.order_id)) a.r += 1;
    }
    const rate = (x: { n: number; r: number }) => x.r / x.n;
    const spread = Math.max(rate(byArm.control), rate(byArm.naive), rate(byArm.leakproof)) -
      Math.min(rate(byArm.control), rate(byArm.naive), rate(byArm.leakproof));
    assert.ok(spread < 0.05, `A/A arms drifted apart by ${(spread * 100).toFixed(1)}pp`);
  });
});

describe('adversarial cases', () => {
  it('hits the requested share, split across every hostile kind', () => {
    const b = generateBatch(spec({ adversarialPct: 0.2 }));
    const total = Object.values(b.summary.adversarial).reduce((a, x) => a + x, 0);
    assert.equal(total, Math.round(b.summary.failed * 0.2));
    for (const [kind, n] of Object.entries(b.summary.adversarial)) {
      assert.ok(n > 0, `${kind} never occurred`);
    }
  });

  it('emits duplicate deliveries byte-identically', () => {
    const b = generateBatch(spec({ adversarialPct: 0.2 }));
    const seen = new Map<string, number>();
    for (const e of b.events) {
      if (e.outcome !== 'failed') continue;
      seen.set(e.id, (seen.get(e.id) ?? 0) + 1);
    }
    const dupes = [...seen.values()].filter((n) => n > 1).length;
    assert.equal(dupes, b.summary.adversarial.duplicate_delivery);
  });

  it('emits some recoveries before the failure they resolve', () => {
    const b = generateBatch(spec({ adversarialPct: 0.2 }));
    const position = new Map<string, number>();
    b.events.forEach((e, i) => {
      if (!position.has(e.id)) position.set(e.id, i);
    });
    let outOfOrder = 0;
    for (const e of b.events) {
      if (e.outcome !== 'succeeded' || !e.order_id) continue;
      const failure = b.events.find((f) => f.outcome === 'failed' && f.order_id === e.order_id);
      if (failure && position.get(e.id)! < position.get(failure.id)!) outOfOrder += 1;
    }
    assert.equal(outOfOrder, b.summary.adversarial.out_of_order_recovery);
  });

  it('only opts out customers who actually appear in the corpus', () => {
    const b = generateBatch(spec());
    const known = new Set(b.events.map((e) => e.customer_id).filter(Boolean));
    for (const p of b.optedOutCustomers) assert.ok(known.has(p.id), `${p.id} is not in the corpus`);
    assert.ok(b.optedOutCustomers.length > 0);
  });
});

/**
 * The guard that matters most.
 *
 * The generator's whole claim is that its output is indistinguishable from a
 * normalised webhook. If it emits a field the ingest route rejects, a batch
 * fails silently at 3am and the dashboard shows a confidently empty tower. This
 * is a copy of the route's schema, asserted against every event.
 */
const ingestSchema = z.object({
  id: z.string().min(1),
  surface: z.enum(['payment', 'subscription', 'invoice']).default('payment'),
  customer_id: z.string().min(1).optional(),
  amount_paise: z.number().int().nonnegative(),
  currency: z.string().default('INR'),
  method: z.string().nullable().optional(),
  issuer: z.string().nullable().optional(),
  card_network: z.string().nullable().optional(),
  order_id: z.string().nullable().optional(),
  err_code: z.string().nullable().optional(),
  err_description: z.string().nullable().optional(),
  err_source: z.string().nullable().optional(),
  err_step: z.string().nullable().optional(),
  err_reason: z.string().nullable().optional(),
  failed_at: z.iso.datetime({ offset: true }),
  outcome: z.enum(['failed', 'succeeded']).default('failed'),
});

describe('ingest compatibility', () => {
  it('emits nothing POST /api/events/ingest would reject', () => {
    const b = generateBatch(spec({ count: 500, adversarialPct: 0.2 }));
    for (const e of b.events) {
      const r = ingestSchema.safeParse(e);
      assert.ok(r.success, `${e.id}: ${r.success ? '' : JSON.stringify(r.error.issues)}`);
    }
  });

  it('gives every failure the fields the classifier reads', () => {
    for (const e of generateBatch(spec({ count: 500 })).events) {
      if (e.outcome !== 'failed') continue;
      assert.ok(e.customer_id, `${e.id} has no customer — the contact caps cannot bind`);
      assert.ok(e.order_id, `${e.id} has no order — organic recovery cannot be matched`);
      assert.ok(e.amount_paise > 0);
      assert.ok(Number.isInteger(e.amount_paise), 'money is integer paise');
    }
  });
});
