/**
 * POST /api/webhooks/razorpay — public, signature-verified.
 *
 * Order of operations is fixed and load-bearing (blueprint 6.4):
 *   verify HMAC-SHA256 over the RAW body
 *   → replay guard on x-razorpay-event-id
 *   → insert receipt
 *   → emit onto the durable bus
 *   → 200 in under 200ms
 *
 * No classification, no policy, no network calls to anyone but Inngest happen
 * here. Razorpay retries anything slow or non-2xx, so the handler stays thin.
 */
import { NextResponse } from 'next/server';
import { db } from '@/db/client';
import { webhookReceipts } from '@/db/schema';
import { errorResponse, requestId } from '@/lib/errors';
import { hmacSha256Hex, safeEqualHex } from '@/lib/hash';
import { inngest } from '@/lib/inngest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const reqId = requestId();
  const started = Date.now();

  // Raw body — the signature is over the exact bytes Razorpay sent. Parsing
  // and re-serialising first is the classic way to break webhook verification.
  const raw = await req.text();

  const signature = req.headers.get('x-razorpay-signature');
  const eventId = req.headers.get('x-razorpay-event-id');

  if (!eventId) {
    return errorResponse(400, 'BAD_REQUEST', 'Missing x-razorpay-event-id header', undefined, reqId);
  }

  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (secret) {
    if (!signature || !safeEqualHex(hmacSha256Hex(raw, secret), signature)) {
      return errorResponse(401, 'INVALID_SIGNATURE', 'Webhook signature did not verify', undefined, reqId);
    }
  } else if (process.env.NODE_ENV === 'production') {
    // Refusing to run unverified in production is the safe failure, not a TODO.
    return errorResponse(
      401,
      'INVALID_SIGNATURE',
      'RAZORPAY_WEBHOOK_SECRET is not configured; refusing to accept unverified webhooks',
      undefined,
      reqId,
    );
  } else {
    // Local development before the webhook is registered in the Razorpay
    // dashboard (which needs a public URL first). Logged loudly, never silent.
    console.warn(
      `[webhook ${reqId}] RAZORPAY_WEBHOOK_SECRET unset — accepting UNVERIFIED webhook ${eventId}`,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return errorResponse(400, 'BAD_REQUEST', 'Body is not valid JSON', undefined, reqId);
  }

  const eventType =
    (typeof body === 'object' && body !== null && (body as { event?: string }).event) || 'unknown';

  let inserted;
  try {
    // The primary key on event_id IS the replay guard. Redis would only make
    // it faster, not more correct — the database is the source of truth.
    inserted = await db
      .insert(webhookReceipts)
      .values({
        eventId,
        eventType,
        signature: signature ?? 'unverified',
        payload: body,
      })
      .onConflictDoNothing({ target: webhookReceipts.eventId })
      .returning({ eventId: webhookReceipts.eventId });
  } catch (err) {
    // Database down → 503 so Razorpay retries. Nothing is silently lost.
    console.error(`[webhook ${reqId}] receipt insert failed`, err);
    return errorResponse(
      503,
      'STORAGE_UNAVAILABLE',
      'Could not persist webhook receipt; retry expected',
      undefined,
      reqId,
    );
  }

  if (inserted.length === 0) {
    return NextResponse.json(
      { ok: true, duplicate: true },
      { status: 409, headers: { 'x-request-id': reqId } },
    );
  }

  try {
    await inngest.send({ name: 'webhook.received', data: { receiptId: eventId, eventType } });
  } catch (err) {
    // The receipt is already durable; a failed enqueue is recoverable by
    // replaying unprocessed receipts, so this is not a 5xx to Razorpay.
    console.error(`[webhook ${reqId}] inngest enqueue failed for ${eventId}`, err);
  }

  return NextResponse.json(
    { ok: true, duplicate: false },
    {
      status: 200,
      headers: { 'x-request-id': reqId, 'x-handler-ms': String(Date.now() - started) },
    },
  );
}
