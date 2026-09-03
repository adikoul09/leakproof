/**
 * POST /api/policies/:version/publish — make a version live.
 *
 * The previous live version is archived in the same transaction. Existing
 * ledger and policy_evaluation rows keep the version they were decided under;
 * a publish is never retroactive.
 */
import { NextResponse } from 'next/server';
import { getPolicy, publishPolicy } from '@/core/policy/store';
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

  // TODO(milestone 5): write the ledger row for this publish. The chain does
  // not exist yet; when it does, a policy publish is a first-class actor event.
  return NextResponse.json(
    {
      version: published.version,
      status: published.status,
      published_at: published.publishedAt,
      actor: `operator:${auth.operator.email}`,
    },
    { headers: { 'x-request-id': reqId } },
  );
}
