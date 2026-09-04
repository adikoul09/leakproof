import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MDR_EFFECTIVE_RATE,
  RATES,
  costOf,
  mdrOnRecoveredPaise,
  unpricedItems,
} from './meter';

describe('cost meter', () => {
  it('prices messaging at zero, because nothing is billed per message', () => {
    // Delivery is Razorpay's own notification on the payment link. There is no
    // SMS gateway and no email provider under contract, so there is genuinely
    // nothing to charge — this is an architectural consequence of how the rails
    // were built, not a number rounded down to look good.
    assert.equal(costOf('sms_message'), 0);
    assert.equal(costOf('email_message'), 0);
    assert.equal(costOf('whatsapp_utility_message'), 0);
    assert.equal(costOf('llm_compose'), 0);
    assert.equal(costOf('payment_link_created'), 0);
  });

  it('says why each zero is zero, so nobody has to assume', () => {
    for (const item of ['sms_message', 'email_message', 'llm_compose'] as const) {
      assert.ok(RATES[item].source.length > 20, `${item} needs a real source line`);
      assert.ok(!RATES[item].source.includes('PLACEHOLDER'));
    }
  });

  it('still flags the one rate that is genuinely a guess', () => {
    // Human escalation is real money and remains unpriced. Zeroing messaging
    // must not quietly zero the honesty of the rest of the table.
    assert.ok(unpricedItems().includes('human_escalation'));
    assert.ok(costOf('human_escalation') > 0);
  });

  it('keeps MDR as a rate on captured money, not a per-attempt cost', () => {
    // 2% + 18% GST on the fee = 2.36% of the captured amount.
    assert.ok(Math.abs(MDR_EFFECTIVE_RATE - 0.0236) < 1e-9);
    assert.equal(mdrOnRecoveredPaise(100_00), 236);
    // It is charged on success only: nothing recovered, nothing owed.
    assert.equal(mdrOnRecoveredPaise(0), 0);
  });

  it('does not let MDR leak into the per-attempt table', () => {
    // If it ever appears in RATES it will be summed into cost-per-₹100, where a
    // cost-on-success and a cost-on-attempt would move the same number in the
    // same direction and make it meaningless.
    const keys = Object.keys(RATES);
    assert.ok(!keys.some((k) => /mdr|transaction_fee/i.test(k)));
  });
});
