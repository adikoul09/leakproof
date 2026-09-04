/**
 * POST /api/replay — blueprint 6.4.
 *
 *   { "corpus":"recent", "policy_version":"3.3-draft",
 *     "flags":{"disable_llm":true,"naive_rails":true}, "seed":42 }
 *   → 202 { run_id }
 *
 * GET /api/replay — recent runs, plus the corpora that currently have events.
 *
 * Operator-guarded: a replay reads the whole corpus and writes a run row, and
 * the demo URL is public.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { corpusSizes } from '@/core/replay/corpus';
import { createRun, listRuns } from '@/core/replay/store';
import { listPolicies } from '@/core/policy/store';
import { requireOperator } from '@/lib/auth';
import { errorResponse, requestId } from '@/lib/errors';
import { inngest } from '@/lib/inngest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  corpus: z.enum(['recent', 'outage_window', 'adversarial', 'batch']).default('recent'),
  /** A published or draft version, or 'live' for whatever is currently live. */
  policy_version: z.string().min(1).default('live'),
  limit: z.number().int().min(1).max(20_000).default(3000),
  batch_id: z.uuid().optional(),
  flags: z
    .object({
      disable_llm: z.boolean().default(false),
      naive_rails: z.boolean().default(false),
      /** Re-assign arms under a different salt. What-if only — see the caveat. */
      alt_salt: z.string().min(8).optional(),
    })
    .default({ disable_llm: false, naive_rails: false }),
  /** What-if on the detector itself. Omitted replays the deployed thresholds. */
  thresholds: z
    .object({
      minCohortN: z.number().int().min(1).max(500),
      sigmaMultiplier: z.number().min(0).max(10),
      absoluteFloor: z.number().min(0).max(1),
    })
    .optional(),
  seed: z.number().int().default(42),
});

export async function GET() {
  const [runs, sizes, policies] = await Promise.all([
    listRuns(20),
    corpusSizes(),
    listPolicies(),
  ]);
  return NextResponse.json({
    runs: runs.map((r) => ({
      id: r.id,
      corpus: r.corpus,
      policy_version: r.policyVersion,
      seed: r.seed,
      events_count: r.eventsCount,
      started_at: r.startedAt,
      finished_at: r.finishedAt,
    })),
    corpus_sizes: sizes,
    policies,
  });
}

export async function POST(req: Request) {
  const reqId = requestId();

  const auth = requireOperator(req);
  if (!auth.ok) return errorResponse(401, 'UNAUTHORIZED', auth.reason, undefined, reqId);

  let json: unknown = {};
  try {
    json = await req.json();
  } catch {
    /* defaults are documented and fine */
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return errorResponse(
      422,
      'BAD_REQUEST',
      'Replay spec failed validation',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      reqId,
    );
  }

  const b = parsed.data;
  const runId = await createRun({
    corpus: b.corpus,
    policyVersion: b.policy_version,
    flags: {
      ...b.flags,
      limit: b.limit,
      batch_id: b.batch_id,
      thresholds: b.thresholds,
    },
    seed: b.seed,
  });

  await inngest.send({ name: 'replay.run', data: { runId } });

  return NextResponse.json(
    { run_id: runId, status: 'running' },
    { status: 202, headers: { 'x-request-id': reqId } },
  );
}
