/**
 * `ingest.webhook` — blueprint 6.6.
 *
 * Runs off the durable bus, not inline in the route handler, because the
 * webhook must answer Razorpay in under 200ms or it gets retried. Everything
 * expensive lives here.
 */
import { NonRetriableError } from 'inngest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { armAssignments, webhookReceipts } from '@/db/schema';
import { normalizeWebhook } from '@/core/ingest/normalize';
import { insertPaymentEvent, upsertCustomer } from '@/core/ingest/persist';
import { cohortDim } from '@/core/triage/classifier';
import { recordLinkPaid, recordPaymentCaptured } from '@/core/experiment/recovery';
import { appendLedgerSafe } from '@/core/ledger/append';
import { postgresCohortStore } from '@/core/triage/cohort-store';
import { inngest } from '@/lib/inngest';

export const ingestWebhook = inngest.createFunction(
  { id: 'ingest-webhook', name: 'ingest.webhook', retries: 3 },
  { event: 'webhook.received' },
  async ({ event, step }) => {
    const { receiptId } = event.data;

    const receipt = await step.run('load-receipt', async () => {
      const [row] = await db
        .select()
        .from(webhookReceipts)
        .where(eq(webhookReceipts.eventId, receiptId))
        .limit(1);
      if (!row) throw new NonRetriableError(`webhook receipt ${receiptId} not found`);
      return row;
    });

    const normalized = normalizeWebhook(receipt.payload);

    // A recovery signal is handled before anything else: a paid link or a
    // captured payment closes an at-risk event, and that is what the entire
    // incrementality result is measured from.
    if (normalized.recovery) {
      const rec = normalized.recovery;
      const outcome = await step.run('record-recovery', async () =>
        rec.kind === 'link_paid'
          ? recordLinkPaid(rec.referenceId, rec.amountPaise, new Date(rec.at))
          : recordPaymentCaptured(rec.paymentId, rec.orderId, rec.amountPaise, new Date(rec.at)),
      );
      if (outcome.eventId) {
        // The receipt for a rupee coming back. `attributed` distinguishes a
        // link we sent from an organic recovery, which is the difference the
        // whole incrementality result turns on.
        if (!outcome.alreadyRecovered) {
          const arm = await step.run('load-arm', async () => {
            const [a] = await db
              .select({ arm: armAssignments.arm })
              .from(armAssignments)
              .where(eq(armAssignments.eventId, outcome.eventId!))
              .limit(1);
            return a?.arm ?? null;
          });
          await step.run('ledger-recovered', () =>
            appendLedgerSafe({
              eventId: outcome.eventId,
              arm,
              action: 'recovered',
              outcome: rec.kind === 'link_paid' ? 'paid_via_link' : 'paid_organically',
              detail: {
                attributed: outcome.attributed,
                amount_paise: rec.amountPaise,
                signal: rec.kind,
              },
            }),
          );
        }
        await step.run('mark-processed', () => markProcessed(receiptId));
        return {
          recovered: outcome.eventId,
          attributed: outcome.attributed,
          duplicate: outcome.alreadyRecovered,
        };
      }
      // No open failure matched — fall through so a successful payment still
      // feeds the cohort denominator.
    }

    if (!normalized.event) {
      await step.run('mark-processed', () => markProcessed(receiptId));
      return { skipped: 'unhandled_event_type', eventType: receipt.eventType };
    }

    const { event: pe, customer, outcome } = normalized;
    const dim = cohortDim(pe);

    // Successes exist only to give the cohort decline rate a denominator.
    if (outcome === 'succeeded') {
      await step.run('observe-success', () => postgresCohortStore.observe(dim, pe.failedAt, false));
      await step.run('mark-processed', () => markProcessed(receiptId));
      return { observed: 'success', cohortDim: dim };
    }

    if (outcome !== 'failed') {
      await step.run('mark-processed', () => markProcessed(receiptId));
      return { skipped: 'not_a_payment_outcome', eventType: receipt.eventType };
    }

    if (customer) {
      await step.run('upsert-customer', () => upsertCustomer(customer));
    }

    const isNew = await step.run('insert-payment-event', () => insertPaymentEvent(pe));

    // Only count a failure once, however many times Razorpay redelivers it.
    if (isNew) {
      await step.run('observe-failure', () => postgresCohortStore.observe(dim, pe.failedAt, true));
    }

    await step.run('mark-processed', () => markProcessed(receiptId));

    if (!isNew) return { duplicate: true, eventId: pe.id };

    await step.sendEvent('queue-triage', {
      name: 'event.ready_for_triage',
      data: { eventId: pe.id, source: 'webhook' as const },
    });

    return { eventId: pe.id, cohortDim: dim };
  },
);

async function markProcessed(receiptId: string) {
  await db
    .update(webhookReceipts)
    .set({ processedAt: new Date() })
    .where(eq(webhookReceipts.eventId, receiptId));
}
