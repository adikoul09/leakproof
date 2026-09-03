/**
 * One typed error envelope for every route — blueprint 6.7.
 *
 * { error: { code, message, detail?, request_id } }
 */
import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';

export const ERROR_CODES = [
  'INVALID_SIGNATURE',
  'DUPLICATE_EVENT',
  'POLICY_VALIDATION_FAILED',
  'POLICY_GATE_BLOCKED',
  'BREAKER_OPEN',
  'RAZORPAY_UPSTREAM_ERROR',
  'LLM_UNAVAILABLE',
  'CHANNEL_SEND_FAILED',
  'LEDGER_CHAIN_BROKEN',
  'REPLAY_CORPUS_EMPTY',
  'UNAUTHORIZED',
  'BAD_REQUEST',
  'STORAGE_UNAVAILABLE',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const requestId = () => `req_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

export function errorResponse(
  status: number,
  code: ErrorCode,
  message: string,
  detail?: unknown,
  reqId = requestId(),
) {
  return NextResponse.json(
    { error: { code, message, ...(detail === undefined ? {} : { detail }), request_id: reqId } },
    { status, headers: { 'x-request-id': reqId } },
  );
}
