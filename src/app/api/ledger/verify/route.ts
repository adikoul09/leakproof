/**
 * GET /api/ledger/verify — recompute the whole chain and report.
 *
 * Public and unauthenticated on purpose: the point of a hash chain is that
 * anyone can check it. Returning the genesis and head hashes lets a reader
 * compare against a figure quoted elsewhere without trusting this endpoint.
 */
import { NextResponse } from 'next/server';
import { verifyChain } from '@/core/ledger/verify';
import { requestId } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const reqId = requestId();
  const result = await verifyChain();

  return NextResponse.json(
    {
      intact: result.intact,
      records: result.records,
      genesis_hash: result.genesisHash,
      head_hash: result.headHash,
      verified_in_ms: result.verifiedInMs,
      ...(result.brokenAtSeq !== undefined
        ? { broken_at_seq: result.brokenAtSeq, break: result.break }
        : {}),
    },
    {
      // A broken chain is a server-side integrity failure, and the status code
      // should say so rather than returning 200 with intact:false that a
      // monitoring tool would happily ignore.
      status: result.intact ? 200 : 500,
      headers: { 'x-request-id': reqId },
    },
  );
}
