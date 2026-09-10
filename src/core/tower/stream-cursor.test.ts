import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeStreamCursor, parseStreamCursor } from './stream-cursor';

/**
 * The bug these guard against (FAILURES.md #37): `/api/stream` re-sent its
 * last row on every tick because the cursor round-tripped through a JS
 * `Date`, losing the microseconds Postgres keeps; and a reconnect skipped the
 * rest of a batch because the id lived only in the connection's memory.
 *
 * There is no database here, so what is asserted is the property that made
 * both possible: whether a value survives the wire intact.
 */
describe('stream cursor', () => {
  const PG_TS = '2026-09-07 07:30:33.911048+00';
  const ID = 'pay_SSEFIX1788766232';

  it('round-trips a timestamp without losing microseconds', () => {
    const back = parseStreamCursor(encodeStreamCursor(PG_TS, ID));
    assert.equal(back.ts, PG_TS);
    assert.equal(back.id, ID);

    // The precise loss that caused the bug: a Date keeps only milliseconds.
    assert.notEqual(new Date(PG_TS).toISOString(), PG_TS);
    assert.ok(back.ts.endsWith('048+00'), 'the sub-millisecond digits must survive');
  });

  it('carries the id across a reconnect', () => {
    // A batch insert puts every row on one created_at, so resuming from the
    // timestamp alone would skip the rest of the batch.
    assert.equal(parseStreamCursor(encodeStreamCursor(PG_TS, ID)).id, ID);
  });

  it('accepts a bare timestamp from an older client', () => {
    const back = parseStreamCursor(PG_TS);
    assert.equal(back.ts, PG_TS);
    assert.equal(back.id, null);
  });

  it('splits on the first separator, so an id is never truncated', () => {
    const odd = 'pay_a|b|c';
    const back = parseStreamCursor(encodeStreamCursor(PG_TS, odd));
    assert.equal(back.ts, PG_TS);
    assert.equal(back.id, odd);
  });

  it('falls back to now for a missing or unparseable cursor', () => {
    for (const bad of [null, undefined, '', 'not-a-timestamp', '|pay_x']) {
      const back = parseStreamCursor(bad);
      assert.equal(back.id, null, `${JSON.stringify(bad)} must not resume from an id`);
      assert.ok(
        Math.abs(Date.now() - new Date(back.ts).getTime()) < 5_000,
        `${JSON.stringify(bad)} must fall back to now, got ${back.ts}`,
      );
    }
  });

  it('emits a bare timestamp when there is no id yet', () => {
    assert.equal(encodeStreamCursor(PG_TS, null), PG_TS);
  });
});
