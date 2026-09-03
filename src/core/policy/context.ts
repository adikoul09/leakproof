/**
 * Assembles the PolicyContext from the database.
 *
 * This is the only place that knows how to turn "an event id" into the facts
 * the gate needs. Keeping it separate from `evaluatePolicy` is what lets the
 * replay engine build a context from a historical corpus instead — same gate,
 * different source of facts.
 */
import { and, count, eq, gte, isNotNull, sql as raw } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  customers,
  messages,
  paymentEvents,
  recoveryAttempts,
} from '@/db/schema';
import { cohortDim } from '@/core/triage/classifier';
import { readEffectiveBreaker } from './breaker-store';
import { loadHolidays } from './holidays';
import type { PolicyContext } from './evaluate';
import type { Policy, StopCondition } from './schema';
import { addDays, zonedParts } from './tz';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** How far ahead the gate may need holiday data in order to compute a defer. */
const HOLIDAY_LOOKAHEAD_DAYS = 21;

export interface ContextBuildResult {
  context: PolicyContext;
  /** Cohort the breaker was consulted for — echoed into the trace. */
  breakerScope: string;
}

export async function buildPolicyContext(
  eventId: string,
  policy: Policy,
  now: Date,
  proposedDiscountPct = 0,
): Promise<ContextBuildResult> {
  const [event] = await db.select().from(paymentEvents).where(eq(paymentEvents.id, eventId)).limit(1);
  if (!event) throw new Error(`payment event ${eventId} not found`);

  const scope = cohortDim({
    issuer: event.issuer,
    method: event.method,
    amountPaise: event.amountPaise,
  });

  const tz = policy.contact_window.tz;
  const todayKey = zonedParts(now, tz).dateKey;

  const [breaker, holidays, attempts, contacts, optedOut, stopConditions] = await Promise.all([
    readEffectiveBreaker(scope),
    loadHolidays(todayKey, addDays(todayKey, HOLIDAY_LOOKAHEAD_DAYS)),
    countAttempts(eventId),
    countWeeklyContacts(event.customerId, now),
    isOptedOut(event.customerId),
    firedStopConditions(eventId, event.state),
  ]);

  return {
    breakerScope: scope,
    context: {
      now,
      breakerOpen: breaker.open,
      breakerReason: breaker.reason ?? undefined,
      customerOptedOut: optedOut,
      firedStopConditions: stopConditions,
      attemptsSoFar: attempts,
      contactsThisWeek: contacts,
      bankHolidays: holidays,
      proposedDiscountPct,
    },
  };
}

async function countAttempts(eventId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(recoveryAttempts)
    .where(eq(recoveryAttempts.eventId, eventId));
  return row?.n ?? 0;
}

/**
 * Contacts to this customer in the trailing 7 days, counted as *messages
 * actually sent* rather than attempts planned. An attempt that never reached
 * anyone did not consume the customer's patience, and counting it would make
 * the cap quietly stricter than the policy says.
 */
async function countWeeklyContacts(customerId: string | null, now: Date): Promise<number> {
  if (!customerId) return 0;
  const since = new Date(now.getTime() - WEEK_MS);
  const [row] = await db
    .select({ n: count() })
    .from(messages)
    .innerJoin(recoveryAttempts, eq(messages.attemptId, recoveryAttempts.id))
    .innerJoin(paymentEvents, eq(recoveryAttempts.eventId, paymentEvents.id))
    .where(
      and(
        eq(paymentEvents.customerId, customerId),
        isNotNull(messages.sentAt),
        gte(messages.sentAt, since),
      ),
    );
  return row?.n ?? 0;
}

async function isOptedOut(customerId: string | null): Promise<boolean> {
  if (!customerId) return false;
  const [row] = await db
    .select({ optedOutAt: customers.optedOutAt })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  return Boolean(row?.optedOutAt);
}

/**
 * Which stop conditions have already fired for this event.
 *
 * `payment_success` and `refund_issued` are read from the event's own state.
 * `customer_opt_out` is handled by its own rule ahead of this one, so it is
 * not duplicated here. `complaint_keyword_detected` is set when an inbound
 * reply trips the linter — recorded on the message, so it is read from there.
 */
async function firedStopConditions(
  eventId: string,
  state: string,
): Promise<StopCondition[]> {
  const fired: StopCondition[] = [];
  if (state === 'recovered') fired.push('payment_success');
  if (state === 'stopped') fired.push('refund_issued');

  const [row] = await db
    .select({ n: count() })
    .from(messages)
    .innerJoin(recoveryAttempts, eq(messages.attemptId, recoveryAttempts.id))
    .where(
      and(
        eq(recoveryAttempts.eventId, eventId),
        isNotNull(messages.repliedBody),
        raw`${messages.repliedBody} ~* '(complain|fraud|scam|harass|consumer court|rbi)'`,
      ),
    );
  if ((row?.n ?? 0) > 0) fired.push('complaint_keyword_detected');

  return fired;
}
