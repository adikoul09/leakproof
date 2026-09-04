import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RAIL_CHANNEL, effectiveChannel, whatsappBlockers } from './templates';
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
    const r = effectiveChannel('whatsapp_nudge', false, true);
    assert.equal(r.channel, 'sms');
    assert.equal(r.degradedFrom, 'whatsapp');
    assert.match(r.why!, /WHATSAPP_TOKEN/);
  });

  it('still falls back when credentials exist but no phone number does', () => {
    // The architectural blocker, not the clerical one: this system stores a
    // sha256 and a display mask, never a raw number. Razorpay notifies on our
    // behalf for sms and email; Meta has no such arrangement.
    const r = effectiveChannel('whatsapp_nudge', true, false);
    assert.equal(r.channel, 'sms');
    assert.equal(r.degradedFrom, 'whatsapp');
    assert.match(r.why!, /no raw phone number/);
  });

  it('uses WhatsApp only when credentials AND a number are both present', () => {
    const r = effectiveChannel('whatsapp_nudge', true, true);
    assert.equal(r.channel, 'whatsapp');
    assert.equal(r.degradedFrom, null);
  });

  it('names both blockers, so neither can be mistaken for the other', () => {
    const both = whatsappBlockers(false, false);
    assert.equal(both.length, 2);
    assert.match(both[0], /WHATSAPP_TOKEN/);
    assert.match(both[1], /privacy decision, not a configuration one/);
    assert.equal(whatsappBlockers(true, true).length, 0);
  });

  it('leaves every other rail alone', () => {
    for (const rail of RAILS) {
      if (RAIL_CHANNEL[rail] === 'whatsapp') continue;
      const r = effectiveChannel(rail, false, false);
      assert.equal(r.channel, RAIL_CHANNEL[rail]);
      assert.equal(r.degradedFrom, null);
    }
  });

  it('never resolves to a channel Razorpay cannot deliver', () => {
    // 'none' is a real answer — human_escalation and do_nothing send nothing.
    // Anything else must be a channel the payment link can actually notify on.
    for (const rail of RAILS) {
      const { channel } = effectiveChannel(rail, false, false);
      assert.ok(
        ['sms', 'email', 'none'].includes(channel),
        `${rail} resolves to ${channel}, which has no delivery path`,
      );
    }
  });
});
