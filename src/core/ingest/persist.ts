/**
 * Database writes for ingestion. Kept out of the route handler and out of the
 * pure normaliser so both the webhook path and the simulator path share one
 * implementation.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { customers, paymentEvents } from '@/db/schema';
import type { NormalizedCustomer, NormalizedEvent } from './normalize';

export async function upsertCustomer(c: NormalizedCustomer): Promise<void> {
  await db
    .insert(customers)
    .values({
      id: c.id,
      phoneHash: c.phoneHash,
      phoneMasked: c.phoneMasked,
      emailHash: c.emailHash,
      emailMasked: c.emailMasked,
    })
    .onConflictDoNothing({ target: customers.id });
}

/**
 * Insert the at-risk unit. Returns false when the event already existed —
 * Razorpay retries webhooks, and a redelivery must not create a second
 * at-risk row or a second recovery attempt.
 */
export async function insertPaymentEvent(e: NormalizedEvent): Promise<boolean> {
  const inserted = await db
    .insert(paymentEvents)
    .values({
      id: e.id,
      surface: e.surface,
      customerId: e.customerId,
      amountPaise: e.amountPaise,
      currency: e.currency,
      method: e.method,
      issuer: e.issuer,
      cardNetwork: e.cardNetwork,
      amountBand: e.amountBand,
      timeBucket: e.timeBucket,
      errCode: e.errCode,
      errDescription: e.errDescription,
      errSource: e.errSource,
      errStep: e.errStep,
      errReason: e.errReason,
      state: 'at_risk',
      isSynthetic: e.isSynthetic,
      failedAt: e.failedAt,
    })
    .onConflictDoNothing({ target: paymentEvents.id })
    .returning({ id: paymentEvents.id });

  return inserted.length > 0;
}

export async function getPaymentEvent(id: string) {
  const [row] = await db.select().from(paymentEvents).where(eq(paymentEvents.id, id)).limit(1);
  return row ?? null;
}
