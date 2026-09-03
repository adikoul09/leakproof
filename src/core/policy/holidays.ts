/**
 * Bank holidays.
 *
 * Pre-warmed into `holidays_cache` by a daily job so the gate never makes a
 * network call. That is the whole point: a policy gate that can time out is
 * not a gate, and a holiday API having a bad day must not decide whether a
 * customer gets contacted.
 *
 * ── Source, and an important caveat ──────────────────────────────────
 *
 * The blueprint specified Nager.Date. Nager.Date returns **204 No Content**
 * for `IN` — it has no Indian holiday data at all (FAILURES.md #5). So the
 * source is Google's public "Indian Holidays" ICS calendar, which does return
 * real data and needs no API key.
 *
 * That calendar mixes two very different things, and the distinction matters:
 * each VEVENT carries a DESCRIPTION of either "Public holiday" (gazetted —
 * banks shut) or "Observance" (cultural — banks open, settlement runs fine).
 * For 2026 that is 18 public holidays against 36 observances. Caching all 54
 * would defer recovery on 54 days a year, most of them working days — which
 * is not caution, it is just lost revenue. So only "Public holiday" entries
 * are cached.
 *
 * 🔸 ASSUMPTION that remains: RBI's actual holiday list is **state-wise**, and
 * a single national list cannot express that. A payment from a Kerala customer
 * on a Kerala-only holiday is still treated as a working day here. The error
 * runs in the under-blocking direction now, which costs a wasted contact
 * rather than a wasted day, and it is stated rather than hidden.
 *
 * Production fix: replace the fetch below with RBI's published state-wise
 * holiday list, keyed by the customer's state. Nothing else in the system
 * changes; the gate only ever sees `holidays_cache`.
 */
import { and, gte, lte } from 'drizzle-orm';
import { db } from '@/db/client';
import { holidaysCache } from '@/db/schema';

const INDIA_ICS =
  'https://calendar.google.com/calendar/ical/en.indian%23holiday%40group.v.calendar.google.com/public/basic.ics';

/** Holiday date keys ('YYYY-MM-DD') in a range, for the gate's context. */
export async function loadHolidays(fromKey: string, toKey: string): Promise<Set<string>> {
  const rows = await db
    .select({ d: holidaysCache.d })
    .from(holidaysCache)
    .where(and(gte(holidaysCache.d, fromKey), lte(holidaysCache.d, toKey)));
  return new Set(rows.map((r) => r.d));
}

export interface Holiday {
  d: string;
  name: string;
  /** The calendar's own DESCRIPTION, e.g. 'Public holiday' or 'Observance'. */
  kind: string;
}

/** Only gazetted holidays close banks. Observances do not. */
const isBankHoliday = (h: Holiday) => h.kind.startsWith('Public holiday');

/**
 * Minimal ICS reader: unfolds continuation lines, then pulls all-day VEVENTs.
 * Only DTSTART;VALUE=DATE, SUMMARY and DESCRIPTION are needed, so this
 * deliberately does not become a calendar library.
 */
export function parseIcs(ics: string): Holiday[] {
  const unfolded = ics.replace(/\r?\n[ \t]/g, '');
  const out: Holiday[] = [];
  let date: string | null = null;
  let name: string | null = null;
  let kind = '';

  for (const line of unfolded.split(/\r?\n/)) {
    if (line === 'BEGIN:VEVENT') {
      date = null;
      name = null;
      kind = '';
      continue;
    }
    if (line === 'END:VEVENT') {
      if (date && name) out.push({ d: date, name, kind });
      continue;
    }
    const dt = /^DTSTART;VALUE=DATE:(\d{4})(\d{2})(\d{2})/.exec(line);
    if (dt) date = `${dt[1]}-${dt[2]}-${dt[3]}`;
    else if (line.startsWith('SUMMARY:')) name = line.slice('SUMMARY:'.length).trim();
    else if (line.startsWith('DESCRIPTION:')) kind = line.slice('DESCRIPTION:'.length).trim();
  }
  return out;
}

export interface HolidayRefreshResult {
  upserted: number;
  source: 'google_ics' | 'unavailable';
  /** Years actually represented in what was fetched. */
  years: number[];
  note?: string;
}

/**
 * Refresh the cache. Never throws: if the source is unreachable the existing
 * cache stands and the caller is told so, because a stale holiday list is
 * enormously better than an empty one.
 */
export async function refreshHolidays(years: number[]): Promise<HolidayRefreshResult> {
  let holidays: Holiday[] = [];
  try {
    const res = await fetch(INDIA_ICS, { signal: AbortSignal.timeout(15_000) });
    if (res.ok) {
      const wanted = new Set(years.map(String));
      holidays = parseIcs(await res.text()).filter(
        (h) => wanted.has(h.d.slice(0, 4)) && isBankHoliday(h),
      );
    }
  } catch {
    // Swallowed deliberately — see the doc comment.
  }

  if (holidays.length === 0) {
    return { upserted: 0, source: 'unavailable', years: [] };
  }

  // De-duplicate: the calendar can carry several observances on one date.
  const byDate = new Map<string, string>();
  for (const h of holidays) {
    byDate.set(h.d, byDate.has(h.d) ? `${byDate.get(h.d)}; ${h.name}` : h.name);
  }

  await db
    .insert(holidaysCache)
    .values([...byDate].map(([d, name]) => ({ d, name })))
    .onConflictDoUpdate({
      target: holidaysCache.d,
      set: { fetchedAt: new Date() },
    });

  return {
    upserted: byDate.size,
    source: 'google_ics',
    years: [...new Set([...byDate.keys()].map((d) => Number(d.slice(0, 4))))].sort(),
    note: 'gazetted public holidays only, observances excluded — see FAILURES.md #5',
  };
}
