/**
 * Persistence for generated batches.
 *
 * The batch row is the generator's audit record: it holds the seed, so the
 * corpus behind any reported number can be regenerated exactly, and the ground
 * truth, so the number can be checked against what was actually planted.
 */
import { desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { customers, syntheticBatches } from '@/db/schema';
import { syntheticCustomer } from '@/core/ingest/ingest-batch';
import type { BatchSpec, GeneratedBatch, NormalizedSpec } from './generate';

export async function createBatch(spec: NormalizedSpec, label: string | null): Promise<string> {
  const [row] = await db
    .insert(syntheticBatches)
    .values({ spec, label, status: 'generating' })
    .returning({ id: syntheticBatches.id });
  return row.id;
}

export async function recordPlan(batchId: string, batch: GeneratedBatch): Promise<void> {
  await db
    .update(syntheticBatches)
    .set({
      summary: batch.summary,
      groundTruth: batch.groundTruth,
      nEvents: batch.events.length,
    })
    .where(eq(syntheticBatches.id, batchId));
}

export async function recordProgress(
  batchId: string,
  accepted: number,
  rejected: number,
): Promise<void> {
  await db
    .update(syntheticBatches)
    .set({ nAccepted: accepted, nRejected: rejected })
    .where(eq(syntheticBatches.id, batchId));
}

export async function completeBatch(batchId: string): Promise<void> {
  await db
    .update(syntheticBatches)
    .set({ status: 'complete', completedAt: new Date() })
    .where(eq(syntheticBatches.id, batchId));
}

export async function failBatch(batchId: string, error: string): Promise<void> {
  await db
    .update(syntheticBatches)
    .set({ status: 'failed', error: error.slice(0, 2000), completedAt: new Date() })
    .where(eq(syntheticBatches.id, batchId));
}

export async function getBatch(batchId: string) {
  const [row] = await db
    .select()
    .from(syntheticBatches)
    .where(eq(syntheticBatches.id, batchId))
    .limit(1);
  return row ?? null;
}

export async function listBatches(limit = 25) {
  return db.select().from(syntheticBatches).orderBy(desc(syntheticBatches.createdAt)).limit(limit);
}

/** The stored spec, back in the shape `generateBatch` wants. */
export function specFromStored(stored: NormalizedSpec, armSalt: string | null): BatchSpec {
  return {
    count: stored.count,
    seed: stored.seed,
    windowHours: stored.windowHours,
    endsAt: new Date(stored.endsAt),
    injectOutage: stored.injectOutage,
    organicRecoveryRate: stored.organicRecoveryRate,
    adversarialPct: stored.adversarialPct,
    paydayStrength: stored.paydayStrength,
    subscriptionShare: stored.subscriptionShare,
    // The salt is a secret and is never stored on the batch row; it is
    // re-attached here from the environment so the arm split reproduces exactly.
    treatmentResponse:
      stored.treatmentResponse && armSalt
        ? { ...stored.treatmentResponse, armSalt }
        : null,
  };
}

/**
 * Mark generated customers as opted out BEFORE their events are ingested.
 *
 * Ordering matters: ingestion queues triage immediately, and the policy gate
 * reads the opt-out flag when it evaluates. Applied afterwards, the opt-out
 * would arrive after the contact it was supposed to prevent — which is exactly
 * the bug that makes an opt-out feature worthless.
 */
export async function applyOptOuts(
  people: Array<{ id: string; reason: string }>,
  at: Date,
): Promise<number> {
  if (people.length === 0) return 0;

  for (let i = 0; i < people.length; i += 500) {
    const chunk = people.slice(i, i + 500);
    await db
      .insert(customers)
      .values(
        chunk.map((p) => ({
          ...syntheticCustomer(p.id),
          optedOutAt: at,
          optOutReason: p.reason,
        })),
      )
      .onConflictDoNothing({ target: customers.id });
  }

  // A customer created by an earlier batch is skipped by the conflict clause
  // above, so set the flag explicitly. Grouped by reason — one UPDATE for the
  // whole chunk would stamp every person with the first person's reason, and
  // 'complaint' versus 'stop_reply' is the difference between a customer who
  // objected and one who simply replied STOP.
  const byReason = new Map<string, string[]>();
  for (const p of people) {
    const ids = byReason.get(p.reason) ?? [];
    ids.push(p.id);
    byReason.set(p.reason, ids);
  }
  for (const [reason, ids] of byReason) {
    for (let i = 0; i < ids.length; i += 500) {
      await db
        .update(customers)
        .set({ optedOutAt: at, optOutReason: reason })
        .where(inArray(customers.id, ids.slice(i, i + 500)));
    }
  }
  return people.length;
}
