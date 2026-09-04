/**
 * POST /api/events/ingest — internal, used by the synthetic data generator.
 *
 * Deliberately lands on the *same* pipeline as the webhook: it writes
 * payment_events rows and emits `event.ready_for_triage`, so classification,
 * policy and recovery cannot tell a synthetic event from a real one. If the
 * simulator had its own code path the demo would be proving nothing.
 *
 * Thin by design — validate, call `ingestBatch`, serialise. The behaviour lives
 * in `src/core/ingest/ingest-batch.ts` so the simulator's Inngest job can reuse
 * it without an HTTP round trip back into the app it is already running inside.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { type IngestEvent, ingestBatch } from '@/core/ingest/ingest-batch';
import { errorResponse, requestId } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

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
   * Successes carry no at-risk row; they feed the cohort denominator, and when
   * they carry an order id they also close the failure on that order. Without
   * them every cohort reads 100% declined and the systemic test, which is the
   * whole point of the classifier, is meaningless.
   */
  outcome: z.enum(['failed', 'succeeded']).default('failed'),
});

const bodySchema = z.object({
  events: z.array(eventSchema).min(1).max(5000),
  batch_id: z.uuid().optional(),
});

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

  const result = await ingestBatch(
    parsed.data.events as IngestEvent[],
    parsed.data.batch_id ?? null,
    `ingest ${reqId}`,
  );

  return NextResponse.json(result, { status: 202, headers: { 'x-request-id': reqId } });
}
