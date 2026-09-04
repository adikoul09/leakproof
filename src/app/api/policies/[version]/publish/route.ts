/**
 * POST /api/policies/:version/publish — make a version live.
 *
 * The previous live version is archived in the same transaction. Existing
 * ledger and policy_evaluation rows keep the version they were decided under;
 * a publish is never retroactive.
 */
import { NextResponse } from 'next/server';
import { getPolicy, publishPolicy } from '@/core/policy/store';
import { appendLedgerSafe } from '@/core/ledger/append';
import { requireOperator } from '@/lib/auth';
import { errorResponse, requestId } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ version: string }> }) {
  const reqId = requestId();

  const auth = requireOperator(req);
  if (!auth.ok) return errorResponse(401, 'UNAUTHORIZED', auth.reason, undefined, reqId);

  const { version } = await ctx.params;
  const existing = await getPolicy(version);
  if (!existing) {
    return errorResponse(404, 'BAD_REQUEST', `policy ${version} not found`, undefined, reqId);
  }

  const published = await publishPolicy(version);

  const receipt = await appendLedgerSafe({
    policyVersion: published.version,
    action: 'policy_published',
    actor: `operator:${auth.operator.email}`,
    detail: {
      previous_status: existing.status,
      published_at: published.publishedAt?.toISOString() ?? null,
      caps: published.policy.caps,
      contact_window: published.policy.contact_window,
      breaker_trigger: published.policy.breaker.source,
    },
  });

  return NextResponse.json(
    {
      version: published.version,
      status: published.status,
      published_at: published.publishedAt,
      actor: `operator:${auth.operator.email}`,
      // Surfaced rather than assumed: if the receipt could not be written the
      // operator needs to know the change is live but unrecorded.
      ledger_seq: receipt?.seq ?? null,
      ...(receipt ? {} : { warning: 'policy is live but the ledger receipt failed to write' }),
    },
    { headers: { 'x-request-id': reqId } },
  );
}
