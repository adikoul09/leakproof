import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateBreaker } from './breaker';
import { parseBreakerTrigger, parsePolicy } from './schema';

const BASE = `
policy_version: 3.2
contact_window: { start: "08:00", end: "19:00", tz: "Asia/Kolkata" }
caps:
  max_attempts_per_payment: 3
  max_contacts_per_customer_per_week: 2
  max_discount_offered_pct: 3.0
stop_on: [payment_success]
circuit_breaker: { trigger: "decline_rate_5min > 40%", action: halt_all_retries }
`;

const issuesOf = (src: string) => {
  const r = parsePolicy(src);
  assert.equal(r.ok, false, 'expected this policy to be rejected');
  return (r as Extract<typeof r, { ok: false }>).issues;
};

describe('parsePolicy', () => {
  it('accepts the live v3.2 policy', () => {
    const r = parsePolicy(BASE);
    assert.equal(r.ok, true);
    const { policy } = r as Extract<typeof r, { ok: true }>;
    assert.equal(policy.policy_version, '3.2');
    assert.equal(policy.windowStartMin, 480);
    assert.equal(policy.windowEndMin, 1140);
    assert.equal(policy.breaker.threshold, 0.4);
    // Defaults on, because a bank holiday is the common case worth respecting.
    assert.equal(policy.respect_bank_holidays, true);
  });

  it('reports a path with the message so the editor can put a squiggle on it', () => {
    const issues = issuesOf(BASE.replace('max_attempts_per_payment: 3', 'max_attempts_per_payment: 99'));
    assert.equal(issues[0].path, 'caps.max_attempts_per_payment');
  });

  it('rejects a non-integer attempts cap', () => {
    const issues = issuesOf(BASE.replace('max_attempts_per_payment: 3', 'max_attempts_per_payment: three'));
    assert.equal(issues[0].path, 'caps.max_attempts_per_payment');
  });

  it('rejects a window that ends before it starts', () => {
    const issues = issuesOf(BASE.replace('end: "19:00"', 'end: "07:00"'));
    assert.equal(issues[0].path, 'contact_window.end');
  });

  it('rejects a malformed clock time', () => {
    const issues = issuesOf(BASE.replace('start: "08:00"', 'start: "25:00"'));
    assert.equal(issues[0].path, 'contact_window.start');
  });

  it('rejects an unknown stop condition rather than ignoring it', () => {
    // Silently dropping an unrecognised stop condition would be the dangerous
    // failure: the operator believes recovery halts on it, and it never does.
    const issues = issuesOf(BASE.replace('[payment_success]', '[payment_success, chargeback_filed]'));
    assert.equal(issues[0].path, 'stop_on.1');
  });

  it('surfaces YAML syntax errors as a root-level issue', () => {
    const issues = issuesOf('policy_version: 3.2\n  bad indent: [');
    assert.equal(issues[0].path, '');
    assert.match(issues[0].message, /YAML did not parse/);
  });

  it('rejects a breaker trigger it cannot parse, at authoring time', () => {
    // The gate must never meet an expression it has to interpret at runtime.
    const issues = issuesOf(BASE.replace('decline_rate_5min > 40%', 'if declines are bad then stop'));
    assert.equal(issues[0].path, 'circuit_breaker.trigger');
  });

  it('rejects a breaker trigger naming an unknown metric', () => {
    const issues = issuesOf(BASE.replace('decline_rate_5min', 'vibes_index'));
    assert.match(issues[0].message, /unknown metric/);
  });
});

describe('parseBreakerTrigger', () => {
  it('normalises a percentage to a proportion', () => {
    assert.equal(parseBreakerTrigger('decline_rate_5min > 40%').threshold, 0.4);
  });

  it('accepts a bare proportion too', () => {
    assert.equal(parseBreakerTrigger('decline_rate_5min > 0.4').threshold, 0.4);
  });

  it('preserves the author’s text for display', () => {
    assert.equal(parseBreakerTrigger('decline_rate_15min >= 55%').source, 'decline_rate_15min >= 55%');
  });
});

describe('evaluateBreaker', () => {
  const trigger = parseBreakerTrigger('decline_rate_5min > 40%');

  it('opens above the threshold', () => {
    assert.equal(evaluateBreaker(trigger, 0.41).shouldOpen, true);
  });

  it('stays closed exactly at the threshold, because the operator wrote ">"', () => {
    assert.equal(evaluateBreaker(trigger, 0.4).shouldOpen, false);
  });

  it('explains itself in the units a human wrote', () => {
    assert.match(evaluateBreaker(trigger, 0.41).explanation, /41\.0% > 40\.0% → OPEN/);
  });
});
