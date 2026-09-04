/**
 * `simulator.generate` — produce a synthetic batch and push it through the
 * real ingestion pipeline.
 *
 * The events are not carried on the Inngest event. `generateBatch` is a pure
 * function of the stored spec, so the job regenerates the corpus from the seed
 * — which is also the property that makes the batch auditable in the first
 * place. Inngest replays the function body at every step boundary, and a
 * generator that was not deterministic would produce a *different* corpus on
 * each replay and quietly double-write half of it.
 */
import { NonRetriableError } from 'inngest';
import { generateBatch } from '@/core/simulator/generate';
import type { NormalizedSpec } from '@/core/simulator/generate';
import {
  applyOptOuts,
  completeBatch,
  failBatch,
  getBatch,
  recordPlan,
  recordProgress,
  specFromStored,
} from '@/core/simulator/store';
import { ingestBatch } from '@/core/ingest/ingest-batch';
import { optional } from '@/lib/env';
import { inngest } from '@/lib/inngest';

/**
 * Events per step. Small enough that a step finishes inside the platform's
 * execution limit, large enough that a full day's corpus does not become a
 * hundred steps.
 */
const CHUNK = 2000;

export const simulatorGenerate = inngest.createFunction(
  { id: 'simulator-generate', name: 'simulator.generate', retries: 2 },
  { event: 'simulator.generate' },
  async ({ event, step }) => {
    const { batchId } = event.data;

    const stored = await step.run('load-spec', async () => {
      const row = await getBatch(batchId);
      if (!row) throw new NonRetriableError(`synthetic batch ${batchId} not found`);
      return row.spec as NormalizedSpec;
    });

    // Deterministic: safe to run outside a step, and identical on every replay.
    const batch = generateBatch(specFromStored(stored, optional.armSalt()));

    await step.run('record-plan', () => recordPlan(batchId, batch));

    // Opt-outs first. Ingestion queues triage immediately and the policy gate
    // reads the flag when it evaluates, so an opt-out applied afterwards would
    // arrive after the contact it was meant to prevent.
    await step.run('opt-outs', () =>
      applyOptOuts(batch.optedOutCustomers, new Date(batch.summary.windowStart)),
    );

    let accepted = 0;
    let rejected = 0;
    let atRisk = 0;
    let matched = 0;
    let parked = 0;

    const chunks = Math.ceil(batch.events.length / CHUNK);
    for (let i = 0; i < chunks; i += 1) {
      const slice = batch.events.slice(i * CHUNK, (i + 1) * CHUNK);
      const r = await step.run(`ingest-${i}`, () =>
        ingestBatch(slice, batchId, `simulator ${batchId} chunk ${i}`),
      );
      accepted += r.accepted;
      rejected += r.rejected;
      atRisk += r.at_risk_created;
      matched += r.recoveries_matched;
      parked += r.recoveries_parked;
      await step.run(`progress-${i}`, () => recordProgress(batchId, accepted, rejected));
    }

    await step.run('complete', () => completeBatch(batchId));

    return {
      batchId,
      events: batch.events.length,
      accepted,
      rejected,
      atRiskCreated: atRisk,
      recoveriesMatched: matched,
      recoveriesStillParked: parked,
      groundTruth: {
        systemicEvents: batch.groundTruth.systemicEventIds.length,
        trueIncrementalPaise: batch.groundTruth.trueIncrementalPaise,
      },
    };
  },
  // A batch that dies halfway leaves a row stuck on 'generating' forever, and a
  // simulator you cannot tell has failed is worse than one that does not run.
);

/** Marks the batch failed when the function exhausts its retries. */
export const simulatorGenerateFailed = inngest.createFunction(
  { id: 'simulator-generate-failed', name: 'simulator.generate (failure handler)' },
  { event: 'inngest/function.failed' },
  async ({ event, step }) => {
    const fnId = event.data?.function_id as string | undefined;
    if (!fnId?.includes('simulator-generate')) return { skipped: true };
    const batchId = (event.data?.event as { data?: { batchId?: string } } | undefined)?.data?.batchId;
    if (!batchId) return { skipped: true };
    await step.run('mark-failed', () =>
      failBatch(batchId, String(event.data?.error ?? 'generation failed')),
    );
    return { batchId, marked: 'failed' };
  },
);
