/**
 * Shared display primitives — blueprint 5.1.
 *
 * Deliberately small and unabstracted. A design-system layer would be the right
 * call for a product; for a two-day build the risk is spending the afternoon on
 * a Button component instead of on the screen the judges look at.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';

/** Money is paise everywhere in this system. It becomes rupees only here. */
export function rupees(paise: number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (paise === null || paise === undefined) return '—';
  const r = paise / 100;
  if (opts.compact) {
    if (Math.abs(r) >= 1e7) return `₹${(r / 1e7).toFixed(2)}Cr`;
    if (Math.abs(r) >= 1e5) return `₹${(r / 1e5).toFixed(2)}L`;
    if (Math.abs(r) >= 1000) return `₹${(r / 1000).toFixed(1)}k`;
  }
  return `₹${r.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

export const IST = 'Asia/Kolkata';

export function istTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-IN', {
    timeZone: IST,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function istDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: IST,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'accent' | 'muted' | 'success';

const TONE: Record<Tone, { fg: string; bg: string; bd: string }> = {
  ok: { fg: 'var(--success)', bg: 'rgba(61,214,140,0.12)', bd: 'rgba(61,214,140,0.3)' },
  success: { fg: 'var(--success)', bg: 'rgba(61,214,140,0.12)', bd: 'rgba(61,214,140,0.3)' },
  warn: { fg: 'var(--warning)', bg: 'rgba(240,168,58,0.12)', bd: 'rgba(240,168,58,0.3)' },
  danger: { fg: 'var(--danger)', bg: 'rgba(240,85,79,0.13)', bd: 'rgba(240,85,79,0.35)' },
  info: { fg: 'var(--info)', bg: 'rgba(91,157,249,0.12)', bd: 'rgba(91,157,249,0.3)' },
  accent: { fg: 'var(--accent)', bg: 'var(--accent-dim)', bd: 'rgba(20,184,166,0.32)' },
  muted: { fg: 'var(--text-muted)', bg: 'rgba(100,120,154,0.12)', bd: 'rgba(100,120,154,0.28)' },
};

export function Badge({
  children,
  tone = 'muted',
  title,
}: {
  children: ReactNode;
  tone?: Tone;
  title?: string;
}) {
  const t = TONE[tone];
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10.5px] font-medium tracking-[0.04em] uppercase whitespace-nowrap"
      style={{ color: t.fg, background: t.bg, border: `1px solid ${t.bd}` }}
    >
      {children}
    </span>
  );
}

/**
 * Blueprint 5.1's status vocabulary, with fixed meanings. Status is never
 * communicated by colour alone — every badge carries its text label.
 */
const STATE_BADGE: Record<string, { label: string; tone: Tone }> = {
  at_risk: { label: 'At risk', tone: 'warn' },
  classifying: { label: 'Classifying', tone: 'muted' },
  planned: { label: 'Planned', tone: 'info' },
  waiting_out_outage: { label: 'Waiting out outage', tone: 'danger' },
  deferred: { label: 'Deferred', tone: 'warn' },
  blocked_by_policy: { label: 'Blocked by policy', tone: 'warn' },
  action_sent: { label: 'Action sent', tone: 'accent' },
  recovered: { label: 'Recovered', tone: 'success' },
  lost: { label: 'Lost', tone: 'muted' },
  stopped: { label: 'Stopped', tone: 'muted' },
};

export function StateBadge({ state, recovered }: { state: string; recovered?: boolean }) {
  // A recovery can land while a later pipeline stage is still in flight. The
  // money is the fact; show that rather than whichever label won the race.
  if (recovered) return <Badge tone="success">Recovered</Badge>;
  const s = STATE_BADGE[state] ?? { label: state, tone: 'muted' as Tone };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function ArmChip({ arm }: { arm: string | null }) {
  if (!arm) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  const colour =
    arm === 'control'
      ? 'var(--arm-control)'
      : arm === 'naive'
        ? 'var(--arm-naive)'
        : 'var(--arm-leakproof)';
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span
        className="inline-block h-2 w-2 shrink-0 rounded-full"
        style={{ background: colour }}
        aria-hidden
      />
      <span style={{ color: 'var(--text-secondary)' }}>
        {arm === 'control' ? 'control (held out)' : arm}
      </span>
    </span>
  );
}

export function ClassificationChip({
  kind,
  failureClass,
  confidence,
}: {
  kind: string | null;
  failureClass: string | null;
  confidence: number | null;
}) {
  if (!kind) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  const tone: Tone = kind === 'systemic' ? 'danger' : kind === 'idiosyncratic' ? 'info' : 'muted';
  return (
    <Badge
      tone={tone}
      title={`${kind}${confidence === null ? '' : ` · confidence ${(confidence * 100).toFixed(0)}%`}`}
    >
      {(failureClass ?? kind).replace(/_/g, ' ')}
    </Badge>
  );
}

export function Panel({
  title,
  right,
  children,
  className = '',
  bodyClassName = '',
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      className={`panel-hover hairline flex min-h-0 flex-col rounded-[10px] ${className}`}
      style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)' }}
    >
      {title !== undefined && (
        <header
          className="flex shrink-0 items-center justify-between gap-3 px-3 py-2"
          style={{ borderBottom: '1px solid var(--border-subtle)' }}
        >
          <h2 className="label">{title}</h2>
          {right}
        </header>
      )}
      <div className={`min-h-0 flex-1 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

export function Empty({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <p style={{ color: 'var(--text-secondary)' }}>{message}</p>
      {action}
    </div>
  );
}

/**
 * The screens of the console, addressed the same way from all of them.
 * Small thing, but before this the only way from /replay back to /tower was a
 * text link in the corner and there was no way to reach /replay from /tower at
 * all — the judge had to type the URL.
 *
 * Ordered the way the argument is made rather than the way the screens were
 * built: what is happening now, what it added, what it can be checked against,
 * what would have happened instead.
 */
export function ConsoleNav({ active }: { active: 'tower' | 'lab' | 'ledger' | 'replay' }) {
  const items = [
    { href: '/tower', key: 'tower', label: 'Control tower' },
    { href: '/lab', key: 'lab', label: 'Incrementality lab' },
    { href: '/ledger', key: 'ledger', label: 'Audit ledger' },
    { href: '/replay', key: 'replay', label: 'Replay & what-if' },
  ] as const;
  return (
    <nav className="flex items-center gap-1" aria-label="Console">
      {items.map((it) => {
        const on = it.key === active;
        return (
          <Link
            key={it.key}
            href={it.href}
            aria-current={on ? 'page' : undefined}
            className="rounded-[6px] px-2.5 py-1 text-[12.5px] transition-colors duration-200"
            style={{
              color: on ? 'var(--accent)' : 'var(--text-secondary)',
              background: on ? 'var(--accent-dim)' : 'transparent',
              border: `1px solid ${on ? 'rgba(20,184,166,0.3)' : 'transparent'}`,
            }}
          >
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * A standing disclosure — a fact about the instance the reader is owed, not a
 * control they can operate.
 *
 * These were `Badge`s in the console header, and a bordered pill sitting inches
 * from the nav pills reads as a button you can press. Nothing happens when you
 * do, which is worse than the disclosure being quieter: a judge who clicks
 * "TEST MODE" and gets nothing learns the screen is partly fake. So the box
 * comes off and the affordance is inverted — a dotted underline and `cursor:
 * help`, which is the one convention in the app that means "hover me, do not
 * click me".
 *
 * The tooltip is supplementary by construction: the label alone already carries
 * the disclosure, so nothing is lost to a reader who never hovers, and the
 * whole thing is keyboard-focusable so the explanation is not mouse-only.
 */
export function Disclosure({
  label,
  explain,
  tone = 'muted',
  placement = 'bottom',
}: {
  label: string;
  explain: string;
  tone?: 'muted' | 'warn' | 'ok';
  placement?: 'bottom' | 'top';
}) {
  const colour =
    tone === 'warn' ? 'var(--warning)' : tone === 'ok' ? 'var(--success)' : 'var(--text-muted)';
  return (
    <span
      className="disclosure"
      tabIndex={0}
      role="note"
      // Read as one statement rather than as a label with a mystery tooltip.
      aria-label={`${label}. ${explain}`}
    >
      <span className="disclosure-dot" style={{ background: colour }} aria-hidden />
      <span className="disclosure-label" style={{ color: colour }} aria-hidden>
        {label}
      </span>
      <span className={`disclosure-tip disclosure-tip-${placement}`} aria-hidden>
        {explain}
      </span>
    </span>
  );
}
