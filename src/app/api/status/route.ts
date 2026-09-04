/**
 * GET /api/status — breaker state, live outages, at-risk totals, failure mix.
 *
 * One call for everything above the queue, so the tower's header does not make
 * five round trips on every poll.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { atRiskNow } from '@/core/tower/queue';
import { TRIAGE_THRESHOLDS, failureMix, loadStatus } from '@/core/tower/status';
import { errorResponse, requestId } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  window_minutes: z.coerce.number().int().min(5).max(10_080).default(60),
  batch_id: z.uuid().optional(),
});

export async function GET(req: Request) {
  const reqId = requestId();
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) {
    return errorResponse(422, 'BAD_REQUEST', 'Invalid query parameters', undefined, reqId);
  }

  const { window_minutes: windowMinutes, batch_id: batchId } = parsed.data;
  const [status, atRisk, mix] = await Promise.all([
    loadStatus(windowMinutes),
    atRiskNow(batchId),
    failureMix(windowMinutes),
  ]);

  return NextResponse.json(
    {
      ...status,
      at_risk_now: { events: atRisk.n, paise: atRisk.paise },
      failure_mix: mix,
      thresholds: TRIAGE_THRESHOLDS,
      // The tower renders a TEST MODE pill permanently; the flag comes from the
      // key in use rather than being hardcoded in the client.
      mode: (process.env.RAZORPAY_KEY_ID ?? '').startsWith('rzp_live') ? 'live' : 'test',
      server_time: new Date().toISOString(),
    },
    { headers: { 'x-request-id': reqId } },
  );
}
