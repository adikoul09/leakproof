/**
 * The chain link itself — split out from `canonical.ts` so that the
 * serialisation rules can be imported by a browser.
 *
 * `canonical.ts` is pure string manipulation and now imports nothing; this file
 * is the only part that needs Node's crypto. The Ledger screen recomputes a
 * row's hash client-side with `crypto.subtle`, and it does that over the *same*
 * `canonicalString` the server hashes with. Two implementations of the
 * serialisation would drift, and a chain that verifies under one and not the
 * other is worse than no chain at all.
 */
import { sha256 } from '@/lib/hash';
import { canonicalString } from './canonical';

/**
 * sha256 over the previous hash concatenated with this record's canonical
 * form. Any edit to any field, at any depth, changes this hash and every hash
 * after it.
 */
export function chainHash(prevHash: string, record: unknown): string {
  return sha256(prevHash + canonicalString(record));
}
