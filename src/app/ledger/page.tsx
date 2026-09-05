/**
 * /ledger — the Audit Ledger.
 *
 * A thin server shell; everything here is live and the chain verification is
 * deliberately a client action, because a verification the server performs on
 * its own behalf is not worth much to whoever is checking it.
 *
 * `?seq=` and `?event=` are read here rather than with `useSearchParams`, which
 * would opt the whole screen out of server rendering — the same reason the
 * tower reads its `?event=` on the server. It makes a single audit record a
 * link you can send someone.
 */
import { LedgerClient } from '@/components/ledger/ledger-client';

export const dynamic = 'force-dynamic';

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

export default async function LedgerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const rawSeq = one(params.seq);
  const seq = rawSeq !== null && /^\d+$/.test(rawSeq) ? Number(rawSeq) : null;
  return <LedgerClient initialSeq={seq} initialEventId={one(params.event)} />;
}
