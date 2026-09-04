import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ARM_SPLIT, assignArm } from './assign';
import { chooseRail, chooseRailNaive, RAIL_TABLE } from '@/core/routing/static-table';
import { FAILURE_CLASSES } from '@/core/triage/taxonomy';

const SALT = 'test-salt-not-the-real-one';

describe('assignArm', () => {
  it('is deterministic — the same event always lands in the same arm', () => {
    const a = assignArm('pay_ABC123', SALT);
    const b = assignArm('pay_ABC123', SALT);
    assert.deepEqual(a, b);
  });

  it('changes the arm when the salt changes, which is why the salt is frozen', () => {
    const buckets = new Set(
      ['salt-a', 'salt-b', 'salt-c'].map((s) => assignArm('pay_ABC123', s).bucket),
    );
    assert.ok(buckets.size > 1, 'salt must actually affect the bucket');
  });

  it('stores a hash input an auditor can recompute from', () => {
    assert.equal(assignArm('pay_X', SALT).hashInput, `pay_X${SALT}`);
  });

  it('splits close to 18 / 20 / 62 over a realistic batch', () => {
    const counts = { control: 0, naive: 0, leakproof: 0 };
    const n = 30_000;
    for (let i = 0; i < n; i += 1) counts[assignArm(`pay_SYN${i}`, SALT).arm] += 1;

    const pct = (k: keyof typeof counts) => (counts[k] / n) * 100;
    // ±1.5pp of the target split. Tighter than this would be testing the hash
    // function rather than the assignment logic.
    assert.ok(Math.abs(pct('control') - 18) < 1.5, `control was ${pct('control').toFixed(2)}%`);
    assert.ok(Math.abs(pct('naive') - 20) < 1.5, `naive was ${pct('naive').toFixed(2)}%`);
    assert.ok(Math.abs(pct('leakproof') - 62) < 1.5, `leakproof was ${pct('leakproof').toFixed(2)}%`);
  });

  it('has an arm split that covers every bucket exactly once', () => {
    assert.equal(ARM_SPLIT[ARM_SPLIT.length - 1].upto, 100);
    for (let b = 0; b < 100; b += 1) {
      const matches = ARM_SPLIT.filter((s, i) => b < s.upto && (i === 0 || b >= ARM_SPLIT[i - 1].upto));
      assert.equal(matches.length, 1, `bucket ${b} matched ${matches.length} arms`);
    }
  });
});

describe('rail routing', () => {
  it('has a routing entry for every failure class the taxonomy can emit', () => {
    // A missing entry would silently fall through to 'unknown' and route a
    // risk block to a payment link, which is exactly the wrong thing.
    for (const fc of FAILURE_CLASSES) {
      assert.ok(RAIL_TABLE[fc], `no rail routing for failure class '${fc}'`);
      assert.ok(RAIL_TABLE[fc].rails.length > 0, `empty rail list for '${fc}'`);
      assert.ok(RAIL_TABLE[fc].why.length > 10, `no rationale for '${fc}'`);
    }
  });

  it('never auto-retries a risk block', () => {
    // Auto-retrying a risk decline is how a merchant account gets flagged.
    assert.equal(chooseRail('risk_blocked', 1).rail, 'human_escalation');
    assert.equal(chooseRail('risk_blocked', 2).rail, 'do_nothing');
  });

  it('routes an issuer outage around the failing issuer, not back into it', () => {
    assert.equal(chooseRail('issuer_degraded', 1).rail, 'upi_payment_link');
  });

  it('delays rather than immediately retrying an insufficient-funds failure', () => {
    assert.equal(chooseRail('insufficient_funds', 1).rail, 'card_retry_delayed_payday');
  });

  it('falls off the end of the table to do_nothing rather than looping', () => {
    assert.equal(chooseRail('issuer_degraded', 99).rail, 'do_nothing');
  });

  it('records the alternatives it considered, for the decision trace', () => {
    const c = chooseRail('issuer_degraded', 1);
    assert.deepEqual(c.railScores.considered, ['upi_payment_link', 'netbanking_link', 'do_nothing']);
    assert.equal(c.chosenBy, 'static_table');
  });

  it('gives the naive arm one fixed rail regardless of failure class', () => {
    // This is the strawman the incrementality result has to beat.
    assert.equal(chooseRailNaive(1).rail, 'email_link');
    assert.equal(chooseRailNaive(3).rail, 'email_link');
    assert.equal(chooseRailNaive(4).rail, 'do_nothing');
    assert.equal(chooseRailNaive(1).chosenBy, 'naive_fixed');
  });
});

describe('bucket uniformity', () => {
  it('spreads ids evenly across all 100 buckets', () => {
    // The arm split is only as trustworthy as the hash underneath it. A hash
    // that clumped would silently bias the experiment in a way no downstream
    // test would catch — the arms would still look like 18/20/62.
    const N = 200_000;
    const buckets = new Array(100).fill(0);
    for (let i = 0; i < N; i += 1) buckets[assignArm(`pay_UNIF${i}`, SALT).bucket] += 1;

    const expected = N / 100;
    const chiSquare = buckets.reduce((s, o) => s + (o - expected) ** 2 / expected, 0);
    // 99 degrees of freedom: the 0.001 critical value is 148.2. Anything below
    // that is consistent with a uniform hash.
    assert.ok(chiSquare < 148.2, `chi-square ${chiSquare.toFixed(1)} suggests a non-uniform hash`);
    assert.ok(Math.min(...buckets) > 0, 'every bucket must be reachable');
  });
});
