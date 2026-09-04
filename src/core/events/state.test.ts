import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ALL_EVENT_STATES, OPEN_STATES, TERMINAL_STATES } from './state';

/**
 * The bug these guard against (FAILURES.md #19): four jobs wrote `state`
 * unconditionally, so a recovery that landed while triage was in flight got
 * its label erased by the job that started earlier and finished later. The
 * money survived in `recovered_at`; only the label was lost — and the metrics
 * keyed off the label, so a batch with 85 real recoveries reported zero.
 *
 * There is no database here, so what is asserted is the invariant that made it
 * possible: two lists describing the same enum, maintained separately.
 */
describe('event state partition', () => {
  const all = ALL_EVENT_STATES as readonly string[];

  it('every state is either open or terminal', () => {
    const covered = new Set<string>([...OPEN_STATES, ...TERMINAL_STATES]);
    for (const s of all) {
      assert.ok(covered.has(s), `${s} is in neither OPEN_STATES nor TERMINAL_STATES`);
    }
    assert.equal(covered.size, all.length);
  });

  it('no state is both', () => {
    const terminal = new Set<string>(TERMINAL_STATES);
    for (const s of OPEN_STATES) {
      assert.ok(!terminal.has(s), `${s} is listed as both open and terminal`);
    }
  });

  it('a recovered event is terminal, so nothing can walk it back to at_risk', () => {
    assert.ok((TERMINAL_STATES as readonly string[]).includes('recovered'));
    assert.ok(!(OPEN_STATES as readonly string[]).includes('recovered'));
  });

  it('recovery matching looks at exactly the open states', () => {
    // `recordPaymentCaptured` matches on OPEN_STATES. If a state were missing
    // from that list, an organic recovery against it would silently find
    // nothing — and the control arm recovers by no other route.
    const open = new Set<string>(OPEN_STATES);
    for (const s of all) {
      if ((TERMINAL_STATES as readonly string[]).includes(s)) continue;
      assert.ok(open.has(s), `${s} is not terminal but recovery matching ignores it`);
    }
  });
});
