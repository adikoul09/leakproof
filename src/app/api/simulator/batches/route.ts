/** GET /api/simulator/batches — recent generator runs, newest first. */
import { NextResponse } from 'next/server';
import { listBatches } from '@/core/simulator/store';
import { requestId } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const reqId = requestId();
  const limit = Math.min(100, Number(new URL(req.url).searchParams.get('limit') ?? 25) || 25);
  const rows = await listBatches(limit);
  return NextResponse.json(
    { batches: rows },
    { status: 200, headers: { 'x-request-id': reqId } },
  );
}
