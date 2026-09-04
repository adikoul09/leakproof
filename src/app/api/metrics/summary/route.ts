/**
 * GET /api/metrics/summary?from=&to=&seed=
 *
 * The judged number. Everything needed to check it by hand is in the response:
 * per-arm counts, the bootstrap seed and iteration count, the power blockers,
 * the randomisation balance check, and which cost rates are still placeholders.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { metricsSummary } from '@/core/experiment/metrics-store';
import { errorResponse, requestId } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  seed: z.coerce.number().int().optional(),
  iterations: z.coerce.number().int().min(100).max(20_000).optional(),
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

  const { from, to, seed, iterations } = parsed.data;
  const summary = await metricsSummary(
    { from: from ? new Date(from) : undefined, to: to ? new Date(to) : undefined },
    { bootstrapSeed: seed, bootstrapIterations: iterations },
  );

  return NextResponse.json(summary, { headers: { 'x-request-id': reqId } });
}
