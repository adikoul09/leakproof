/**
 * Operator guard for write endpoints.
 *
 * The blueprint's full auth is a JWT cookie set by /api/auth/login. That is not
 * built yet, and the demo URL is public — so publishing a policy or overriding
 * a circuit breaker must not be an open endpoint in the meantime. This is the
 * minimum that closes that hole: a shared operator key, constant-time compared.
 *
 * Replaced by the JWT session when auth lands. Until then, an unauthenticated
 * write is refused rather than quietly allowed.
 */
import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { sha256 } from './hash';

export interface Operator {
  email: string;
}

function constantTimeEquals(a: string, b: string): boolean {
  // Hash first so the compare is over fixed-length buffers regardless of input.
  const ba = Buffer.from(sha256(a), 'hex');
  const bb = Buffer.from(sha256(b), 'hex');
  return timingSafeEqual(ba, bb);
}

export type AuthResult = { ok: true; operator: Operator } | { ok: false; reason: string };

export function requireOperator(req: Request): AuthResult {
  const expected = process.env.OPERATOR_ACCESS_KEY;
  if (!expected) {
    return { ok: false, reason: 'OPERATOR_ACCESS_KEY is not configured on the server' };
  }

  const header = req.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!presented || !constantTimeEquals(presented, expected)) {
    return { ok: false, reason: 'missing or invalid operator credentials' };
  }

  return { ok: true, operator: { email: process.env.OPERATOR_EMAIL ?? 'operator' } };
}
