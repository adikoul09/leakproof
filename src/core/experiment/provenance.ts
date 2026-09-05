/**
 * Where the numbers on the Incrementality Lab actually came from.
 *
 * The lab renders a real measurement over whatever is in the database, and on
 * this build that is a synthetic batch whose recoveries were *planted* by the
 * generator rather than caused by messages the system delivered. Both facts are
 * true at once and neither is visible from the metrics themselves: the summary
 * would report a clean +12pp lift with a p-value of 4e-9 whether the corpus was
 * live traffic or a simulation that never sent anything.
 *
 * So the screen states it. A judge who finds out that a headline lift came from
 * planted data by reading the source has been misled by the screen, however
 * accurate its arithmetic was.
 */
import 'server-only';
import { and, gte, isNotNull, lte, sql as raw } from 'drizzle-orm';
import { db } from '@/db/client';
import { messages, paymentEvents, recoveryAttempts, syntheticBatches } from '@/db/schema';
import type { MetricsWindow } from './metrics-store';

export interface CorpusProvenance {
  events: number;
  /** Events carrying a `batch_id` — i.e. produced by the generator. */
  synthetic_events: number;
  /** Every completed batch, not just the ones listed below. */
  batch_count: number;
  /** The most recent few, newest first. */
  batches: Array<{ id: string; label: string | null; n_accepted: number }>;
  /** Recovery attempts the pipeline created. */
  attempts: number;
  /** Of those, how many actually ran. The rest are scheduled or deferred. */
  attempts_executed: number;
  /** Messages that reached a channel. Zero means nobody was contacted. */
  messages_sent: number;
}

export async function corpusProvenance(w: MetricsWindow = {}): Promise<CorpusProvenance> {
  const parts = [];
  if (w.from) parts.push(gte(paymentEvents.failedAt, w.from));
  if (w.to) parts.push(lte(paymentEvents.failedAt, w.to));
  const where = parts.length ? and(...parts) : undefined;

  const [[counts], [attemptCounts], [messageCount], batches, [batchCount]] = await Promise.all([
    db
      .select({
        events: raw<number>`count(*)::int`,
        synthetic: raw<number>`count(*) filter (where ${paymentEvents.batchId} is not null)::int`,
      })
      .from(paymentEvents)
      .where(where),
    db
      .select({
        attempts: raw<number>`count(*)::int`,
        executed: raw<number>`count(*) filter (where ${recoveryAttempts.executedAt} is not null)::int`,
      })
      .from(recoveryAttempts)
      .innerJoin(paymentEvents, raw`${paymentEvents.id} = ${recoveryAttempts.eventId}`)
      .where(where),
    db
      .select({ n: raw<number>`count(*)::int` })
      .from(messages)
      .innerJoin(recoveryAttempts, raw`${recoveryAttempts.id} = ${messages.attemptId}`)
      .innerJoin(paymentEvents, raw`${paymentEvents.id} = ${recoveryAttempts.eventId}`)
      .where(where),
    db
      .select({
        id: syntheticBatches.id,
        label: syntheticBatches.label,
        nAccepted: syntheticBatches.nAccepted,
      })
      .from(syntheticBatches)
      .where(isNotNull(syntheticBatches.completedAt))
      .orderBy(raw`${syntheticBatches.createdAt} desc`)
      .limit(5),
    db
      .select({ n: raw<number>`count(*)::int` })
      .from(syntheticBatches)
      .where(isNotNull(syntheticBatches.completedAt)),
  ]);

  return {
    events: counts?.events ?? 0,
    synthetic_events: counts?.synthetic ?? 0,
    batch_count: batchCount?.n ?? 0,
    batches: batches.map((b) => ({ id: b.id, label: b.label, n_accepted: b.nAccepted })),
    attempts: attemptCounts?.attempts ?? 0,
    attempts_executed: attemptCounts?.executed ?? 0,
    messages_sent: messageCount?.n ?? 0,
  };
}
