/**
 * GET  /api/outages — open and historical outage windows, plus the agreement
 *                     scorecard against Razorpay's Payment Downtime API.
 * POST /api/outages/detect — run detection now instead of waiting for the cron.
 */
import { NextResponse } from 'next/server';
import { desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { outageWindows } from '@/db/schema';
import { agreementScorecard } from '@/core/outage/detect';
import { requestId } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const reqId = requestId();
  const [rows, scorecard] = await Promise.all([
    db.select().from(outageWindows).orderBy(desc(outageWindows.startedAt)).limit(100),
    agreementScorecard(),
  ]);

  return NextResponse.json(
    {
      windows: rows.map((w) => ({
        id: w.id,
        cohort_key: w.cohortKey,
        issuer: w.issuer,
        method: w.method,
        started_at: w.startedAt,
        ended_at: w.endedAt,
        open: w.endedAt === null,
        peak_decline_rate: w.peakDeclineRate === null ? null : Number(w.peakDeclineRate),
        events_affected: w.eventsAffected,
        paise_parked: w.paiseParked,
        detected_by: w.detectedBy,
        downtime_api_agrees: w.downtimeApiAgrees,
        downtime_api_why: w.downtimeApiWhy,
        downtime_api_start: w.downtimeApiStart,
        downtime_api_end: w.downtimeApiEnd,
        /** Negative means Razorpay's feed saw it before we did. */
        detection_lead_s: w.detectionLeadS,
      })),
      scorecard,
    },
    { headers: { 'x-request-id': reqId } },
  );
}
