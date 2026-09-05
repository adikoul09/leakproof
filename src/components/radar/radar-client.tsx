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

type Filter = 'all' | 'open' | 'closed';

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

  useEffect(() => {
    void load();
  }, [load]);

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

      <Scorecards scorecard={scorecard} loading={windows === null} />

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
          <Panel title="Run detection now" bodyClassName="p-3 flex flex-col gap-2.5">
            <p className="text-[12px] leading-[17px]" style={{ color: 'var(--text-secondary)' }}>
              The cron runs every five minutes. This runs the same detector immediately, so a demo
              does not have to wait for it.
            </p>
            <label className="flex flex-col gap-1">
              <span className="label">Operator key</span>
              <input
                type="password"
                value={operatorKey}
                onChange={(e) => setOperatorKey(e.target.value)}
                placeholder="OPERATOR_ACCESS_KEY"
                className="mono rounded-sm px-2 py-1.5"
                style={inputStyle}
              />
            </label>
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
                ▸ Detection writes outage windows and calls Razorpay, so it needs the operator key.
                It is <code className="mono">OPERATOR_ACCESS_KEY</code> from the environment.
              </p>
            )}
            {notice && (
              <p className="text-[12px]" style={{ color: 'var(--success)' }}>
                {notice}
              </p>
            )}
            {error && (
              <p className="text-[12px] leading-[17px]" style={{ color: 'var(--danger)' }}>
                {error}
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

function Scorecards({ scorecard, loading }: { scorecard: Scorecard | null; loading: boolean }) {
  if (loading) {
    return (
      <div
        className="flex h-[88px] overflow-hidden rounded-[10px]"
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
        <div className="text-[12px] leading-4" style={{ color: 'var(--text-muted)' }}>
          {scorecard.classifier_only.toLocaleString('en-IN')} by the classifier alone
        </div>
      </div>

      <div className={cell} style={{ borderRight: '1px solid var(--border-subtle)' }}>
        <div className="label">Agreement with Razorpay</div>
        <div
          className="tnum text-[26px] leading-8 font-semibold"
          style={{ color: scorecard.agreement_rate === null ? 'var(--text-muted)' : 'var(--text-primary)' }}
        >
          {scorecard.agreement_rate === null
            ? '——'
            : `${(scorecard.agreement_rate * 100).toFixed(0)}%`}
        </div>
        <div className="text-[12px] leading-4" style={{ color: 'var(--text-muted)' }}>
          {/*
            The denominator, stated. An agreement rate whose denominator is
            hidden is the easiest number on this screen to misread.
          */}
          {scorecard.both} of the {scorecard.windows_feed_had_an_opinion_on} window
          {scorecard.windows_feed_had_an_opinion_on === 1 ? '' : 's'} it had an opinion on
        </div>
      </div>

      <div className={cell} style={{ borderRight: '1px solid var(--border-subtle)' }}>
        <div className="label">Median detection lead</div>
        <div
          className="tnum text-[26px] leading-8 font-semibold"
          style={{
            color: lag === null ? 'var(--text-muted)' : lag > 0 ? 'var(--success)' : 'var(--text-primary)',
          }}
        >
          {lag === null ? '——' : lead(lag).text}
        </div>
        <div className="text-[12px] leading-4" style={{ color: 'var(--text-muted)' }}>
          than the Downtime API, where both saw it
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
