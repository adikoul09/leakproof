import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluatePolicy, type PolicyContext } from './evaluate';
import { parsePolicy, type Policy } from './schema';

const YAML = `
policy_version: 3.2
contact_window:
  start: "08:00"
  end:   "19:00"
  tz:    "Asia/Kolkata"
caps:
  max_attempts_per_payment:           3
  max_contacts_per_customer_per_week: 2
  max_discount_offered_pct:           3.0
stop_on:
  - payment_success
  - customer_opt_out
  - complaint_keyword_detected
  - refund_issued
circuit_breaker:
  trigger: "decline_rate_5min > 40%"
  action:  halt_all_retries
`;

function policy(): Policy {
  const parsed = parsePolicy(YAML);
  assert.equal(parsed.ok, true, 'fixture policy must parse');
  return (parsed as Extract<typeof parsed, { ok: true }>).policy;
}

/** 2026-09-04 14:22 IST — a Friday, inside the window. */
const INSIDE = new Date('2026-09-04T08:52:00Z');

function ctx(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    now: INSIDE,
    breakerOpen: false,
    customerOptedOut: false,
    firedStopConditions: [],
    attemptsSoFar: 0,
    contactsThisWeek: 0,
    bankHolidays: new Set<string>(),
    proposedDiscountPct: 0,
    ...over,
  };
}

const ruleNames = (d: ReturnType<typeof evaluatePolicy>) => d.rulesTrace.map((r) => r.rule);

describe('evaluatePolicy', () => {
  it('allows an in-window contact that is under every cap', () => {
    const d = evaluatePolicy(policy(), ctx());
    assert.equal(d.result, 'allow');
    assert.equal(d.gateResult, 'allow:contact_window,under_caps');
    // Every rule is reported on the happy path, so the trace is a full receipt.
    assert.deepEqual(ruleNames(d), [
      'circuit_breaker',
      'customer_opt_out',
      'stop_on',
      'max_attempts_per_payment',
      'max_contacts_per_customer_per_week',
      'bank_holiday',
      'contact_window',
      'max_discount_offered_pct',
    ]);
    assert.ok(d.rulesTrace.every((r) => r.pass));
  });

  it('short-circuits on the first block so the trace stays readable', () => {
    const d = evaluatePolicy(policy(), ctx({ breakerOpen: true, breakerReason: 'HDFC|card' }));
    assert.equal(d.result, 'block');
    assert.equal(d.gateResult, 'block:breaker_open');
    // Nothing after the breaker is evaluated — that is the point of ordering.
    assert.deepEqual(ruleNames(d), ['circuit_breaker']);
  });

  it('blocks an opted-out customer before consulting anything else', () => {
    const d = evaluatePolicy(policy(), ctx({ customerOptedOut: true }));
    assert.equal(d.gateResult, 'block:opted_out');
    assert.deepEqual(ruleNames(d), ['circuit_breaker', 'customer_opt_out']);
  });

  it('blocks when a stop condition has fired', () => {
    const d = evaluatePolicy(policy(), ctx({ firedStopConditions: ['payment_success'] }));
    assert.equal(d.gateResult, 'block:stop_on_fired');
    assert.match(d.reasons[0], /payment_success/);
  });

  it('blocks at the attempts cap, not one attempt past it', () => {
    assert.equal(evaluatePolicy(policy(), ctx({ attemptsSoFar: 2 })).result, 'allow');
    const d = evaluatePolicy(policy(), ctx({ attemptsSoFar: 3 }));
    assert.equal(d.gateResult, 'block:cap_exceeded');
    assert.match(d.reasons[0], /3 of 3/);
  });

  it('blocks at the weekly contact cap', () => {
    assert.equal(evaluatePolicy(policy(), ctx({ contactsThisWeek: 1 })).result, 'allow');
    const d = evaluatePolicy(policy(), ctx({ contactsThisWeek: 2 }));
    assert.equal(d.gateResult, 'block:cap_exceeded');
  });

  it('blocks a discount above the granted authority', () => {
    assert.equal(evaluatePolicy(policy(), ctx({ proposedDiscountPct: 3 })).result, 'allow');
    const d = evaluatePolicy(policy(), ctx({ proposedDiscountPct: 3.5 }));
    assert.equal(d.gateResult, 'block:discount_cap_exceeded');
  });
});

describe('contact window', () => {
  it('defers to this morning when the attempt lands before the window opens', () => {
    // 2026-09-04 06:00 IST
    const d = evaluatePolicy(policy(), ctx({ now: new Date('2026-09-04T00:30:00Z') }));
    assert.equal(d.result, 'defer');
    assert.equal(d.deferUntil, '2026-09-04T08:00:00+05:30');
    assert.equal(d.gateResult, 'defer:next_window@2026-09-04T08:00:00+05:30');
  });

  it('defers to tomorrow morning when the window has closed for the day', () => {
    // 2026-09-04 22:00 IST
    const d = evaluatePolicy(policy(), ctx({ now: new Date('2026-09-04T16:30:00Z') }));
    assert.equal(d.result, 'defer');
    assert.equal(d.deferUntil, '2026-09-05T08:00:00+05:30');
  });

  it('reports the local time in the policy timezone, not the server timezone', () => {
    const d = evaluatePolicy(policy(), ctx());
    const window = d.rulesTrace.find((r) => r.rule === 'contact_window');
    assert.equal(window?.actual, '14:22 Asia/Kolkata');
    assert.equal(window?.expected, '08:00-19:00 Asia/Kolkata');
  });
});

describe('bank holidays', () => {
  it('defers past a holiday rather than blocking — the payment is still recoverable', () => {
    const d = evaluatePolicy(
      policy(),
      ctx({ bankHolidays: new Set(['2026-09-04']) }),
    );
    assert.equal(d.result, 'defer');
    assert.equal(d.deferUntil, '2026-09-05T08:00:00+05:30');
    assert.match(d.reasons[0], /bank holiday/);
  });

  it('skips consecutive holidays to find the next working day', () => {
    const d = evaluatePolicy(
      policy(),
      ctx({ bankHolidays: new Set(['2026-09-04', '2026-09-05', '2026-09-06']) }),
    );
    assert.equal(d.deferUntil, '2026-09-07T08:00:00+05:30');
  });

  it('blocks rather than deferring into a date that never arrives', () => {
    const everyDay = new Set<string>();
    for (let i = 0; i < 40; i += 1) {
      const d = new Date(Date.UTC(2026, 8, 4 + i));
      everyDay.add(d.toISOString().slice(0, 10));
    }
    const d = evaluatePolicy(policy(), ctx({ bankHolidays: everyDay }));
    assert.equal(d.result, 'block');
    assert.equal(d.gateResult, 'block:outside_window');
  });

  it('a block still wins over a defer', () => {
    // Outside the window (would defer) AND over the discount cap (must block).
    const d = evaluatePolicy(
      policy(),
      ctx({ now: new Date('2026-09-04T16:30:00Z'), proposedDiscountPct: 50 }),
    );
    assert.equal(d.result, 'block');
    assert.equal(d.gateResult, 'block:discount_cap_exceeded');
  });
});
