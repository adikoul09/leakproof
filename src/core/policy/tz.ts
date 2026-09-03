/**
 * Timezone helpers for the contact window.
 *
 * Pure, dependency-free, built on Intl. The policy names its own timezone
 * ("Asia/Kolkata"), so the gate must not assume IST or the server's zone —
 * a policy evaluated on a Vercel box in us-east-1 has to produce the same
 * answer as one evaluated locally, or replay is not reproducible.
 */

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 'YYYY-MM-DD' in the target zone — the key used for holiday lookups. */
  dateKey: string;
  /** Minutes from local midnight. */
  minutesOfDay: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

function partsOf(date: Date, tz: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  // Intl renders midnight as hour 24 in some engines; normalise.
  if (out.hour === 24) out.hour = 0;
  return out;
}

export function zonedParts(date: Date, tz: string): ZonedParts {
  const p = partsOf(date, tz);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    year: p.year,
    month: p.month,
    day: p.day,
    hour: p.hour,
    minute: p.minute,
    dateKey: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    minutesOfDay: p.hour * 60 + p.minute,
  };
}

/** Offset of `tz` from UTC, in milliseconds, at the given instant. */
function offsetMs(date: Date, tz: string): number {
  const p = partsOf(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second ?? 0);
  return asUtc - date.getTime();
}

/**
 * A local wall-clock time in `tz` → the UTC instant.
 *
 * Two passes: the first offset is looked up at an approximate instant, the
 * second corrects it if that guess landed on the far side of a DST boundary.
 * India has no DST, but the policy's timezone is author-controlled.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  minutesOfDay: number,
  tz: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, Math.floor(minutesOfDay / 60), minutesOfDay % 60);
  let instant = naive - offsetMs(new Date(naive), tz);
  instant = naive - offsetMs(new Date(instant), tz);
  return new Date(instant);
}

/** Add whole days to a 'YYYY-MM-DD' key. */
export function addDays(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** ISO-8601 with the zone's own offset, e.g. 2026-09-04T08:00:00+05:30. */
export function toOffsetIso(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  const off = offsetMs(date, tz) / 60000;
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:00` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}
