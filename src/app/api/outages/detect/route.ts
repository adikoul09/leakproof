/**
 * POST /api/outages/detect — run outage detection now.
 *
 * The cron runs every 5 minutes; this exists so a demo does not have to wait
 * for it. Operator-guarded: it writes outage windows and calls Razorpay.
 */
import { NextResponse } from 'next/server';
import { backfillOutages, detectOutages } from '@/core/outage/detect';
import { requireOperator } from '@/lib/auth';
import { errorResponse, requestId } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(req: Request) {
  const reqId = requestId();
  const auth = requireOperator(req);
  if (!auth.ok) return errorResponse(401, 'UNAUTHORIZED', auth.reason, undefined, reqId);

  const url = new URL(req.url);
  const skipDowntimeApi = url.searchParams.get('skip_downtime_api') === 'true';

  /**
   * `?backfill=true` reconstructs historical windows from a corpus instead of
   * opening and closing them as events arrive. A generated batch replays a
   * whole day in eight minutes, so by the time anyone looks the incident is
   * hours old and the live path — which only looks back far enough to track a
   * stream — correctly finds nothing.
   */
  const result =
    url.searchParams.get('backfill') === 'true'
      ? await backfillOutages({
          batchId: url.searchParams.get('batch_id') ?? undefined,
          skipDowntimeApi,
        })
      : await detectOutages({ now: new Date(), skipDowntimeApi });

  return NextResponse.json(result, { headers: { 'x-request-id': reqId } });
}
