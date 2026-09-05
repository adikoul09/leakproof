import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lintMessage } from './lint';
import { OPT_OUT, railStatesAmount, renderTemplate } from './templates';

const URL = 'https://rzp.io/rzp/AbCdEf1';
const BASE = {
  shortUrl: URL,
  merchantName: 'Kiraana Fresh',
  optOut: OPT_OUT,
  amountLabel: '₹1,299.00',
};

const good =
  `Your ₹1,299.00 payment to Kiraana Fresh did not go through. ` +
  `You can complete it here: ${URL} — it takes a few seconds. ${OPT_OUT}`;

describe('lintMessage', () => {
  it('passes a message that satisfies every rule', () => {
    assert.deepEqual(lintMessage({ ...BASE, body: good }), { ok: true, failures: [] });
  });

  it('passes every static template — the fallback must never fail its own gate', () => {
    // If a template could not pass, a lint failure would fall back to something
    // equally unshippable and the safety net would be imaginary.
    const rails = [
      'upi_payment_link',
      'netbanking_link',
      'card_retry_delayed_payday',
      'email_link',
      'whatsapp_nudge',
      'mandate_repair',
    ] as const;
    for (const rail of rails) {
      const body = renderTemplate(rail, {
        merchantName: 'Kiraana Fresh',
        amountPaise: 129900,
        shortUrl: URL,
        failureClass: 'n/a',
      });
      const r = lintMessage({
        ...BASE,
        body,
        // mandate_repair quotes no sum, by design.
        amountLabel: railStatesAmount(rail) ? BASE.amountLabel : undefined,
      });
      assert.equal(r.ok, true, `${rail}: ${r.failures.join('; ')}`);
    }
  });

  it('rejects a stated reason for the failure', () => {
    const r = lintMessage({
      ...BASE,
      body: good.replace('did not go through', 'was declined by your bank'),
    });
    assert.equal(r.ok, false);
    assert.match(r.failures.join(' '), /reason for the failure/);
  });

  it('rejects insufficient-funds phrasing specifically', () => {
    const r = lintMessage({
      ...BASE,
      body: good.replace('did not go through', 'failed due to insufficient funds'),
    });
    assert.equal(r.ok, false);
    assert.match(r.failures.join(' '), /reason for the failure/);
  });

  it('rejects an invented discount', () => {
    const r = lintMessage({ ...BASE, body: `${good} Enjoy 10% off your next order.` });
    assert.equal(r.ok, false);
    assert.match(r.failures.join(' '), /inducement/);
  });

  it('rejects any URL that is not the payment link', () => {
    const r = lintMessage({ ...BASE, body: `${good} Need help? https://support.example.com` });
    assert.equal(r.ok, false);
    assert.match(r.failures.join(' '), /not the payment link/);
  });

  it('accepts the link with trailing punctuation', () => {
    const body =
      `Your ₹1,299.00 payment to Kiraana Fresh did not go through. ` +
      `Complete it here: ${URL}. ${OPT_OUT}`;
    assert.equal(lintMessage({ ...BASE, body }).ok, true);
  });

  it('rejects a missing or reworded opt-out sentence', () => {
    const r = lintMessage({ ...BASE, body: good.replace(OPT_OUT, 'Reply STOP to unsubscribe.') });
    assert.equal(r.ok, false);
    assert.match(r.failures.join(' '), /opt-out/);
  });

  it('does not require an amount from a rail that quotes none', () => {
    const body = renderTemplate('mandate_repair', {
      merchantName: 'Kiraana Fresh',
      amountPaise: 129900,
      shortUrl: URL,
      failureClass: 'n/a',
    });
    assert.equal(lintMessage({ ...BASE, body, amountLabel: undefined }).ok, true);
    // ...but still requires one when the rail does quote a sum.
    assert.equal(lintMessage({ ...BASE, body }).ok, false);
  });

  it('rejects a missing link, merchant or amount', () => {
    assert.match(lintMessage({ ...BASE, body: good.replace(URL, '') }).failures.join(' '), /payment link/);
    assert.match(
      lintMessage({ ...BASE, body: good.replace('Kiraana Fresh', 'the merchant') }).failures.join(' '),
      /name the merchant/,
    );
    assert.match(
      lintMessage({ ...BASE, body: good.replace('₹1,299.00', '₹1299') }).failures.join(' '),
      /state the amount/,
    );
  });

  it('rejects unfilled placeholders', () => {
    const r = lintMessage({ ...BASE, body: good.replace('Kiraana Fresh', '{{merchant}} Kiraana Fresh') });
    assert.equal(r.ok, false);
    assert.match(r.failures.join(' '), /placeholder/);
  });

  it('rejects copy claiming the payment already succeeded', () => {
    const r = lintMessage({ ...BASE, body: `Payment successful. ${good}` });
    assert.equal(r.ok, false);
    assert.match(r.failures.join(' '), /claims the payment succeeded/);
  });

  it('rejects an over-long message', () => {
    const r = lintMessage({ ...BASE, body: `${good} ${'padding. '.repeat(80)}`, maxChars: 480 });
    assert.equal(r.ok, false);
    assert.match(r.failures.join(' '), /too long/);
  });

  it('reports every failure at once, not just the first', () => {
    const r = lintMessage({ ...BASE, body: 'Your payment was declined. Get 10% off!' });
    assert.equal(r.ok, false);
    assert.ok(r.failures.length >= 4, `expected several failures, got ${r.failures.length}`);
  });
});
