import { NextResponse } from 'next/server';
import { getPolicy } from '@/core/policy/store';
import { errorResponse, requestId } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ version: string }> }) {
  const { version } = await ctx.params;
  const stored = await getPolicy(version);
  if (!stored) {
    return errorResponse(404, 'BAD_REQUEST', `policy ${version} not found`, undefined, requestId());
  }
  return NextResponse.json({
    version: stored.version,
    yaml_source: stored.yamlSource,
    parsed: stored.policy,
    status: stored.status,
    published_at: stored.publishedAt,
    author: stored.author,
  });
}
