/**
 * Recording a recovery.
 *
 * Two paths reach here, and keeping them distinct matters for the experiment:
 *
 *  - **attributed** — one of our links was paid. We know which attempt caused it.
 *  - **organic**    — the payment succeeded without us, matched back to the
 *                     original failure by order id. This is the only way the
 *                     control arm ever records a recovery, and the control
 *                     arm is the baseline the entire result rests on. If
 *                     organic recovery were not detected, the control rate
 *                     would read zero and every incrementality number would be
 *                     inflated to the point of fraud.
 *
 * Both write to the same `payment_events` columns, because for the purpose of
 * measuring incrementality a rupee recovered is a rupee recovered — the
 * experiment does the attribution, not the plumbing.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { paymentEvents, recoveryAttempts } from '@/db/schema';

/** States that still count as recoverable. A lost or stopped event is closed. */
const OPEN_STATES = [
  'at_risk',
  'classifying',
  'planned',
  'waiting_out_outage',
  'deferred',
  'blocked_by_policy',
  'action_sent',
] as const;

export interface RecoveryResult {
  eventId: string | null;
  attributed: boolean;
  alreadyRecovered: boolean;
}

const NOT_FOUND: RecoveryResult = { eventId: null, attributed: false, alreadyRecovered: false };

/** A recovery link was paid. `referenceId` is the attempt's UUID. */
export async function recordLinkPaid(
  referenceId: string,
  amountPaise: number,
  at: Date,
): Promise<RecoveryResult> {
  const [attempt] = await db
    .select({ id: recoveryAttempts.id, eventId: recoveryAttempts.eventId })
    .from(recoveryAttempts)
    .where(eq(recoveryAttempts.id, referenceId))
    .limit(1);
  if (!attempt) return NOT_FOUND;

  await db
    .update(recoveryAttempts)
    .set({ outcome: 'paid', outcomeAt: at })
    .where(eq(recoveryAttempts.id, attempt.id));

  const already = await markRecovered(attempt.eventId, amountPaise, at);
  return { eventId: attempt.eventId, attributed: true, alreadyRecovered: already };
}

/**
 * A payment succeeded. Match it back to an open failure on the same order.
 *
 * Razorpay issues a new payment id for a retry, so the payment id itself is
 * matched first (a captured-after-failure on the same id does happen), then
 * the order id.
 */
export async function recordPaymentCaptured(
  paymentId: string,
  orderId: string | null,
  amountPaise: number,
  at: Date,
): Promise<RecoveryResult> {
  const [byId] = await db
    .select({ id: paymentEvents.id })
    .from(paymentEvents)
    .where(and(eq(paymentEvents.id, paymentId), inArray(paymentEvents.state, OPEN_STATES)))
    .limit(1);

  let target = byId?.id ?? null;

  if (!target && orderId) {
    const [byOrder] = await db
      .select({ id: paymentEvents.id })
      .from(paymentEvents)
      .where(
        and(
          eq(paymentEvents.orderId, orderId),
          inArray(paymentEvents.state, OPEN_STATES),
          isNull(paymentEvents.recoveredAt),
        ),
      )
      .limit(1);
    target = byOrder?.id ?? null;
  }

  if (!target) return NOT_FOUND;

  const already = await markRecovered(target, amountPaise, at);
  return { eventId: target, attributed: false, alreadyRecovered: already };
}

/**
 * A subscription charged successfully — the halted subscription recovered.
 *
 * The at-risk row's id *is* the subscription id (blueprint 6.2: ids are
 * pay_xxx / sub_xxx / inv_xxx), so this matches directly. This is the
 * subscription surface's organic-recovery path, and without it that surface's
 * control arm would read zero.
 */
export async function recordSubscriptionCharged(
  subscriptionId: string,
  amountPaise: number,
  at: Date,
): Promise<RecoveryResult> {
  const [row] = await db
    .select({ id: paymentEvents.id, amountPaise: paymentEvents.amountPaise })
    .from(paymentEvents)
    .where(and(eq(paymentEvents.id, subscriptionId), inArray(paymentEvents.state, OPEN_STATES)))
    .limit(1);
  if (!row) return NOT_FOUND;

  // A subscription charge webhook does not always carry the payment amount;
  // fall back to the plan amount recorded when the event was ingested rather
  // than booking a recovery of zero rupees.
  const amount = amountPaise > 0 ? amountPaise : row.amountPaise;
  const already = await markRecovered(row.id, amount, at);
  return { eventId: row.id, attributed: false, alreadyRecovered: already };
}

/**
 * Idempotent. Returns true if the event was already marked recovered, so a
 * redelivered webhook cannot double-count a rupee into the headline number.
 */
async function markRecovered(eventId: string, amountPaise: number, at: Date): Promise<boolean> {
  const updated = await db
    .update(paymentEvents)
    .set({ state: 'recovered', recoveredAt: at, recoveredPaise: amountPaise })
    .where(and(eq(paymentEvents.id, eventId), isNull(paymentEvents.recoveredAt)))
    .returning({ id: paymentEvents.id });
  return updated.length === 0;
}
