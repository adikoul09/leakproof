/**
 * POST /api/events/ingest — internal, used by the synthetic data generator.
 *
 * Deliberately lands on the *same* pipeline as the webhook: it writes
 * payment_events rows and emits `event.ready_for_triage`, so classification,
 * policy and recovery cannot tell a synthetic event from a real one. If the
 * simulator had its own code path the demo would be proving nothing.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { amountBand, istHour } from '@/core/triage/config';
import { cohortDim } from '@/core/triage/classifier';
import { postgresCohortStore } from '@/core/triage/cohort-store';
import { insertPaymentEvent, upsertCustomer } from '@/core/ingest/persist';
import { errorResponse, requestId } from '@/lib/errors';
import { maskPhone, sha256 } from '@/lib/hash';
import { inngest } from '@/lib/inngest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const eventSchema = z.object({
  id: z.string().min(1),
  surface: z.enum(['payment', 'subscription', 'invoice']).default('payment'),
  customer_id: z.string().min(1).optional(),
  amount_paise: z.number().int().nonnegative(),
  currency: z.string().default('INR'),
  method: z.string().nullable().optional(),
  issuer: z.string().nullable().optional(),
  card_network: z.string().nullable().optional(),
  /** Ties an organic retry back to the failure it resolves. */
  order_id: z.string().nullable().optional(),
  err_code: z.string().nullable().optional(),
  err_description: z.string().nullable().optional(),
  err_source: z.string().nullable().optional(),
  err_step: z.string().nullable().optional(),
  err_reason: z.string().nullable().optional(),
  failed_at: z.iso.datetime({ offset: true }),
  /**
   * Successes carry no at-risk row; they only feed the cohort denominator.
   * Without them every cohort reads 100% declined and the systemic test,
   * which is the whole point of the classifier, is meaningless.
   */
  outcome: z.enum(['failed', 'succeeded']).default('failed'),
});

const bodySchema = z.object({ events: z.array(eventSchema).min(1).max(5000) });

export async function POST(req: Request) {
  const reqId = requestId();

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return errorResponse(400, 'BAD_REQUEST', 'Body is not valid JSON', undefined, reqId);
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return errorResponse(
      422,
      'BAD_REQUEST',
      'Ingest payload failed validation',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      reqId,
    );
  }

  let accepted = 0;
  let rejected = 0;
  const queued: string[] = [];

  for (const e of parsed.data.events) {
    const failedAt = new Date(e.failed_at);
    const dim = cohortDim({
      issuer: e.issuer ?? null,
      method: e.method ?? null,
      amountPaise: e.amount_paise,
    });

    try {
      if (e.outcome === 'succeeded') {
        await postgresCohortStore.observe(dim, failedAt, false);
        accepted += 1;
        continue;
      }

      const customerId = e.customer_id ?? null;
      if (customerId) {
        const h = sha256(customerId);
        await upsertCustomer({
          id: customerId,
          phoneHash: h,
          // Synthetic customers get a deterministic display mask derived from
          // the id, so the tower shows something plausible without inventing
          // a real phone number anywhere in the system.
          phoneMasked: maskPhone(`+9198${h.replace(/\D/g, '').padEnd(8, '0').slice(0, 8)}`),
          emailHash: null,
          emailMasked: null,
        });
      }

      const isNew = await insertPaymentEvent({
        id: e.id,
        surface: e.surface,
        customerId,
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
        failedAt,
      });

      if (isNew) {
        await postgresCohortStore.observe(dim, failedAt, true);
        queued.push(e.id);
      }
      accepted += 1;
    } catch (err) {
      console.error(`[ingest ${reqId}] failed on ${e.id}`, err);
      rejected += 1;
    }
  }

  if (queued.length > 0) {
    await inngest.send(
      queued.map((eventId) => ({
        name: 'event.ready_for_triage' as const,
        data: { eventId, source: 'simulator' as const },
      })),
    );
  }

  return NextResponse.json(
    { accepted, rejected },
    { status: 202, headers: { 'x-request-id': reqId } },
  );
}
