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
      orderId: e.orderId,
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

/**
 * Chunked bulk insert of at-risk rows. Returns the ids that were genuinely new.
 *
 * A generated batch carries tens of thousands of events. Inserting them one row
 * at a time is thirty thousand round trips to Singapore, which turns a demo
 * batch into a coffee break. The semantics are identical to
 * `insertPaymentEvent` — same conflict target, same "was it new" answer — so a
 * redelivered event still cannot create a second at-risk row.
 */
export async function insertPaymentEvents(
  events: Array<NormalizedEvent & { batchId?: string | null }>,
  chunkSize = 500,
): Promise<Set<string>> {
  const inserted = new Set<string>();
  for (let i = 0; i < events.length; i += chunkSize) {
    const chunk = events.slice(i, i + chunkSize);
    const rows = await db
      .insert(paymentEvents)
      .values(
        chunk.map((e) => ({
          id: e.id,
          surface: e.surface,
          customerId: e.customerId,
          amountPaise: e.amountPaise,
          currency: e.currency,
          method: e.method,
          orderId: e.orderId,
          issuer: e.issuer,
          cardNetwork: e.cardNetwork,
          amountBand: e.amountBand,
          timeBucket: e.timeBucket,
          errCode: e.errCode,
          errDescription: e.errDescription,
          errSource: e.errSource,
          errStep: e.errStep,
          errReason: e.errReason,
          state: 'at_risk' as const,
          isSynthetic: e.isSynthetic,
          batchId: e.batchId ?? null,
          failedAt: e.failedAt,
        })),
      )
      .onConflictDoNothing({ target: paymentEvents.id })
      .returning({ id: paymentEvents.id });
    for (const r of rows) inserted.add(r.id);
  }
  return inserted;
}

/** Chunked bulk customer upsert. Deduplicates by id before writing. */
export async function upsertCustomers(cs: NormalizedCustomer[], chunkSize = 500): Promise<void> {
  const unique = new Map(cs.map((c) => [c.id, c]));
  const rows = [...unique.values()];
  for (let i = 0; i < rows.length; i += chunkSize) {
    await db
      .insert(customers)
      .values(
        rows.slice(i, i + chunkSize).map((c) => ({
          id: c.id,
          phoneHash: c.phoneHash,
          phoneMasked: c.phoneMasked,
          emailHash: c.emailHash,
          emailMasked: c.emailMasked,
        })),
      )
      .onConflictDoNothing({ target: customers.id });
  }
}
