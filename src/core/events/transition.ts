/**
 * Advancing an event's state.
 *
 * The pipeline's stages each move an at-risk event along — classifying,
 * planned, deferred, action_sent — and every one of them used to write `state`
 * unconditionally. That is fine right up until a recovery lands mid-flight.
 *
 * It does. A `payment.captured` webhook (or, on a generated batch, an organic
 * recovery) marks an event `recovered`, and the `triage.classify` run that was
 * queued *before* that recovery arrived then settles the event back to
 * `at_risk`. Nothing errors. `recovered_at` and `recovered_paise` survive,
 * because only `state` is overwritten — so the money is still recorded and the
 * event simply stops being *counted* as recovered.
 *
 * On the first full synthetic batch that erased all 85 recoveries and the
 * headline incrementality number read exactly zero. See FAILURES.md #19.
 *
 * So: a terminal state is terminal. Everything that advances an event goes
 * through here.
 */
import { and, eq, notInArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { paymentEvents } from '@/db/schema';
import { type EventState, TERMINAL_STATES } from './state';

/**
 * Advance an event. Returns false when the event was already closed and the
 * transition was refused, which callers can log but should not treat as an
 * error — losing a race to a recovery is a normal outcome, not a fault.
 */
export async function setEventState(eventId: string, next: EventState): Promise<boolean> {
  const updated = await db
    .update(paymentEvents)
    .set({ state: next })
    .where(and(eq(paymentEvents.id, eventId), notInArray(paymentEvents.state, [...TERMINAL_STATES])))
    .returning({ id: paymentEvents.id });
  return updated.length > 0;
}
