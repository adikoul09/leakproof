'use client';

/**
 * SCREEN 8 — the Outage Radar.
 *
 * Every window the detector has opened, and — separately — what Razorpay's
 * Payment Downtime API said about the same cohort.
 *
 * The separation is the point. The feed is recorded as corroboration and is
 * never an input to the classifier, because feeding it in would make validating
 * the classifier against it circular. So this screen reports three distinct
 * outcomes and refuses to collapse them: the feed agreed, the feed disagreed,
 * or the feed carried nothing for that method at all. The third is not a
 * failure of the detector and is excluded from the agreement denominator.
 */
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Badge, ConsoleNav, Panel, istDateTime, rupees } from '@/components/primitives';

interface OutageWindow {
  id: string;
  cohort_key: string;
  issuer: string | null;
  method: string | null;
  started_at: string;
  ended_at: string | null;
  open: boolean;
  peak_decline_rate: number | null;
  events_affected: number;
  paise_parked: number;
  detected_by: string;
  downtime_api_agrees: boolean | null;
  downtime_api_why: string | null;
  downtime_api_start: string | null;
  downtime_api_end: string | null;
  detection_lead_s: number | null;
}

interface Scorecard {
  windows: number;
  both: number;
  classifier_only: number;
  windows_feed_had_an_opinion_on: number;
  agreement_rate: number | null;
  median_detection_lead_s: number | null;
  note: string;
}

interface BreakerScope {
  scope: string;
  state: string;
  reason: string | null;
  opened_at: string | null;
}

type Filter = 'all' | 'open' | 'closed';

/** The API rejects anything shorter; the UI should say so before the round trip. */
const MIN_REASON = 10;

const inputStyle = {
  background: 'var(--bg-surface-2)',
  border: '1px solid var(--border-subtle)',
  color: 'var(--text-primary)',
};

/** Negative means Razorpay's feed saw it before we did — say which way it ran. */
function lead(seconds: number | null): { text: string; tone: 'ok' | 'warn' | 'muted' } {
  if (seconds === null) return { text: '—', tone: 'muted' };
  const abs = Math.abs(seconds);
  const t = abs >= 3600 ? `${(abs / 3600).toFixed(1)}h` : abs >= 60 ? `${Math.round(abs / 60)}m` : `${abs}s`;
  if (seconds === 0) return { text: 'same moment', tone: 'muted' };
  return seconds > 0
    ? { text: `${t} earlier`, tone: 'ok' }
    : { text: `${t} later`, tone: 'warn' };
}

export function RadarClient() {
  const [windows, setWindows] = useState<OutageWindow[] | null>(null);
  const [scorecard, setScorecard] = useState<Scorecard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  const [operatorKey, setOperatorKey] = useState('');
  const [detecting, setDetecting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [breaker, setBreaker] = useState<BreakerScope[] | null>(null);
  const [breakerOpen, setBreakerOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [overriding, setOverriding] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/outages');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      setWindows(body.windows ?? []);
      setScorecard(body.scorecard ?? null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      setWindows([]);
    }
  }, []);

  /**
   * Breaker state comes from `/api/status`, which is the only read path for it —
   * the override endpoint is POST-only. Fetched separately from the windows so
   * a slow status call does not hold up the table.
   */
  const loadBreaker = useCallback(async () => {
    try {
      const res = await fetch('/api/status?window_minutes=60');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      setBreaker(body.breaker ?? []);
      setBreakerOpen(Boolean(body.breaker_open));
    } catch {
      // Non-fatal: the windows table is the screen's subject, the breaker panel
      // is beside it. It shows its own unavailable state rather than blanking
      // the page.
      setBreaker([]);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadBreaker();
  }, [load, loadBreaker]);

  const runDetection = useCallback(async () => {
    setDetecting(true);
    setNotice(null);
    setError(null);
    try {
      const res = await fetch('/api/outages/detect', {
        method: 'POST',
        headers: { authorization: `Bearer ${operatorKey}` },
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      setNotice('Detection run complete.');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDetecting(false);
    }
  }, [operatorKey, load]);

  const override = useCallback(
    async (action: 'open' | 'close') => {
      setOverriding(true);
      setNotice(null);
      setError(null);
      try {
        const res = await fetch('/api/breaker/override', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorKey}` },
          body: JSON.stringify({ scope: 'global', action, reason: overrideReason }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
        setNotice(
          body.warning
            ? `Breaker ${action}d, but ${body.warning}`
            : `Breaker ${action}d. Written to the ledger at seq ${body.ledger_seq ?? '—'}.`,
        );
        setOverrideReason('');
        await loadBreaker();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setOverriding(false);
      }
    },
    [operatorKey, overrideReason, loadBreaker],
  );

  const rows = (windows ?? []).filter((w) =>
    filter === 'all' ? true : filter === 'open' ? w.open : !w.open,
  );
  const openCount = (windows ?? []).filter((w) => w.open).length;

  return (
    <div className="stagger-shell mx-auto flex min-h-screen max-w-[1600px] flex-col gap-2 p-3">
      <header
        className="flex flex-wrap items-center gap-3 rounded-[10px] px-3 py-2"
        style={{
          background: 'var(--glass)',
          border: '1px solid var(--border-subtle)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
        }}
      >
        <Link
          href="/"
          className="group flex items-center gap-2 text-[17px] font-semibold tracking-tight"
          style={{ color: 'var(--accent)' }}
          title="Back to the entry screen"
        >
          <span className="inline-block transition-transform duration-500 group-hover:rotate-90">▣</span>
          LEAKPROOF
        </Link>
        <ConsoleNav active="radar" />
        <span className="ml-auto flex items-center gap-2 text-[12.5px]">
          <span
            className={`inline-block h-2 w-2 rounded-full ${openCount > 0 ? 'pulse-danger' : ''}`}
            style={{ background: openCount > 0 ? 'var(--danger)' : 'var(--success)' }}
            aria-hidden
          />
          <span style={{ color: openCount > 0 ? 'var(--danger)' : 'var(--text-secondary)' }}>
            {windows === null
              ? 'Loading…'
              : openCount === 0
                ? 'No open outage'
                : `${openCount} outage${openCount === 1 ? '' : 's'} open`}
          </span>
        </span>
      </header>

      <Scorecards scorecard={scorecard} windows={windows} loading={windows === null} />

      <div className="grid grid-cols-1 gap-2 xl:grid-cols-[1fr_340px]">
        <Panel
          title="Detected windows — newest first"
          right={
            <div className="flex gap-1" role="tablist" aria-label="Window filter">
              {(['all', 'open', 'closed'] as const).map((f) => {
                const on = f === filter;
                return (
                  <button
                    key={f}
                    role="tab"
                    aria-selected={on}
                    onClick={() => setFilter(f)}
                    className="press cursor-pointer rounded-sm px-2 py-1 text-[12px] capitalize transition-all duration-200"
                    style={{
                      color: on ? 'var(--accent)' : 'var(--text-secondary)',
                      background: on ? 'var(--accent-dim)' : 'transparent',
                      border: `1px solid ${on ? 'rgba(20,184,166,0.32)' : 'var(--border-subtle)'}`,
                    }}
                  >
                    {f}
                  </button>
                );
              })}
            </div>
          }
          bodyClassName="p-0"
        >
          {windows === null ? (
            <div className="flex flex-col gap-1 p-3">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="skeleton h-7 rounded-sm" style={{ opacity: 0.5 }} />
              ))}
            </div>
          ) : error && rows.length === 0 ? (
            <p className="px-3 py-8 text-center text-[12.5px]" style={{ color: 'var(--danger)' }}>
              Could not load windows — {error}
            </p>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center gap-1 px-3 py-10 text-center">
              <p className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
                {filter === 'all'
                  ? 'No outage windows recorded.'
                  : `No ${filter} windows.`}
              </p>
              <p className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                {filter === 'all'
                  ? 'The detector opens a window when a cohort’s decline rate clears the floor. Nothing has cleared it yet.'
                  : 'Switch the filter to see the rest.'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[12.5px]">
                <thead style={{ background: 'var(--bg-surface-2)' }}>
                  <tr>
                    <th scope="col" className="label px-2 py-1.5 text-left">Cohort</th>
                    <th scope="col" className="label px-2 py-1.5 text-left">Started (IST)</th>
                    <th scope="col" className="label px-2 py-1.5 text-left">Ended</th>
                    <th scope="col" className="label px-2 py-1.5 text-right">Peak decline</th>
                    <th scope="col" className="label px-2 py-1.5 text-right">Events</th>
                    <th scope="col" className="label px-2 py-1.5 text-right">Parked</th>
                    <th scope="col" className="label px-2 py-1.5 text-left">Detected by</th>
                    <th scope="col" className="label px-2 py-1.5 text-left">Downtime API</th>
                    <th scope="col" className="label px-2 py-1.5 text-right">Lead</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((w) => {
                    const l = lead(w.detection_lead_s);
                    return (
                      <tr
                        key={w.id}
                        className="transition-colors duration-150 hover:bg-[var(--bg-surface-2)]"
                        style={{
                          borderBottom: '1px solid var(--border-subtle)',
                          borderLeft: `2px solid ${w.open ? 'var(--danger)' : 'transparent'}`,
                        }}
                      >
                        <td className="px-2 py-1.5">
                          <span className="flex items-center gap-2 whitespace-nowrap">
                            {w.open && (
                              <span
                                className="pulse-danger inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                                style={{ background: 'var(--danger)' }}
                                aria-hidden
                              />
                            )}
                            <span style={{ color: 'var(--text-primary)' }}>
                              {w.issuer ?? 'unknown'} / {w.method ?? 'unknown'}
                            </span>
                          </span>
                          <span className="mono block break-all" style={{ color: 'var(--text-muted)' }}>
                            {w.cohort_key}
                          </span>
                        </td>
                        <td className="px-2 py-1.5 whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
                          {istDateTime(w.started_at)}
                        </td>
                        <td className="px-2 py-1.5 whitespace-nowrap">
                          {w.open ? (
                            <Badge tone="danger">still open</Badge>
                          ) : (
                            <span style={{ color: 'var(--text-secondary)' }}>{istDateTime(w.ended_at)}</span>
                          )}
                        </td>
                        <td className="tnum px-2 py-1.5 text-right">
                          {w.peak_decline_rate === null
                            ? '—'
                            : `${(w.peak_decline_rate * 100).toFixed(0)}%`}
                        </td>
                        <td className="tnum px-2 py-1.5 text-right" style={{ color: 'var(--text-secondary)' }}>
                          {w.events_affected.toLocaleString('en-IN')}
                        </td>
                        <td className="tnum px-2 py-1.5 text-right">{rupees(w.paise_parked)}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                          {w.detected_by}
                        </td>
                        <td className="px-2 py-1.5">
                          {/*
                            Three outcomes, three renderings. "No signal" is not
                            a disagreement and must not look like one.
                          */}
                          {w.downtime_api_agrees === true ? (
                            <Badge tone="ok" title={w.downtime_api_why ?? undefined}>agrees</Badge>
                          ) : w.downtime_api_agrees === false ? (
                            <Badge tone="warn" title={w.downtime_api_why ?? undefined}>disagrees</Badge>
                          ) : (
                            <Badge tone="muted" title="Recorded as corroboration only, never an input">
                              no signal
                            </Badge>
                          )}
                        </td>
                        <td className="tnum px-2 py-1.5 text-right whitespace-nowrap">
                          <span
                            style={{
                              color:
                                l.tone === 'ok'
                                  ? 'var(--success)'
                                  : l.tone === 'warn'
                                    ? 'var(--warning)'
                                    : 'var(--text-muted)',
                            }}
                          >
                            {l.text}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <div className="flex flex-col gap-2">
          {/*
            One key input for both write actions on this screen. Two separate
            boxes for the same credential is the kind of thing that gets typed
            into the wrong one under demo pressure.
          */}
          <Panel title="Operator key" bodyClassName="p-3 flex flex-col gap-1.5">
            <input
              type="password"
              value={operatorKey}
              onChange={(e) => setOperatorKey(e.target.value)}
              placeholder="OPERATOR_ACCESS_KEY"
              aria-label="Operator key"
              className="mono rounded-sm px-2 py-1.5"
              style={inputStyle}
            />
            <p className="text-[11.5px] leading-[16px]" style={{ color: 'var(--text-muted)' }}>
              ▸ Both actions below write to the ledger.{' '}
              <code className="mono">OPERATOR_ACCESS_KEY</code> from the environment.
            </p>
            {notice && (
              <p className="text-[12px] leading-[17px]" style={{ color: 'var(--success)' }}>
                {notice}
              </p>
            )}
            {error && (
              <p className="text-[12px] leading-[17px]" style={{ color: 'var(--danger)' }}>
                {error}
              </p>
            )}
          </Panel>

          <BreakerPanel
            breaker={breaker}
            breakerOpen={breakerOpen}
            reason={overrideReason}
            onReason={setOverrideReason}
            onOverride={override}
            busy={overriding}
            hasKey={operatorKey.length > 0}
          />

          <Panel title="Run detection now" bodyClassName="p-3 flex flex-col gap-2.5">
            <p className="text-[12px] leading-[17px]" style={{ color: 'var(--text-secondary)' }}>
              The cron runs every five minutes. This runs the same detector immediately, so a demo
              does not have to wait for it.
            </p>
            <button
              onClick={() => void runDetection()}
              disabled={detecting || !operatorKey}
              className="cursor-pointer rounded-sm px-3 py-1.5 text-[12.5px] font-medium transition-colors duration-200 hover:bg-[rgba(20,184,166,0.2)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-[var(--accent-dim)]"
              style={{
                background: 'var(--accent-dim)',
                border: '1px solid rgba(20,184,166,0.4)',
                color: 'var(--accent)',
              }}
            >
              {detecting ? 'Detecting…' : 'Run detection'}
            </button>
            {!operatorKey && (
              <p className="text-[11.5px] leading-[16px]" style={{ color: 'var(--text-muted)' }}>
                ▸ Detection writes outage windows and calls Razorpay, so it needs the key above.
              </p>
            )}
          </Panel>

          <Panel title="How a window opens" bodyClassName="p-3 flex flex-col gap-1.5">
            <p className="text-[12px] leading-[17px]" style={{ color: 'var(--text-secondary)' }}>
              A cohort is <span className="mono">issuer | method | amount band</span>. A window opens
              when its decline rate clears the absolute floor with enough events behind it, and
              closes when the rate falls back.
            </p>
            <p className="text-[11.5px] leading-[16px]" style={{ color: 'var(--text-muted)' }}>
              ▸ While a window is open the gate defers recovery for that cohort rather than
              contacting customers — retrying into a dead issuer spends the contact budget and
              annoys people for nothing.
            </p>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Scorecards({
  scorecard,
  windows,
  loading,
}: {
  scorecard: Scorecard | null;
  windows: OutageWindow[] | null;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div
        className="flex h-[96px] overflow-hidden rounded-[10px]"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)' }}
      >
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skeleton flex-1" style={{ opacity: 0.5 }} />
        ))}
      </div>
    );
  }
  if (!scorecard) return null;

  const cell = 'flex min-w-0 flex-1 flex-col justify-between gap-1 px-4 py-3';
  const lag = scorecard.median_detection_lead_s;
  const rows = windows ?? [];
  const parked = rows.reduce((sum, w) => sum + w.paise_parked, 0);
  const parkedOpen = rows.filter((w) => w.open).reduce((sum, w) => sum + w.paise_parked, 0);

  /*
    The agreement rate is a footnote, not a headline.
    Every window in this deployment is synthetic, so Razorpay's live feed has
    nothing to match and the rate sits at zero by construction. Rendered as a
    26px hero it read as a broken detector at a glance, which is the opposite
    of what it measures. The number is still here, stated with its denominator
    and with the reason it is zero — demoted, not hidden.
  */
  const agreement =
    scorecard.agreement_rate === null
      ? `Razorpay's feed had no opinion on any of them`
      : scorecard.agreement_rate === 0
        ? '0% corroborated — synthetic windows, nothing for the live feed to match'
        : `${(scorecard.agreement_rate * 100).toFixed(0)}% corroborated by Razorpay's feed ` +
          `(${scorecard.both} of ${scorecard.windows_feed_had_an_opinion_on})`;

  return (
    <div
      className="flex flex-wrap overflow-hidden rounded-[10px]"
      style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)' }}
    >
      <div className={cell} style={{ borderRight: '1px solid var(--border-subtle)' }}>
        <div className="label">Windows detected</div>
        <div className="tnum text-[26px] leading-8 font-semibold">
          {scorecard.windows.toLocaleString('en-IN')}
        </div>
        <div className="flex flex-col text-[12px] leading-4" style={{ color: 'var(--text-muted)' }}>
          <span>{scorecard.classifier_only.toLocaleString('en-IN')} by the classifier alone</span>
          <span>{agreement}</span>
        </div>
      </div>

      <div className={cell} style={{ borderRight: '1px solid var(--border-subtle)' }}>
        <div className="label">Value inside those windows</div>
        <div className="tnum text-[26px] leading-8 font-semibold">
          {rupees(parked, { compact: true })}
        </div>
        <div className="text-[12px] leading-4" style={{ color: 'var(--text-muted)' }}>
          {parkedOpen === 0
            ? 'none of it in a window still open'
            : `${rupees(parkedOpen, { compact: true })} in a window still open`}
        </div>
      </div>

      <div className={cell} style={{ borderRight: '1px solid var(--border-subtle)' }}>
        <div className="label">Median detection lead</div>
        {/*
          A pair of em dashes at 26px reads as a loading bar, not as an absent
          value. When no window was seen by both, say that in words.
        */}
        {lag === null ? (
          <div className="text-[18px] leading-8" style={{ color: 'var(--text-muted)' }}>
            no overlap
          </div>
        ) : (
          <div
            className="tnum text-[26px] leading-8 font-semibold"
            style={{ color: lag > 0 ? 'var(--success)' : 'var(--text-primary)' }}
          >
            {lead(lag).text}
          </div>
        )}
        <div className="text-[12px] leading-4" style={{ color: 'var(--text-muted)' }}>
          {lag === null
            ? 'no window was seen by both, so there is nothing to time'
            : 'than the Downtime API, where both saw it'}
        </div>
      </div>

      <div className={cell}>
        <div className="label">Corroboration only</div>
        <div className="flex items-center pt-1">
          <Badge tone="muted">never an input</Badge>
        </div>
        <div className="text-[12px] leading-4" style={{ color: 'var(--text-muted)' }}>
          feeding it in would make this check circular
        </div>
      </div>
    </div>
  );
}

/**
 * The circuit breaker, and the control that overrides it.
 *
 * This is a human switching off an automated safety control, so the screen is
 * built around the reason rather than around the button. The API rejects a
 * reason under ten characters and this refuses to send one — not to be
 * awkward, but because "closed it" in an audit log six months from now is
 * worth exactly nothing, and the person who can still remember why is the one
 * sitting here now.
 */
function BreakerPanel({
  breaker,
  breakerOpen,
  reason,
  onReason,
  onOverride,
  busy,
  hasKey,
}: {
  breaker: BreakerScope[] | null;
  breakerOpen: boolean;
  reason: string;
  onReason: (v: string) => void;
  onOverride: (action: 'open' | 'close') => void;
  busy: boolean;
  hasKey: boolean;
}) {
  const action: 'open' | 'close' = breakerOpen ? 'close' : 'open';
  const short = reason.trim().length < MIN_REASON;
  const remaining = MIN_REASON - reason.trim().length;
  const openScopes = (breaker ?? []).filter((b) => b.state === 'open');

  return (
    <Panel
      title="Circuit breaker"
      right={
        breaker === null ? (
          <Badge tone="muted">reading…</Badge>
        ) : breakerOpen ? (
          <Badge tone="danger">open</Badge>
        ) : (
          <Badge tone="ok">closed</Badge>
        )
      }
      bodyClassName="p-3 flex flex-col gap-2.5"
    >
      {breaker === null ? (
        <div className="skeleton h-10 rounded-sm" style={{ opacity: 0.5 }} />
      ) : openScopes.length > 0 ? (
        openScopes.map((b) => (
          <div key={b.scope} className="flex flex-col gap-0.5">
            <span className="mono" style={{ color: 'var(--danger)' }}>
              {b.scope}
            </span>
            <span className="text-[12px] leading-[17px]" style={{ color: 'var(--text-secondary)' }}>
              {b.reason ?? 'no reason recorded'}
            </span>
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              open since {istDateTime(b.opened_at)}
            </span>
          </div>
        ))
      ) : (
        <p className="text-[12px] leading-[17px]" style={{ color: 'var(--text-secondary)' }}>
          Closed on every scope. Recovery is flowing; the gate is not holding anything back on
          breaker grounds.
        </p>
      )}

      <label className="flex flex-col gap-1">
        <span className="label">Reason for the override</span>
        <textarea
          value={reason}
          onChange={(e) => onReason(e.target.value)}
          rows={2}
          placeholder={
            action === 'close'
              ? 'e.g. issuer confirmed recovered on their status page at 14:20'
              : 'e.g. holding sends while we investigate a spike the detector has not caught'
          }
          className="w-full resize-y rounded-sm px-2 py-1.5 text-[12.5px]"
          style={{ ...inputStyle, lineHeight: '18px' }}
        />
      </label>

      <button
        onClick={() => onOverride(action)}
        disabled={busy || !hasKey || short}
        className="cursor-pointer rounded-sm px-3 py-1.5 text-[12.5px] font-medium transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40"
        style={
          action === 'close'
            ? {
                background: 'var(--accent-dim)',
                border: '1px solid rgba(20,184,166,0.4)',
                color: 'var(--accent)',
              }
            : {
                background: 'rgba(240,85,79,0.13)',
                border: '1px solid rgba(240,85,79,0.4)',
                color: 'var(--danger)',
              }
        }
      >
        {busy
          ? 'Writing…'
          : action === 'close'
            ? 'Close the breaker'
            : 'Open the breaker (halt sends)'}
      </button>

      {/* Every disabled state on this screen states its reason. */}
      {!hasKey ? (
        <p className="text-[11.5px] leading-[16px]" style={{ color: 'var(--text-muted)' }}>
          ▸ Needs the operator key above.
        </p>
      ) : short ? (
        <p className="text-[11.5px] leading-[16px]" style={{ color: 'var(--text-muted)' }}>
          ▸ {remaining} more character{remaining === 1 ? '' : 's'} of reason. An override with no
          stated reason is exactly the thing an auditor asks about six months later, so the API
          rejects one and this will not send it.
        </p>
      ) : null}

      <p
        className="text-[11.5px] leading-[16px]"
        style={{ color: 'var(--text-muted)', borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}
      >
        ▸ The override is appended to the audit ledger as{' '}
        {/* Not `breaker_{action}d` — that renders "opend". These are the two
            literal action names the route appends. */}
        <span className="mono">
          {action === 'close' ? 'breaker_closed_by_operator' : 'breaker_opened_by_operator'}
        </span>{' '}
        with your reason and identity —
        the same hash chain as every automated decision, with no separate path for human ones.
      </p>
    </Panel>
  );
}
