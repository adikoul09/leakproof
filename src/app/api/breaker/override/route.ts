/**
 * POST /api/breaker/override — a human closes (or opens) the circuit breaker.
 *
 * Requires a typed reason. This is a human overriding an automated safety
 * control, and an override with no stated reason is exactly the thing an
 * auditor asks about six months later.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { GLOBAL_SCOPE } from '@/core/policy/breaker';
import { closeBreaker, openBreaker, readBreaker } from '@/core/policy/breaker-store';
import { appendLedgerSafe } from '@/core/ledger/append';
import { requireOperator } from '@/lib/auth';
import { errorResponse, requestId } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  scope: z.string().min(1).default(GLOBAL_SCOPE),
  action: z.enum(['open', 'close']),
  reason: z.string().min(10, 'state a reason of at least 10 characters'),
});

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
    return errorResponse(
      422,
      'BAD_REQUEST',
      parsed.error.issues[0]?.message ?? 'invalid override request',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      reqId,
    );
  }

  const { scope, action, reason } = parsed.data;
  const actor = `operator:${auth.operator.email}`;

  if (action === 'close') {
    await closeBreaker(scope, actor, reason);
  } else {
    await openBreaker(
      scope,
      { shouldOpen: true, observed: 0, threshold: 0, trigger: 'manual override', explanation: reason },
      actor,
      reason,
    );
  }

  const receipt = await appendLedgerSafe({
    action: action === 'close' ? 'breaker_closed_by_operator' : 'breaker_opened_by_operator',
    actor,
    detail: { scope, reason },
  });

  return NextResponse.json(
    {
      ...(await readBreaker(scope)),
      actor,
      reason,
      ledger_seq: receipt?.seq ?? null,
      ...(receipt ? {} : { warning: 'breaker changed but the ledger receipt failed to write' }),
    },
    { headers: { 'x-request-id': reqId } },
  );
}
