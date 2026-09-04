/**
 * Ingesting a batch of events, webhook-identical.
 *
 * Extracted from the route so the simulator's Inngest job can call it directly
 * instead of making an HTTP request back into the app it is already running
 * inside. Route handlers stay thin — validate, call, serialise.
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 *  - A `succeeded` event carrying an `order_id` is an ORGANIC RECOVERY, not a
 *    denominator tick. It runs through the same `recordPaymentCaptured` a real
 *    `payment.captured` webhook uses. Without this the control arm — which
 *    recovers by no other route — reads zero, and every incrementality number
 *    the project reports is inflated.
 *  - Order is preserved across the failure/recovery boundary. Writes are
 *    batched for speed, but a recovery flushes the failures queued ahead of it
 *    first, so a batch behaves exactly as the same events would arriving one
 *    request at a time.
 */
import { amountBand, istHour } from '@/core/triage/config';
import { cohortDim } from '@/core/triage/classifier';
import { type CohortObservation, observeMany } from '@/core/triage/cohort-store';
import { insertPaymentEvents, upsertCustomers } from '@/core/ingest/persist';
import { matchParkedRecoveries, recordOrganicRecovery } from '@/core/experiment/recovery';
import type { NormalizedCustomer, NormalizedEvent } from '@/core/ingest/normalize';
import { maskPhone, sha256 } from '@/lib/hash';
import { inngest } from '@/lib/inngest';

export interface IngestEvent {
  id: string;
  surface: 'payment' | 'subscription' | 'invoice';
  customer_id?: string;
  amount_paise: number;
  currency: string;
  method?: string | null;
  issuer?: string | null;
  card_network?: string | null;
  order_id?: string | null;
  err_code?: string | null;
  err_description?: string | null;
  err_source?: string | null;
  err_step?: string | null;
  err_reason?: string | null;
  failed_at: string;
  outcome: 'failed' | 'succeeded';
}

export interface IngestResult {
  accepted: number;
  rejected: number;
  at_risk_created: number;
  recoveries_matched: number;
  recoveries_parked: number;
  cohort_buckets_touched: number;
}

/**
 * Synthetic customers get a deterministic display mask derived from the id, so
 * the tower shows something plausible without inventing a real phone number
 * anywhere in the system.
 */
export function syntheticCustomer(customerId: string): NormalizedCustomer {
  const h = sha256(customerId);
  return {
    id: customerId,
    phoneHash: h,
    phoneMasked: maskPhone(`+9198${h.replace(/\D/g, '').padEnd(8, '0').slice(0, 8)}`),
    emailHash: null,
    emailMasked: null,
  };
}

function toNormalized(e: IngestEvent, batchId: string | null): NormalizedEvent & { batchId: string | null } {
  const failedAt = new Date(e.failed_at);
  return {
    id: e.id,
    surface: e.surface,
    customerId: e.customer_id ?? null,
    amountPaise: e.amount_paise,
    currency: e.currency,
    method: e.method ?? null,
    orderId: e.order_id ?? null,
    issuer: e.issuer ?? null,
    cardNetwork: e.card_network ?? null,
    amountBand: amountBand(e.amount_paise),
    timeBucket: istHour(failedAt),
    errCode: e.err_code ?? null,
    errDescription: e.err_description ?? null,
    errSource: e.err_source ?? null,
    errStep: e.err_step ?? null,
    errReason: e.err_reason ?? null,
    isSynthetic: true,
    batchId,
    failedAt,
  };
}

const dimOf = (e: IngestEvent) =>
  cohortDim({ issuer: e.issuer ?? null, method: e.method ?? null, amountPaise: e.amount_paise });

export async function ingestBatch(
  events: IngestEvent[],
  batchId: string | null,
  logPrefix = 'ingest',
): Promise<IngestResult> {
  const observations: CohortObservation[] = [];
  const queuedForTriage: string[] = [];

  let accepted = 0;
  let rejected = 0;
  let recoveriesMatched = 0;
  let recoveriesParked = 0;
  let pending: IngestEvent[] = [];
  /** Orders whose failure is queued but not yet written. */
  const pendingOrders = new Set<string>();

  /**
   * Write the queued failures. Called before any recovery is processed so that
   * a recovery can always see the failure it belongs to, and once at the end.
   */
  const flush = async () => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    pendingOrders.clear();

    await upsertCustomers(
      batch.filter((e) => e.customer_id).map((e) => syntheticCustomer(e.customer_id!)),
    );

    const newIds = await insertPaymentEvents(batch.map((e) => toNormalized(e, batchId)));

    // `newIds` says which rows were created, but a redelivery can appear TWICE
    // inside the same chunk — the insert collapses it to one row while this
    // loop would still see it twice. Counting it twice inflates the cohort's
    // failure count, which feeds the systemic detector, and queuing it twice
    // races two `recovery.plan` runs into the same (event_id, attempt_no).
    const counted = new Set<string>();
    for (const e of batch) {
      if (!newIds.has(e.id) || counted.has(e.id)) continue;
      counted.add(e.id);
      observations.push({ cohortDim: dimOf(e), at: new Date(e.failed_at), failed: true });
      queuedForTriage.push(e.id);
    }

    // A success may already be parked against one of these orders.
    const orderIds = batch.filter((e) => newIds.has(e.id) && e.order_id).map((e) => e.order_id!);
    recoveriesMatched += await matchParkedRecoveries([...new Set(orderIds)]);
  };

  for (const e of events) {
    try {
      if (e.outcome === 'failed') {
        pending.push(e);
        if (e.order_id) pendingOrders.add(e.order_id);
        accepted += 1;
        continue;
      }

      // Successes always move the denominator.
      observations.push({ cohortDim: dimOf(e), at: new Date(e.failed_at), failed: false });

      if (e.order_id) {
        // An organic recovery. Flush only when the failure it resolves is still
        // sitting unwritten in the queue — otherwise the row is already in the
        // table and a flush is a round trip to Singapore for nothing. Flushing
        // unconditionally turned every one of a batch's several hundred
        // recoveries into its own insert and made ingestion minutes slower.
        if (pendingOrders.has(e.order_id)) await flush();
        const r = await recordOrganicRecovery({
          paymentId: e.id,
          orderId: e.order_id,
          amountPaise: e.amount_paise,
          at: new Date(e.failed_at),
        });
        if (r.eventId) recoveriesMatched += 1;
        else recoveriesParked += 1;
      }
      accepted += 1;
    } catch (err) {
      console.error(`[${logPrefix}] failed on ${e.id}`, err);
      rejected += 1;
    }
  }

  try {
    await flush();
  } catch (err) {
    console.error(`[${logPrefix}] final flush failed`, err);
    rejected += pending.length;
  }

  const cohortBuckets = await observeMany(observations);

  if (queuedForTriage.length > 0) {
    // Inngest caps a single send; chunk rather than dropping the tail silently.
    for (let i = 0; i < queuedForTriage.length; i += 500) {
      await inngest.send(
        queuedForTriage.slice(i, i + 500).map((eventId) => ({
          name: 'event.ready_for_triage' as const,
          data: { eventId, source: 'simulator' as const },
        })),
      );
    }
  }

  return {
    accepted,
    rejected,
    at_risk_created: queuedForTriage.length,
    recoveries_matched: recoveriesMatched,
    recoveries_parked: recoveriesParked,
    cohort_buckets_touched: cohortBuckets,
  };
}
