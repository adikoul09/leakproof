/**
 * GET /api/replay/:runId → status, baseline, replayed metrics, changed decisions.
 *
 * The response keeps the measured and the modelled numbers in separate objects
 * on purpose. Decision, contact, message and cost deltas are exact. Revenue is
 * a model with its assumption written into the payload, so a client cannot
 * render it as a measurement without going out of its way.
 */
import { NextResponse } from 'next/server';
import { getRun } from '@/core/replay/store';
import type { ReplayResult } from '@/core/replay/engine';
import { errorResponse, requestId } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const reqId = requestId();
  const { runId } = await ctx.params;

  const row = await getRun(runId);
  if (!row) return errorResponse(404, 'BAD_REQUEST', `no replay run ${runId}`, undefined, reqId);

  const flags = (row.flags ?? {}) as { result?: ReplayResult; error?: string };
  const status = flags.error ? 'failed' : row.finishedAt ? 'complete' : 'running';

  return NextResponse.json(
    {
      run: {
        id: row.id,
        corpus: row.corpus,
        policy_version: row.policyVersion,
        seed: row.seed,
        events_count: row.eventsCount,
        started_at: row.startedAt,
        finished_at: row.finishedAt,
        status,
        error: flags.error ?? null,
      },
      result: flags.result ?? null,
    },
    { headers: { 'x-request-id': reqId } },
  );
}
