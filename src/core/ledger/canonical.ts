/**
 * Canonical serialisation for the audit hash chain — blueprint 6.3.
 *
 * A hash chain is only worth what its serialisation is worth. If two different
 * records can produce the same bytes, or if part of a record never reaches the
 * hash, the chain verifies happily while the data underneath it has changed.
 * So this is written out rather than leaning on `JSON.stringify`.
 *
 * ── Why not the blueprint's one-liner ────────────────────────────────
 *
 *   const canonical = (r) => JSON.stringify(r, Object.keys(r).sort());
 *
 * The second argument to `JSON.stringify` is a replacer, and an *array*
 * replacer is an allow-list that applies at **every level of nesting**, not
 * just the top. So for a record like:
 *
 *   { action: 'send', detail: { rail: 'upi_payment_link', cost: 20 } }
 *
 * the allow-list is `['action', 'detail']`, and because `rail` and `cost` are
 * not in it, the nested object serialises as `{}`. The entire `detail` payload
 * — the rail chosen, the amount, the operator's reason for an override — never
 * reaches the hash. An auditor could rewrite every `detail` field in the table
 * and `verifyChain()` would still report the chain intact.
 *
 * It also leaves nested key order untouched, so the same logical record
 * serialised twice with different insertion order hashes differently.
 *
 * This implementation sorts keys at every depth, preserves array order (arrays
 * are ordered data, not sets), and refuses values JSON cannot round-trip
 * rather than silently turning them into `null`.
 */
import { sha256 } from '@/lib/hash';

export const GENESIS_PREV_HASH = '0'.repeat(64);

/** Values that survive a JSON round trip unchanged. */
export type Canonical =
  | string
  | number
  | boolean
  | null
  | Canonical[]
  | { [key: string]: Canonical };

export class NonCanonicalValueError extends Error {
  constructor(path: string, detail: string) {
    super(`ledger record is not canonicalisable at ${path || '<root>'}: ${detail}`);
    this.name = 'NonCanonicalValueError';
  }
}

/**
 * Recursively normalise into a canonical form. Throws rather than coercing:
 * a ledger entry that cannot be represented exactly is a bug at the call site,
 * and hashing a silently-degraded version of it would be worse than failing.
 */
export function toCanonical(value: unknown, path = ''): Canonical {
  if (value === null) return null;

  // Dates are common in ledger payloads and JSON.stringify would convert them
  // via toJSON anyway; doing it here makes the conversion explicit and stable.
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new NonCanonicalValueError(path, 'Invalid Date');
    return value.toISOString();
  }

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new NonCanonicalValueError(path, `${value} has no JSON representation`);
      }
      // Normalise -0 to 0: they are indistinguishable once hashed as text
      // anyway, and leaving it would make -0 and 0 hash differently.
      return value === 0 ? 0 : value;
    case 'undefined':
      throw new NonCanonicalValueError(path, 'undefined (omit the key instead)');
    case 'bigint':
      throw new NonCanonicalValueError(path, 'bigint (convert to number or string first)');
    case 'function':
    case 'symbol':
      throw new NonCanonicalValueError(path, typeof value);
  }

  if (Array.isArray(value)) {
    // Order is preserved: an array is ordered data. Sorting it would make
    // ['allow','block'] and ['block','allow'] hash identically.
    return value.map((v, i) => toCanonical(v, `${path}[${i}]`));
  }

  if (typeof value === 'object') {
    const out: { [key: string]: Canonical } = {};
    // Sorted at every depth, so insertion order cannot change the hash.
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      // An explicitly-undefined property is dropped, matching JSON semantics,
      // rather than throwing — `{a: 1, b: undefined}` is a normal shape.
      if (v === undefined) continue;
      out[key] = toCanonical(v, path ? `${path}.${key}` : key);
    }
    return out;
  }

  throw new NonCanonicalValueError(path, `unsupported type ${typeof value}`);
}

/** Deterministic string form of a record. */
export function canonicalString(record: unknown): string {
  return JSON.stringify(toCanonical(record));
}

/**
 * The chain link: sha256 over the previous hash concatenated with this
 * record's canonical form. Any edit to any field, at any depth, changes this
 * hash and every hash after it.
 */
export function chainHash(prevHash: string, record: unknown): string {
  return sha256(prevHash + canonicalString(record));
}
