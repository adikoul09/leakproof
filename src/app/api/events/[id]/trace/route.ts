/**
 * GET /api/events/:id/trace — blueprint Screen 3.
 *
 * Everything behind one decision: the raw Razorpay error, the classification
 * and the cohort numbers it was tested against, the arm and its reproducible
 * hash input, every policy rule with the values compared, the rail choice and
 * its alternatives, the message, and the ledger records that receipt it.
 */
import { NextResponse } from 'next/server';
import { loadTrace } from '@/core/tower/trace';
import { errorResponse, requestId } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const reqId = requestId();
  const { id } = await ctx.params;
  const trace = await loadTrace(id);
  if (!trace) return errorResponse(404, 'BAD_REQUEST', `no event ${id}`, undefined, reqId);
  return NextResponse.json(trace, { headers: { 'x-request-id': reqId } });
}
