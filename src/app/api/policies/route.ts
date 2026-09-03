/**
 * GET  /api/policies  — list versions with status
 * POST /api/policies  — validate and store a new draft
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createDraft, listPolicies } from '@/core/policy/store';
import { requireOperator } from '@/lib/auth';
import { errorResponse, requestId } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const items = await listPolicies();
  return NextResponse.json({ items });
}

const bodySchema = z.object({ yaml_source: z.string().min(1) });

export async function POST(req: Request) {
  const reqId = requestId();

  const auth = requireOperator(req);
  if (!auth.ok) return errorResponse(401, 'UNAUTHORIZED', auth.reason, undefined, reqId);

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return errorResponse(400, 'BAD_REQUEST', 'Body is not valid JSON', undefined, reqId);
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return errorResponse(400, 'BAD_REQUEST', 'Expected { yaml_source: string }', undefined, reqId);
  }

  const result = await createDraft(parsed.data.yaml_source, `operator:${auth.operator.email}`);
  if (!result.ok) {
    return errorResponse(
      422,
      'POLICY_VALIDATION_FAILED',
      result.issues[0]?.message ?? 'policy failed validation',
      result.issues,
      reqId,
    );
  }

  return NextResponse.json(result, { status: 201, headers: { 'x-request-id': reqId } });
}
