import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RAIL_CHANNEL, effectiveChannel } from './templates';
import { RAILS } from '@/core/routing/static-table';

/**
 * The bug this locks down (FAILURES.md #23): delivery is Razorpay's own
 * `notify: {sms, email}` on the payment link, and there is no WhatsApp option.
 * A rail asking for WhatsApp therefore set both flags false — the link was
 * created, nobody was told, and the attempt was still marked `action_sent` and
 * billed for a WhatsApp message. 312 of 1,672 attempts on the demo corpus.
 */
describe('effective channel', () => {
  it('falls back to SMS when WhatsApp is not provisioned', () => {
    const r = effectiveChannel('whatsapp_nudge', false);
    assert.equal(r.channel, 'sms');
    assert.equal(r.degradedFrom, 'whatsapp');
  });

  it('uses WhatsApp once it is provisioned', () => {
    const r = effectiveChannel('whatsapp_nudge', true);
    assert.equal(r.channel, 'whatsapp');
    assert.equal(r.degradedFrom, null);
  });

  it('leaves every other rail alone', () => {
    for (const rail of RAILS) {
      if (RAIL_CHANNEL[rail] === 'whatsapp') continue;
      const r = effectiveChannel(rail, false);
      assert.equal(r.channel, RAIL_CHANNEL[rail]);
      assert.equal(r.degradedFrom, null);
    }
  });

  it('never resolves to a channel Razorpay cannot deliver', () => {
    // 'none' is a real answer — human_escalation and do_nothing send nothing.
    // Anything else must be a channel the payment link can actually notify on.
    for (const rail of RAILS) {
      const { channel } = effectiveChannel(rail, false);
      assert.ok(
        ['sms', 'email', 'none'].includes(channel),
        `${rail} resolves to ${channel}, which has no delivery path`,
      );
    }
  });
});
