/**
 * GET /api/events?filter=&limit=&cursor=&batch_id=
 *
 * The at-risk queue behind the Control Tower's main table. Keyset pagination:
 * the queue is live-appending, and an OFFSET would silently skip or repeat rows
 * as new events land above the cursor.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { loadQueue } from '@/core/tower/queue';
import { errorResponse, requestId } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  filter: z
    .enum(['all', 'systemic', 'idiosyncratic', 'blocked', 'control', 'recovered'])
    .default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
  batch_id: z.uuid().optional(),
});

export async function GET(req: Request) {
  const reqId = requestId();
  const parsed = querySchema.safeParse(
    Object.fromEntries(new URL(req.url).searchParams),
  );
  if (!parsed.success) {
    return errorResponse(
      422,
      'BAD_REQUEST',
      'Invalid query parameters',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      reqId,
    );
  }

  const { filter, limit, cursor, batch_id: batchId } = parsed.data;
  const page = await loadQueue({ filter, limit, cursor, batchId });
  return NextResponse.json(page, { headers: { 'x-request-id': reqId } });
}
