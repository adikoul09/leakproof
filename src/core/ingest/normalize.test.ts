import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeWebhook, resolveIssuer } from './normalize';

const subPayload = (over: Record<string, unknown> = {}, event = 'subscription.halted') => ({
  entity: 'event',
  event,
  contains: ['subscription'],
  payload: {
    subscription: {
      entity: {
        id: 'sub_ABC',
        plan_id: 'plan_XYZ',
        customer_id: 'cust_1',
        customer_email: 'meera@example.com',
        customer_contact: '+919876504821',
        status: 'halted',
        quantity: 1,
        total_count: 12,
        paid_count: 3,
        remaining_count: 9,
        auth_attempts: 4,
        payment_method: 'card',
        halted_at: 1788507446,
        ...over,
      },
    },
  },
  created_at: 1788507446,
});

describe('subscription.halted', () => {
  it('is an at-risk unit, not an unhandled event', () => {
    const n = normalizeWebhook(subPayload());
    assert.equal(n.outcome, 'failed');
    assert.ok(n.subscription, 'should produce a subscription signal');
    assert.equal(n.subscription!.id, 'sub_ABC');
    assert.equal(n.subscription!.reason, 'subscription_halted');
  });

  it('takes the amount from an embedded plan and multiplies by quantity', () => {
    const n = normalizeWebhook(
      subPayload({ quantity: 2, plan: { item: { amount: 49900, currency: 'INR' } } }),
    );
    assert.equal(n.subscription!.amountPaise, 99_800);
  });

  it('leaves the amount null when the plan is not embedded, rather than guessing zero', () => {
    // The subscription create response embeds `plan`; the list endpoint does
    // not. Booking a ₹0 at-risk event would silently understate exposure.
    const n = normalizeWebhook(subPayload());
    assert.equal(n.subscription!.amountPaise, null);
    assert.equal(n.subscription!.planId, 'plan_XYZ');
  });

  it('carries the contact details the dunning message will need', () => {
    const s = normalizeWebhook(subPayload()).subscription!;
    assert.equal(s.customerContact, '+919876504821');
    assert.equal(s.customerEmail, 'meera@example.com');
    assert.equal(s.authAttempts, 4);
  });

  it('treats subscription.pending as at-risk too, one signal earlier', () => {
    const n = normalizeWebhook(subPayload({ status: 'pending' }, 'subscription.pending'));
    assert.equal(n.subscription!.reason, 'subscription_pending');
  });
});

describe('subscription.charged', () => {
  it('is a recovery signal — the organic path for the subscription surface', () => {
    const body = {
      entity: 'event',
      event: 'subscription.charged',
      payload: {
        subscription: { entity: { id: 'sub_ABC' } },
        payment: { entity: { id: 'pay_1', amount: 49900, created_at: 1788507999 } },
      },
      created_at: 1788507999,
    };
    const n = normalizeWebhook(body);
    assert.equal(n.outcome, 'succeeded');
    assert.equal(n.recovery?.kind, 'subscription_charged');
    assert.equal((n.recovery as { subscriptionId: string }).subscriptionId, 'sub_ABC');
    assert.equal(n.recovery?.amountPaise, 49900);
  });
});

describe('payment webhooks still work', () => {
  it('normalises a failed card payment', () => {
    const n = normalizeWebhook({
      event: 'payment.failed',
      payload: {
        payment: {
          entity: {
            id: 'pay_1',
            amount: 234000,
            currency: 'INR',
            method: 'card',
            order_id: 'order_9',
            card: { issuer: 'HDFC', network: 'Visa' },
            contact: '+919876504821',
            error_reason: 'issuer_down',
            created_at: 1788507446,
          },
        },
      },
    });
    assert.equal(n.outcome, 'failed');
    assert.equal(n.event?.issuer, 'HDFC');
    assert.equal(n.event?.orderId, 'order_9');
    assert.equal(n.subscription, null);
  });

  it('returns a fully null shape for an event it does not handle', () => {
    const n = normalizeWebhook({ event: 'refund.created', payload: {} });
    assert.equal(n.outcome, 'other');
    assert.equal(n.event, null);
    assert.equal(n.subscription, null);
    assert.equal(n.recovery, null);
  });
});

describe('resolveIssuer', () => {
  it('reads the issuer from wherever the method puts it', () => {
    assert.equal(resolveIssuer({ method: 'netbanking', bank: 'HDFC' }), 'HDFC');
    assert.equal(resolveIssuer({ method: 'card', card: { issuer: 'ICICI' } }), 'ICICI');
    assert.equal(resolveIssuer({ method: 'wallet', wallet: 'paytm' }), 'paytm');
    assert.equal(resolveIssuer({ method: 'upi', vpa: 'meera@okhdfcbank' }), 'OKHDFCBANK');
    assert.equal(resolveIssuer({ method: 'upi' }), null);
  });
});
