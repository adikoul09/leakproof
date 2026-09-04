import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalisePhone } from './whatsapp';

describe('whatsapp phone normalisation', () => {
  it('adds the country code to a bare Indian number', () => {
    assert.equal(normalisePhone('9876504821'), '919876504821');
  });

  it('strips separators and the leading plus', () => {
    assert.equal(normalisePhone('+91 98765-04821'), '919876504821');
  });

  it('refuses a number it cannot make sense of', () => {
    // Silently mangling a number delivers a payment link to the wrong person,
    // which is worse than not sending.
    assert.equal(normalisePhone('12345'), null);
    assert.equal(normalisePhone('••••4821'), null);
    assert.equal(normalisePhone(''), null);
  });
});
