import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateBatch } from '@/core/simulator/generate';

/**
 * `ingestBatch` itself needs a database, so what is asserted here is the
 * property that broke: a generated batch contains byte-identical redeliveries,
 * and anything that walks a chunk of events must collapse them.
 *
 * The bug this replaces: the bulk insert deduplicated the ROW, but the loop
 * that turned the chunk into cohort observations and triage events did not. A
 * duplicate delivery was counted twice in the cohort decline rate — the input
 * to the systemic detector — and queued for triage twice, racing two
 * `recovery.plan` runs into the same (event_id, attempt_no) and blowing up on
 * the unique constraint.
 */
describe('duplicate deliveries in a chunk', () => {
  const batch = generateBatch({
    count: 800,
    seed: 5150,
    windowHours: 8,
    endsAt: new Date('2026-09-04T18:30:00+05:30'),
    injectOutage: null,
    organicRecoveryRate: 0.11,
    adversarialPct: 0.25,
    paydayStrength: 0.5,
    treatmentResponse: null,
  });

  it('the generator really does emit them, or the guard is untested', () => {
    assert.ok(batch.summary.adversarial.duplicate_delivery > 5);
  });

  it('collapsing by id leaves exactly one of each failure', () => {
    const failures = batch.events.filter((e) => e.outcome === 'failed');
    const unique = new Set(failures.map((e) => e.id));
    assert.equal(
      failures.length - unique.size,
      batch.summary.adversarial.duplicate_delivery,
      'every extra copy must be a duplicate delivery and nothing else',
    );
  });

  it('duplicates are byte-identical, so no field can be used to tell them apart', () => {
    const byId = new Map<string, string[]>();
    for (const e of batch.events) {
      if (e.outcome !== 'failed') continue;
      const seen = byId.get(e.id) ?? [];
      seen.push(JSON.stringify(e));
      byId.set(e.id, seen);
    }
    for (const [id, copies] of byId) {
      if (copies.length < 2) continue;
      assert.ok(copies.every((c) => c === copies[0]), `${id} differs between deliveries`);
    }
  });
});
