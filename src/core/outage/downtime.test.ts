import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkDowntime, issuerCodes } from './downtime';
import type { Downtime } from '@/core/rails/razorpay';

const dt = (method: string, instrument: Record<string, string> = {}): Downtime => ({
  id: `down_${method}_${JSON.stringify(instrument)}`,
  method,
  begin: 1_788_500_000,
  end: null,
  status: 'started',
  severity: 'high',
  instrument,
});

/**
 * The cross-check is the only external corroboration this project claims, so
 * the ways it can be quietly wrong matter more than usual.
 */
describe('downtime cross-check', () => {
  it('speaks both vocabularies — ours and Razorpay IFSC codes', () => {
    // The live test feed returns {issuer:'CNRB'} for Canara, {issuer:'PUNB'}
    // for Punjab National. Our cohorts say CANARA and PNB. Without the alias
    // table the two never meet and agreement reads zero for a naming reason.
    assert.ok(issuerCodes('SBI').includes('SBIN'));
    assert.ok(issuerCodes('ICICI').includes('ICIC'));
    assert.ok(issuerCodes('AXIS').includes('UTIB'));
    assert.ok(issuerCodes('KOTAK').includes('KKBK'));
    const feed = [dt('card', { issuer: 'ICIC' })];
    assert.equal(checkDowntime(feed, 'ICICI', 'card').agrees, true);
  });

  it('returns null — not false — when the feed has nothing for the method', () => {
    const feed = [dt('upi', { vpa_handle: 'kotak811' }), dt('fpx', { bank: 'MB2U' })];
    const v = checkDowntime(feed, 'HDFC', 'card');
    assert.equal(v.agrees, null, '"no signal" and "disagreed" are different facts');
    assert.match(v.why, /no card rows/);
  });

  it('returns false when it covers the method but not this issuer', () => {
    const feed = [dt('card', { issuer: 'BKID' }), dt('card', { issuer: 'PUNB' })];
    const v = checkDowntime(feed, 'HDFC', 'card');
    assert.equal(v.agrees, false);
    assert.match(v.why, /did not flag HDFC/);
  });

  it('treats a method-wide downtime as covering every issuer on it', () => {
    const feed = [dt('netbanking')];
    assert.equal(checkDowntime(feed, 'HDFC', 'netbanking').agrees, true);
  });

  it('has no opinion when the feed is empty', () => {
    assert.equal(checkDowntime([], 'HDFC', 'card').agrees, null);
  });

  it('never lets the feed reach the classifier', async () => {
    // The classifier's input type has no field for downtime data, and that is
    // the guarantee — agreement is scored against a verdict already reached.
    // If this import ever gains a downtime argument, the validation becomes
    // circular and the agreement number stops meaning anything.
    const mod = await import('@/core/triage/classifier');
    const src = mod.classify.toString();
    assert.ok(!/downtime/i.test(src), 'classify() must never consult the downtime feed');
  });
});
