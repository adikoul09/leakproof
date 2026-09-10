/**
 * The keyset cursor `/api/stream` hands out and takes back.
 *
 * Wire form: `<postgres timestamp>|<event id>`, or a bare timestamp on first
 * connect. Two things this codec exists to protect, both of them defects
 * (FAILURES.md #37):
 *
 * 1. The timestamp is carried as Postgres' own text — never a JS `Date`.
 *    `created_at` is a timestamptz stored to the microsecond; a Date holds
 *    milliseconds, and Drizzle's timestamp mapper round-trips through one. A
 *    cursor truncated from `.911048` to `.911` re-matches the row it came
 *    from, and the stream re-sends that row on every tick, forever.
 *
 * 2. The id travels on the wire, not only in the connection's memory.
 *    `defaultNow()` is the *transaction* timestamp, so a batch insert puts
 *    every one of its rows on one `created_at` to the microsecond. Resuming
 *    from a timestamp alone skips the rest of that batch — silently.
 */

/** A timestamp cannot contain this, so the first one splits. */
const SEP = '|';

export type StreamCursor = { ts: string; id: string | null };

/**
 * Parse a `since` parameter. An unparseable or missing value yields "now",
 * which is the right default for a live tail: show what happens next rather
 * than replaying the corpus. A bare timestamp is accepted so a client holding
 * an older cursor degrades instead of breaking.
 */
export function parseStreamCursor(since: string | null | undefined): StreamCursor {
  const now: StreamCursor = { ts: new Date().toISOString(), id: null };
  if (!since) return now;

  const at = since.indexOf(SEP);
  const ts = at === -1 ? since : since.slice(0, at);
  const id = at === -1 ? null : since.slice(at + 1) || null;

  return Number.isNaN(new Date(ts).getTime()) ? now : { ts, id };
}

export function encodeStreamCursor(ts: string, id: string | null): string {
  return id === null ? ts : `${ts}${SEP}${id}`;
}
