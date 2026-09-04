/**
 * Persistence for replay runs.
 *
 * A run stores its spec including the seed and the corpus it was built from, so
 * a what-if number quoted in a pitch can be reproduced rather than believed.
 */
import { desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { replayRuns } from '@/db/schema';
import type { ReplayResult } from './engine';

export interface CreateRunInput {
  corpus: string;
  policyVersion: string;
  flags: Record<string, unknown>;
  seed: number;
}

export async function createRun(input: CreateRunInput): Promise<string> {
  const [row] = await db
    .insert(replayRuns)
    .values({
      corpus: input.corpus,
      policyVersion: input.policyVersion,
      flags: input.flags,
      seed: input.seed,
    })
    .returning({ id: replayRuns.id });
  return row.id;
}

export async function finishRun(
  runId: string,
  result: ReplayResult,
  eventsCount: number,
): Promise<void> {
  await db
    .update(replayRuns)
    .set({
      eventsCount,
      metrics: result.replayed,
      baselineMetrics: result.baseline,
      // The blueprint's table has no column for the diff, and adding one for a
      // blob we always read whole would be schema for schema's sake. The full
      // result rides in `flags` alongside the spec that produced it.
      flags: { ...(result.spec.flags as unknown as Record<string, unknown>), result },
      finishedAt: new Date(),
    })
    .where(eq(replayRuns.id, runId));
}

export async function failRun(runId: string, error: string): Promise<void> {
  await db
    .update(replayRuns)
    .set({ flags: { error: error.slice(0, 2000) }, finishedAt: new Date() })
    .where(eq(replayRuns.id, runId));
}

export async function getRun(runId: string) {
  const [row] = await db.select().from(replayRuns).where(eq(replayRuns.id, runId)).limit(1);
  return row ?? null;
}

export async function listRuns(limit = 20) {
  return db.select().from(replayRuns).orderBy(desc(replayRuns.startedAt)).limit(limit);
}
