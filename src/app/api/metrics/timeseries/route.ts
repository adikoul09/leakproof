/**
 * GET /api/metrics/timeseries?bucket=5m&from=&to=
 *
 * Cumulative recovered rupees per arm. The chart this feeds is the one that
 * makes the argument visually: three lines diverging, with the control line
 * showing what would have come back on its own.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { metricsTimeseries } from '@/core/experiment/metrics-store';
import { errorResponse, requestId } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BUCKETS: Record<string, number> = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '1d': 1440 };

const querySchema = z.object({
  bucket: z.enum(['1m', '5m', '15m', '1h', '1d']).default('5m'),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

export async function GET(req: Request) {
  const reqId = requestId();
  const url = new URL(req.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));

  if (!parsed.success) {
    return errorResponse(
      422,
      'BAD_REQUEST',
      'Invalid query parameters',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      reqId,
    );
  }

  const { bucket, from, to } = parsed.data;
  const points = await metricsTimeseries(BUCKETS[bucket], {
    from: from ? new Date(from) : undefined,
    to: to ? new Date(to) : undefined,
  });

  return NextResponse.json({ bucket, points }, { headers: { 'x-request-id': reqId } });
}
