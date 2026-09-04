/**
 * POST /api/simulator/push-to-razorpay — blueprint 6.4. 🔒
 *
 * Takes a subset of a generated batch and creates REAL test-mode Razorpay
 * orders for it, writing the returned order ids back onto the synthetic events.
 * The point is grounding: after this runs, a judge can take an order id off the
 * at-risk queue and find it in the Razorpay dashboard.
 *
 * ⚠️ What this does not do, and the response says so on every call: it does not
 * manufacture a real decline. Razorpay creates payments through the checkout
 * flow, not this API, so a genuine failed payment cannot be produced
 * server-side without S2S activation. The error payloads in a synthetic batch
 * are modelled on Razorpay's documented taxonomy. The real-API grounding that
 * *does* exist end to end is the recovery rail — payment links in milestone 3
 * are created, delivered and paid for real.
 */
import { NextResponse } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { paymentEvents } from '@/db/schema';
import { RazorpayError, createOrder } from '@/core/rails/razorpay';
import { appendLedgerSafe } from '@/core/ledger/append';
import { requireOperator } from '@/lib/auth';
import { errorResponse, requestId } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const bodySchema = z.object({
  count: z.number().int().min(1).max(50).default(20),
  batch_id: z.uuid().optional(),
});

export async function POST(req: Request) {
  const reqId = requestId();

  const auth = requireOperator(req);
  if (!auth.ok) return errorResponse(401, 'UNAUTHORIZED', auth.reason, undefined, reqId);

  let json: unknown = {};
  try {
    json = await req.json();
  } catch {
    /* an empty body is fine — the defaults are the documented ones */
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return errorResponse(
      422,
      'BAD_REQUEST',
      'push-to-razorpay payload failed validation',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      reqId,
    );
  }

  const { count, batch_id: batchId } = parsed.data;

  // Only synthetic events that have not already been grounded. Re-running must
  // not create a second order for a payment that already has one — Razorpay
  // would happily accept it and the ids would stop meaning anything.
  const rows = await db
    .select({
      id: paymentEvents.id,
      amountPaise: paymentEvents.amountPaise,
      currency: paymentEvents.currency,
      method: paymentEvents.method,
      issuer: paymentEvents.issuer,
      errReason: paymentEvents.errReason,
    })
    .from(paymentEvents)
    .where(
      and(
        eq(paymentEvents.isSynthetic, true),
        isNull(paymentEvents.orderId),
        ...(batchId ? [eq(paymentEvents.batchId, batchId)] : []),
      ),
    )
    .limit(count);

  if (rows.length === 0) {
    return NextResponse.json(
      {
        pushed: 0,
        failed: 0,
        note: 'No synthetic events without an order id. Generate a batch first, or pass a different batch_id.',
      },
      { status: 200, headers: { 'x-request-id': reqId } },
    );
  }

  const pushed: Array<{ event_id: string; order_id: string; amount_paise: number }> = [];
  const failures: Array<{ event_id: string; error: string }> = [];

  for (const r of rows) {
    try {
      const order = await createOrder({
        amountPaise: r.amountPaise,
        currency: r.currency,
        // The receipt is the thread back from the Razorpay dashboard to our row.
        receipt: r.id,
        notes: {
          source: 'leakproof-simulator',
          synthetic: 'true',
          method: r.method ?? 'unknown',
          issuer: r.issuer ?? 'unknown',
          failure_reason: r.errReason ?? 'unknown',
        },
      });

      await db
        .update(paymentEvents)
        .set({ orderId: order.id })
        .where(eq(paymentEvents.id, r.id));

      // Grounding a synthetic event in a real API call is a decision about the
      // corpus the headline number is computed over, so it gets a receipt.
      await appendLedgerSafe({
        eventId: r.id,
        failureClass: 'unknown',
        action: 'grounded_in_razorpay',
        detail: {
          order_id: order.id,
          amount_paise: order.amount,
          receipt: order.receipt,
          mode: 'test',
          operator: auth.operator.email,
        },
      });

      pushed.push({ event_id: r.id, order_id: order.id, amount_paise: r.amountPaise });
    } catch (err) {
      const message =
        err instanceof RazorpayError ? `${err.code}: ${err.message}` : (err as Error).message;
      console.error(`[push-to-razorpay ${reqId}] ${r.id}`, message);
      failures.push({ event_id: r.id, error: message });
    }
  }

  return NextResponse.json(
    {
      pushed: pushed.length,
      failed: failures.length,
      orders: pushed,
      errors: failures,
      caveat:
        'These are real test-mode ORDERS, not real declines. Razorpay creates payments through ' +
        'checkout, not this API, so a genuine failed payment cannot be produced server-side. ' +
        'The failure payloads in a synthetic batch are modelled on the documented error taxonomy. ' +
        'The recovery rail is the part that is real end to end.',
    },
    { status: 200, headers: { 'x-request-id': reqId } },
  );
}
