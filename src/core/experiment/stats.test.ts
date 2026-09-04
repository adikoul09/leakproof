import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  Z_95,
  bootstrapIncrementalPaise,
  mulberry32,
  normalCdf,
  normalQuantile,
  percentile,
  proportionDiffInterval,
  twoProportionZTest,
  wilsonInterval,
} from './stats';

const close = (actual: number, expected: number, tol = 1e-4, what = '') =>
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${what || 'value'}: expected ~${expected}, got ${actual}`,
  );

describe('normalCdf', () => {
  it('is 0.5 at the mean', () => close(normalCdf(0), 0.5, 1e-7));

  it('matches published values at the usual critical points', () => {
    close(normalCdf(1.959963984540054), 0.975, 1e-6, 'z=1.96');
    close(normalCdf(-1.959963984540054), 0.025, 1e-6, 'z=-1.96');
    close(normalCdf(2.5758293035489004), 0.995, 1e-6, 'z=2.576');
  });

  it('is symmetric', () => {
    for (const z of [0.3, 1, 2, 3]) close(normalCdf(z) + normalCdf(-z), 1, 1e-7);
  });
});

describe('wilsonInterval', () => {
  it('matches the published interval for 6 of 10', () => {
    // Textbook reference value: [0.3127, 0.8318].
    const i = wilsonInterval(6, 10);
    close(i.lo, 0.312674, 1e-5, 'lo');
    close(i.hi, 0.831814, 1e-5, 'hi');
  });

  it('stays inside [0,1] at zero successes, where the normal interval goes negative', () => {
    const i = wilsonInterval(0, 10);
    assert.equal(i.lo, 0);
    close(i.hi, 0.277542, 1e-5, 'hi'); // published 0.2775
  });

  it('stays inside [0,1] when every trial succeeds', () => {
    const i = wilsonInterval(10, 10);
    // The exact upper bound is 1; floating point lands a few ulps below it.
    // What matters is that it never exceeds 1.
    assert.ok(i.hi <= 1 && i.hi > 1 - 1e-12, `hi was ${i.hi}`);
    close(i.lo, 0.7225, 1e-4, 'lo'); // published 0.7225
  });

  it('narrows as n grows at a fixed rate', () => {
    const widths = [50, 500, 5000].map((n) => {
      const i = wilsonInterval(n / 10, n);
      return i.hi - i.lo;
    });
    assert.ok(widths[0] > widths[1] && widths[1] > widths[2], `widths were ${widths}`);
  });

  it('returns the whole range for an empty sample rather than dividing by zero', () => {
    assert.deepEqual(wilsonInterval(0, 0), { lo: 0, hi: 1 });
  });

  it('is symmetric under swapping successes and failures', () => {
    const a = wilsonInterval(3, 10);
    const b = wilsonInterval(7, 10);
    close(a.lo, 1 - b.hi, 1e-9);
    close(a.hi, 1 - b.lo, 1e-9);
  });
});

describe('proportionDiffInterval', () => {
  it('excludes zero for a large, real effect', () => {
    // The blueprint's illustrative arms: 418/1867 treated vs 61/541 control.
    const i = proportionDiffInterval(418, 1867, 61, 541);
    assert.ok(i.lo > 0, `interval should exclude 0, got [${i.lo}, ${i.hi}]`);
    // Point estimate must sit inside its own interval.
    const diff = 418 / 1867 - 61 / 541;
    assert.ok(i.lo < diff && diff < i.hi);
  });

  it('contains zero when the arms are identical', () => {
    const i = proportionDiffInterval(100, 1000, 100, 1000);
    assert.ok(i.lo < 0 && i.hi > 0, `expected to straddle 0, got [${i.lo}, ${i.hi}]`);
  });

  it('contains zero for a tiny sample even when the raw rates differ a lot', () => {
    // 2/5 vs 1/5 looks like a 20pp lift and means nothing.
    const i = proportionDiffInterval(2, 5, 1, 5);
    assert.ok(i.lo < 0 && i.hi > 0, `expected to straddle 0, got [${i.lo}, ${i.hi}]`);
  });

  it('handles an empty arm without producing a fake result', () => {
    assert.deepEqual(proportionDiffInterval(5, 10, 0, 0), { lo: -1, hi: 1 });
  });
});

describe('twoProportionZTest', () => {
  it('gives p = 1 when the rates are identical', () => {
    const r = twoProportionZTest(100, 1000, 100, 1000);
    close(r.z, 0, 1e-12);
    // ~1 up to the erf approximation's documented 1.5e-7 error, and crucially
    // never above 1 — a p-value greater than 1 on screen would rightly
    // destroy confidence in every other number on the page.
    assert.ok(r.pValue <= 1, `p must never exceed 1, got ${r.pValue}`);
    close(r.pValue, 1, 1e-6, 'p');
  });

  it('computes the z statistic for the blueprint arms', () => {
    const r = twoProportionZTest(418, 1867, 61, 541);
    close(r.z, 5.7016, 1e-3, 'z');
    assert.ok(r.pValue < 1e-6, `p should be tiny, got ${r.pValue}`);
  });

  it('is insensitive to which arm is which, up to sign', () => {
    const a = twoProportionZTest(418, 1867, 61, 541);
    const b = twoProportionZTest(61, 541, 418, 1867);
    close(a.z, -b.z, 1e-9);
    close(a.pValue, b.pValue, 1e-12);
  });

  it('does not divide by zero when nothing recovered anywhere', () => {
    const r = twoProportionZTest(0, 100, 0, 100);
    assert.equal(r.pValue, 1);
  });
});

describe('percentile', () => {
  const xs = [1, 2, 3, 4, 5];
  it('interpolates linearly between order statistics', () => {
    close(percentile(xs, 0), 1, 1e-12);
    close(percentile(xs, 1), 5, 1e-12);
    close(percentile(xs, 0.5), 3, 1e-12);
    close(percentile(xs, 0.25), 2, 1e-12);
  });
  it('survives degenerate inputs', () => {
    assert.equal(percentile([], 0.5), 0);
    assert.equal(percentile([7], 0.9), 7);
  });
});

describe('mulberry32', () => {
  it('is reproducible from a seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i += 1) assert.equal(a(), b());
  });

  it('produces different streams for different seeds', () => {
    assert.notEqual(mulberry32(1)(), mulberry32(2)());
  });

  it('stays in [0,1)', () => {
    const r = mulberry32(7);
    for (let i = 0; i < 10_000; i += 1) {
      const v = r();
      assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
    }
  });
});

describe('bootstrapIncrementalPaise', () => {
  // 1000 control events, 10% recover at ₹1,000. 1000 treated, 20% at ₹1,000.
  const ctrl = Array.from({ length: 1000 }, (_, i) => (i % 10 === 0 ? 100_000 : 0));
  const treat = Array.from({ length: 1000 }, (_, i) => (i % 5 === 0 ? 100_000 : 0));

  it('is deterministic for a given seed', () => {
    const a = bootstrapIncrementalPaise(treat, ctrl, { seed: 42, iterations: 500 });
    const b = bootstrapIncrementalPaise(treat, ctrl, { seed: 42, iterations: 500 });
    assert.deepEqual(a, b);
  });

  it('brackets the point estimate', () => {
    // 1000 × (0.20 − 0.10) × ₹1,000 = ₹100,000 = 10,000,000 paise.
    const i = bootstrapIncrementalPaise(treat, ctrl, { seed: 42 });
    assert.ok(i.lo < 10_000_000 && 10_000_000 < i.hi, `[${i.lo}, ${i.hi}] should contain 1e7`);
  });

  it('excludes zero for a real effect', () => {
    const i = bootstrapIncrementalPaise(treat, ctrl, { seed: 42 });
    assert.ok(i.lo > 0, `expected a positive lower bound, got ${i.lo}`);
  });

  it('contains zero when the arms are drawn from the same distribution', () => {
    const i = bootstrapIncrementalPaise(ctrl, [...ctrl], { seed: 42 });
    assert.ok(i.lo < 0 && i.hi > 0, `expected to straddle 0, got [${i.lo}, ${i.hi}]`);
  });

  it('widens when ticket sizes are heterogeneous, even at the same recovery rate', () => {
    // Same 20% rate, but one whale dominates the recovered value. An estimator
    // that multiplied a rate by a mean amount would report the same certainty
    // for both; resampling per-event values does not.
    const even = Array.from({ length: 1000 }, (_, i) => (i % 5 === 0 ? 100_000 : 0));
    const skewed = Array.from({ length: 1000 }, (_, i) =>
      i === 0 ? 19_900_000 : i % 5 === 0 ? 500 : 0,
    );
    const a = bootstrapIncrementalPaise(even, ctrl, { seed: 42 });
    const b = bootstrapIncrementalPaise(skewed, ctrl, { seed: 42 });
    assert.ok(b.hi - b.lo > a.hi - a.lo, 'skewed arm should produce a wider interval');
  });

  it('returns a zero interval rather than NaN when an arm is empty', () => {
    assert.deepEqual(bootstrapIncrementalPaise([], ctrl, { seed: 1 }), { lo: 0, hi: 0 });
  });

  it('uses the 95% level by default', () => {
    const wide = bootstrapIncrementalPaise(treat, ctrl, { seed: 42, alpha: 0.01 });
    const narrow = bootstrapIncrementalPaise(treat, ctrl, { seed: 42, alpha: 0.2 });
    assert.ok(wide.hi - wide.lo > narrow.hi - narrow.lo);
  });
});

describe('Z_95', () => {
  it('is the two-sided 95% critical value', () => close(normalCdf(Z_95), 0.975, 1e-6));
});

describe('p-value floor', () => {
  it('never reports p = 0, which no finite sample can support', () => {
    // An overwhelming effect: |z| well past where normalCdf saturates to 1.
    const r = twoProportionZTest(9000, 10_000, 100, 10_000);
    assert.ok(r.pValue > 0, `p must be positive, got ${r.pValue}`);
    assert.equal(r.pValue, 1e-16, 'should report the documented floor');
  });
});

describe('normalQuantile', () => {
  it('inverts normalCdf', () => {
    for (const p of [0.001, 0.025, 0.1, 0.5, 0.9, 0.975, 0.999]) {
      close(normalCdf(normalQuantile(p)), p, 1e-6, `round trip at p=${p}`);
    }
  });

  it('matches the standard critical values', () => {
    close(normalQuantile(0.975), 1.959963984540054, 1e-6);
    close(normalQuantile(0.5), 0, 1e-9);
  });
});
