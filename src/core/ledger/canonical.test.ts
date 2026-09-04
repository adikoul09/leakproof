import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GENESIS_PREV_HASH,
  NonCanonicalValueError,
  canonicalString,
  chainHash,
  toCanonical,
} from './canonical';

describe('canonicalString', () => {
  it('is insensitive to key insertion order, at every depth', () => {
    const a = { action: 'send', detail: { rail: 'upi', cost: 20 } };
    const b = { detail: { cost: 20, rail: 'upi' }, action: 'send' };
    assert.equal(canonicalString(a), canonicalString(b));
  });

  it('preserves array order, because an array is ordered data', () => {
    assert.notEqual(canonicalString({ r: ['allow', 'block'] }), canonicalString({ r: ['block', 'allow'] }));
  });

  it('drops undefined properties, matching JSON semantics', () => {
    assert.equal(canonicalString({ a: 1, b: undefined }), canonicalString({ a: 1 }));
  });

  it('renders dates as ISO strings', () => {
    assert.equal(canonicalString({ at: new Date('2026-09-04T08:52:00Z') }), '{"at":"2026-09-04T08:52:00.000Z"}');
  });

  it('refuses values JSON cannot round-trip instead of coercing them to null', () => {
    // JSON.stringify turns NaN and Infinity into null. Hashing a silently
    // degraded record is worse than failing to hash it.
    assert.throws(() => canonicalString({ x: NaN }), NonCanonicalValueError);
    assert.throws(() => canonicalString({ x: Infinity }), NonCanonicalValueError);
    assert.throws(() => canonicalString({ x: BigInt(1) }), NonCanonicalValueError);
    assert.throws(() => canonicalString({ x: new Date('nope') }), NonCanonicalValueError);
  });

  it('names the path of the offending field', () => {
    try {
      canonicalString({ detail: { nested: [1, NaN] } });
      assert.fail('should have thrown');
    } catch (e) {
      assert.match((e as Error).message, /detail\.nested\[1\]/);
    }
  });

  it('normalises -0 so it cannot hash differently from 0', () => {
    assert.equal(canonicalString({ x: -0 }), canonicalString({ x: 0 }));
  });

  it('distinguishes records that differ only in a deeply nested value', () => {
    const a = { action: 'send', detail: { policy: { caps: { max: 3 } } } };
    const b = { action: 'send', detail: { policy: { caps: { max: 4 } } } };
    assert.notEqual(canonicalString(a), canonicalString(b));
  });
});

describe('the blueprint one-liner this replaces', () => {
  // Kept as an executable record of *why* the implementation is not a
  // one-liner. If someone simplifies canonical.ts back to this, the tests
  // above start failing and this explains what broke.
  const blueprintCanonical = (r: object) => JSON.stringify(r, Object.keys(r).sort());

  it('silently drops every nested field, leaving detail unprotected', () => {
    const record = { action: 'send', detail: { rail: 'upi_payment_link', cost_paise: 20 } };
    assert.equal(blueprintCanonical(record), '{"action":"send","detail":{}}');

    // Which means a tampered detail hashes identically under it...
    const tampered = { action: 'send', detail: { rail: 'human_escalation', cost_paise: 5000 } };
    assert.equal(blueprintCanonical(record), blueprintCanonical(tampered));

    // ...and differently under ours, which is the entire point.
    assert.notEqual(canonicalString(record), canonicalString(tampered));
  });
});

describe('chainHash', () => {
  it('is a 64-character hex digest', () => {
    assert.match(chainHash(GENESIS_PREV_HASH, { action: 'genesis' }), /^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    const r = { action: 'classify', event_id: 'pay_1' };
    assert.equal(chainHash(GENESIS_PREV_HASH, r), chainHash(GENESIS_PREV_HASH, r));
  });

  it('changes when the record changes', () => {
    const a = chainHash(GENESIS_PREV_HASH, { action: 'classify', event_id: 'pay_1' });
    const b = chainHash(GENESIS_PREV_HASH, { action: 'classify', event_id: 'pay_2' });
    assert.notEqual(a, b);
  });

  it('changes when the previous hash changes — this is what makes it a chain', () => {
    const r = { action: 'classify', event_id: 'pay_1' };
    assert.notEqual(chainHash(GENESIS_PREV_HASH, r), chainHash('a'.repeat(64), r));
  });

  it('genesis starts from 64 zeroes', () => {
    assert.equal(GENESIS_PREV_HASH.length, 64);
    assert.match(GENESIS_PREV_HASH, /^0+$/);
  });
});

describe('toCanonical', () => {
  it('passes primitives through unchanged', () => {
    assert.equal(toCanonical('x'), 'x');
    assert.equal(toCanonical(42), 42);
    assert.equal(toCanonical(true), true);
    assert.equal(toCanonical(null), null);
  });
});
