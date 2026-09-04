import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemoryCohortStore } from './memory-cohort-store';
import { TRIAGE, bucketStart } from './config';

/**
 * The rolling window must be bounded at BOTH ends.
 *
 * The bug this locks down (FAILURES.md #20): the window query had a lower bound
 * only, so it summed every bucket from the start of the window *forward* —
 * including buckets later than the event being classified. On live webhook
 * traffic that is invisible, because the future has not arrived. On anything
 * backfilled it is severe: a generated batch ingests a day of events in eight
 * minutes, so an event from hour 3 was classified against hours 3 through 24.
 * A "15-minute window" returned n=3,387 at the whole day's average decline
 * rate, which made the n>=8 guard meaningless and diluted every real spike into
 * the daily mean.
 */
describe('cohort window bounds', () => {
  const dim = 'HDFC|card';
  const t0 = new Date('2026-09-04T10:00:00.000Z');
  const at = (mins: number) => new Date(t0.getTime() + mins * 60_000);

  function seeded() {
    const s = new MemoryCohortStore();
    // One observation every 5 minutes for two hours.
    for (let m = 0; m < 120; m += 5) s.observeSync(dim, at(m), m % 10 === 0);
    return s;
  }

  it('does not count buckets from after the event', () => {
    const s = seeded();
    // Classifying an event at minute 30, with 90 minutes of future data loaded.
    const w = s.windowSync(dim, at(30));
    const bucketsInWindow = TRIAGE.windowMinutes / TRIAGE.bucketMinutes;
    assert.ok(
      w.nTotal <= bucketsInWindow,
      `window returned n=${w.nTotal}; a ${TRIAGE.windowMinutes}-minute window holds at most ${bucketsInWindow} of these`,
    );
  });

  it('includes the event’s own bucket', () => {
    const s = new MemoryCohortStore();
    s.observeSync(dim, at(0), true);
    const w = s.windowSync(dim, at(0));
    assert.equal(w.nTotal, 1, 'the event being classified must be inside its own window');
    assert.equal(w.nFailed, 1);
  });

  it('spans exactly windowMinutes backwards', () => {
    const s = seeded();
    const w = s.windowSync(dim, at(115));
    // Buckets at 105, 110, 115 for a 15-minute window at 5-minute granularity.
    assert.equal(w.nTotal, TRIAGE.windowMinutes / TRIAGE.bucketMinutes);
  });

  it('a spike stays a spike instead of being diluted by the rest of the day', () => {
    const s = new MemoryCohortStore();
    // A quiet day: 20 attempts per bucket, 8% declining.
    for (let m = 0; m < 240; m += 5) s.seedBucket(dim, bucketStart(at(m)).getTime(), 20, 2);
    // A 15-minute outage at minute 100, most attempts failing.
    for (const m of [100, 105, 110]) s.seedBucket(dim, bucketStart(at(m)).getTime(), 0, 16);

    const during = s.windowSync(dim, at(110));
    const quiet = s.windowSync(dim, at(200));
    assert.ok(
      during.declineRate > 0.5,
      `outage window read ${during.declineRate.toFixed(3)}; it should be dominated by the spike`,
    );
    assert.ok(quiet.declineRate < 0.15, 'a quiet window should read near the baseline');
  });
});
