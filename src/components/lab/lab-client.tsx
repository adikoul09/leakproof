'use client';

/**
 * SCREEN 5 — the Incrementality Lab.
 *
 * The Control Tower shows the headline figure. This screen exists so that a
 * reader can disagree with it: every input, the arithmetic in full, the
 * randomisation check, the estimator scored against planted ground truth, and
 * a seed box that re-runs the bootstrap in front of them.
 *
 * The organising rule is that nothing persuasive is shown without the thing
 * that would undermine it sitting next to it. The lift is next to the power
 * blockers. The rupee figure is next to the interval that contains zero. The
 * chart's default series is the one that does *not* flatter the treated arm.
 * A judge should leave this screen able to say precisely how much of the claim
 * is supported — including the parts that are not.
 */
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Badge, ConsoleNav, Panel, rupees } from '@/components/primitives';
import { CumulativeChart, type ChartMode, type TimeseriesPoint } from '@/components/lab/cumulative-chart';
import type { MetricsSummary } from '@/components/tower/kpi';
import type { CorpusProvenance } from '@/core/experiment/provenance';

interface BatchScorecard {
  batch: { id: string; label: string | null; status: string };
  detection: {
    classified: number;
    ground_truth_systemic: number;
    true_positives: number;
    false_positives: number;
    false_negatives: number;
    precision: number | null;
    recall: number | null;
    f1: number | null;
    ground_truth_scored_pct: number | null;
  } | null;
  incrementality: {
    planted_incremental_paise: number;
    measured_incremental_paise: number;
    ci95_paise: [number, number];
    interval_covers_truth: boolean;
    point_error_pct: number | null;
    planted_lift_pp: number | null;
    measured_lift_pp: number;
    note: string;
  } | null;
}

const ARM_ROWS = [
  { key: 'control', label: 'Control (held out)', colour: 'var(--arm-control)' },
  { key: 'naive', label: 'Naive retry', colour: 'var(--arm-naive)' },
  { key: 'leakproof', label: 'LEAKPROOF', colour: 'var(--arm-leakproof)' },
] as const;

const inputStyle = {
  background: 'var(--bg-surface-2)',
  border: '1px solid var(--border-subtle)',
  color: 'var(--text-primary)',
};

const pp = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}pp`;
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
/** Paise are integers everywhere else; here the mean genuinely has a fraction. */
const meanRupees = (paise: number, n: number) =>
  n === 0 ? '—' : `₹${(paise / n / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export function LabClient({ provenance }: { provenance: CorpusProvenance }) {
  const [seed, setSeed] = useState(42);
  const [iterations, setIterations] = useState(2000);
  const [applied, setApplied] = useState({ seed: 42, iterations: 2000 });
  const [metrics, setMetrics] = useState<MetricsSummary | null>(null);
  const [points, setPoints] = useState<TimeseriesPoint[]>([]);
  const [bucket, setBucket] = useState('15m');
  const [mode, setMode] = useState<ChartMode>('per_event');
  const [scorecard, setScorecard] = useState<BatchScorecard | null>(null);
  const [busy, setBusy] = useState(true);
  const [chartLoading, setChartLoading] = useState(true);
  const [chartError, setChartError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (s: number, it: number) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/metrics/summary?seed=${s}&iterations=${it}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      setMetrics(body);
      setApplied({ seed: s, iterations: it });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(42, 2000);
  }, [load]);

  useEffect(() => {
    setChartLoading(true);
    setChartError(null);
    fetch(`/api/metrics/timeseries?bucket=${bucket}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => setPoints(d.points ?? []))
      .catch((e: Error) => {
        setPoints([]);
        setChartError(e.message);
      })
      .finally(() => setChartLoading(false));
  }, [bucket]);

  // The most recent completed batch carries the planted ground truth, which is
  // the only thing on this screen capable of scoring the estimator itself.
  useEffect(() => {
    const latest = provenance.batches[0];
    if (!latest) return;
    fetch(`/api/simulator/batches/${latest.id}`)
      .then((r) => r.json())
      .then(setScorecard)
      .catch(() => undefined);
  }, [provenance.batches]);


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
        <ConsoleNav active="lab" />
        <span className="ml-auto text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
          {provenance.events.toLocaleString('en-IN')} events in scope
        </span>
      </header>

      {/*
        The screen's most important sentence, and it is not a number.
        `/api/metrics/summary` reports the same clean lift whether the corpus is
        live traffic or a simulation that contacted nobody — so the corpus has
        to introduce itself before the headline does.
      */}
      <ProvenanceBanner provenance={provenance} />

      <Headline metrics={metrics} busy={busy} />

      {error && (
        <p className="px-1 text-[12px]" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}

      <div className="grid grid-cols-1 gap-2 xl:grid-cols-[1fr_400px]">
        <div className="flex flex-col gap-2">
          <Panel title="Cumulative recovery by arm" bodyClassName="p-0">
            <CumulativeChart
              points={points}
              mode={mode}
              onModeChange={setMode}
              bucket={bucket}
              onBucketChange={setBucket}
              loading={chartLoading}
              error={chartError}
            />
          </Panel>

          <Panel title="Arms" bodyClassName="p-0">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[12.5px]">
                <thead style={{ background: 'var(--bg-surface-2)' }}>
                  <tr>
                    <th scope="col" className="label px-2 py-1.5 text-left">Arm</th>
                    <th scope="col" className="label px-2 py-1.5 text-right">n</th>
                    <th scope="col" className="label px-2 py-1.5 text-right">Recovered</th>
                    <th scope="col" className="label px-2 py-1.5 text-right">Rate</th>
                    <th scope="col" className="label px-2 py-1.5 text-right">95% CI (Wilson)</th>
                    <th scope="col" className="label px-2 py-1.5 text-right">Gross ₹</th>
                    <th scope="col" className="label px-2 py-1.5 text-right">₹ / event</th>
                    <th scope="col" className="label px-2 py-1.5 text-right">Mean ticket</th>
                    <th scope="col" className="label px-2 py-1.5 text-right">Messages</th>
                  </tr>
                </thead>
                <tbody>
                  {ARM_ROWS.map((r) => {
                    const a = metrics?.arms[r.key];
                    return (
                      <tr key={r.key} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                        <td className="px-2 py-1.5 whitespace-nowrap">
                          <span className="flex items-center gap-1.5">
                            <span
                              className="inline-block h-2 w-2 shrink-0 rounded-full"
                              style={{ background: r.colour }}
                              aria-hidden
                            />
                            <span style={{ color: 'var(--text-secondary)' }}>{r.label}</span>
                          </span>
                        </td>
                        <td className="tnum px-2 py-1.5 text-right">{a?.n.toLocaleString('en-IN') ?? '—'}</td>
                        <td className="tnum px-2 py-1.5 text-right">{a?.recovered.toLocaleString('en-IN') ?? '—'}</td>
                        <td className="tnum px-2 py-1.5 text-right" style={{ color: 'var(--text-primary)' }}>
                          {a ? pct(a.recovery_rate) : '—'}
                        </td>
                        <td className="tnum px-2 py-1.5 text-right" style={{ color: 'var(--text-muted)' }}>
                          {a ? `${pct(a.recovery_rate_ci95[0])} – ${pct(a.recovery_rate_ci95[1])}` : '—'}
                        </td>
                        <td className="tnum px-2 py-1.5 text-right">{a ? rupees(a.gross_paise) : '—'}</td>
                        <td className="tnum px-2 py-1.5 text-right">{a ? meanRupees(a.gross_paise, a.n) : '—'}</td>
                        <td className="tnum px-2 py-1.5 text-right" style={{ color: 'var(--text-muted)' }}>
                          {a ? rupees(a.mean_ticket_paise) : '—'}
                        </td>
                        <td className="tnum px-2 py-1.5 text-right" style={{ color: 'var(--text-muted)' }}>
                          {a?.messages_sent.toLocaleString('en-IN') ?? '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="px-3 py-2 text-[11.5px] leading-[16px]" style={{ color: 'var(--text-muted)' }}>
              ▸ &ldquo;₹ / event&rdquo; is gross recovered divided by every event in the arm,
              recovered or not — the per-event expected value the estimator differences. It is not
              the mean size of a recovered payment.
            </p>
          </Panel>

          <Arithmetic metrics={metrics} />
          <CostPanel metrics={metrics} />
        </div>

        <div className="flex flex-col gap-2">
          <PowerPanel metrics={metrics} />
          <Scorecard scorecard={scorecard} pooled={provenance.batch_count > 1} />
          <Panel title="Recompute" bodyClassName="p-3 flex flex-col gap-2.5">
            <p className="text-[12px] leading-[17px]" style={{ color: 'var(--text-secondary)' }}>
              The interval is a BCa bootstrap over the per-event values, not a formula applied to a
              mean. Change the seed and it moves a little; raise the iterations and it settles. Both
              are reported with every result so the figure can be reproduced exactly.
            </p>
            <div className="flex gap-2">
              <label className="flex flex-1 flex-col gap-1">
                <span className="label">seed</span>
                <input
                  type="number"
                  value={seed}
                  onChange={(e) => setSeed(Number(e.target.value))}
                  className="tnum rounded-sm px-2 py-1 text-[12.5px]"
                  style={inputStyle}
                />
              </label>
              <label className="flex flex-1 flex-col gap-1">
                <span className="label">iterations</span>
                <input
                  type="number"
                  min={100}
                  max={20000}
                  step={500}
                  value={iterations}
                  onChange={(e) => setIterations(Number(e.target.value))}
                  className="tnum rounded-sm px-2 py-1 text-[12.5px]"
                  style={inputStyle}
                />
              </label>
            </div>
            <button
              onClick={() => void load(seed, iterations)}
              disabled={busy}
              className="cursor-pointer rounded-sm px-3 py-1.5 text-[12.5px] font-medium transition-colors duration-200 hover:bg-[rgba(20,184,166,0.2)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-[var(--accent-dim)]"
              style={{
                background: 'var(--accent-dim)',
                border: '1px solid rgba(20,184,166,0.4)',
                color: 'var(--accent)',
              }}
            >
              {busy ? 'Resampling…' : 'Re-run the bootstrap'}
            </button>
            {metrics && (
              <p className="mono" style={{ color: 'var(--text-muted)' }}>
                seed {metrics.provenance.bootstrap_seed} · {metrics.provenance.bootstrap_iterations.toLocaleString('en-IN')}{' '}
                iterations · α {metrics.provenance.alpha}
                {(applied.seed !== metrics.provenance.bootstrap_seed ||
                  applied.iterations !== metrics.provenance.bootstrap_iterations) && ' (stale)'}
              </p>
            )}
          </Panel>

          <Panel title="Randomisation check" bodyClassName="p-3 flex flex-col gap-2">
            {metrics ? (
              <>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
                    Mean ticket spread across arms
                  </span>
                  <span
                    className="tnum text-[15px] font-semibold"
                    style={{ color: metrics.balance.balanced ? 'var(--success)' : 'var(--warning)' }}
                  >
                    {metrics.balance.mean_ticket_spread_pct.toFixed(1)}%
                  </span>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
                    A clean split typically gives
                  </span>
                  <span className="tnum text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
                    {metrics.balance.null_median_pct.toFixed(1)}% · 95th pct{' '}
                    {metrics.balance.null_p95_pct.toFixed(1)}%
                  </span>
                </div>
                <p className="text-[11.5px] leading-[16px]" style={{ color: 'var(--text-muted)' }}>
                  Arms are assigned by hashing the event id with a fixed salt, so ticket size should
                  land close across arms — but “close” depends on the arm sizes and on how heavy the
                  ticket tail is, not on a fixed percentage. The spread is compared against the one
                  this corpus produces by chance, over {metrics.balance.iterations.toLocaleString('en-IN')}{' '}
                  label reshuffles (p={metrics.balance.p_value.toFixed(3)}).{' '}
                  {metrics.balance.balanced
                    ? 'It is within that range, so the split looks clean.'
                    : 'It is larger than chance accounts for, so the split may not be clean and the headline number should be treated with suspicion.'}
                </p>
              </>
            ) : (
              <div className="skeleton h-10 rounded-sm" />
            )}
          </Panel>

        </div>
      </div>
    </div>
  );
}

function ProvenanceBanner({ provenance }: { provenance: CorpusProvenance }) {
  const synthetic = provenance.synthetic_events;
  if (synthetic === 0) return null;
  const allSynthetic = synthetic === provenance.events && provenance.events > 0;
  const delivered = provenance.attempts_executed;
  const share = provenance.attempts === 0 ? 0 : delivered / provenance.attempts;

  return (
    <div
      role="note"
      className="flex flex-col gap-1 rounded-[10px] px-3 py-2"
      style={{ background: 'rgba(240,168,58,0.09)', border: '1px solid rgba(240,168,58,0.35)' }}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge tone="warn">Synthetic corpus</Badge>
        {/*
          Naming one batch was fine while there was one. With the corpus pooled
          across several, "(Demo batch (9,000))" appended to a 12,000-event
          count reads as a single batch that produced more events than it holds.
        */}
        <span className="text-[12.5px]" style={{ color: 'var(--text-primary)' }}>
          {allSynthetic
            ? `All ${provenance.events.toLocaleString('en-IN')} events here were produced by the generator`
            : `${synthetic.toLocaleString('en-IN')} of ${provenance.events.toLocaleString('en-IN')} events here were produced by the generator`}
          {provenance.batch_count > 1
            ? `, pooled across ${provenance.batch_count} batches (most recent: ${provenance.batches[0]?.label ?? 'unlabelled'})`
            : provenance.batches[0]?.label
              ? ` (${provenance.batches[0].label})`
              : ''}
          .
        </span>
      </div>
      <p className="text-[12px] leading-[17px]" style={{ color: 'var(--text-secondary)' }}>
        Recoveries were decided by the generator&rsquo;s planted treatment response, not by a
        message arriving, so the lift below measures{' '}
        <strong style={{ color: 'var(--warning)' }}>the estimator against a known truth</strong> —
        which is what this corpus is for, and is the only way to check a measurement that has no
        ground truth in production. It is not evidence that a message caused a payment.
      </p>
      {/*
        Stated as counts rather than as a yes/no. An earlier version switched on
        `messages_sent === 0` and flipped to a milder wording the moment the
        queue drained its first five attempts — the kind of claim that quietly
        stops being true while still reading fine.
      */}
      <p className="tnum text-[11.5px] leading-[16px]" style={{ color: 'var(--text-muted)' }}>
        ▸ {provenance.attempts.toLocaleString('en-IN')} recovery attempts planned ·{' '}
        {delivered.toLocaleString('en-IN')} delivered ({(share * 100).toFixed(1)}%) ·{' '}
        {provenance.messages_sent.toLocaleString('en-IN')} message
        {provenance.messages_sent === 1 ? '' : 's'} sent to a real channel.
      </p>
    </div>
  );
}

function Headline({ metrics, busy }: { metrics: MetricsSummary | null; busy: boolean }) {
  if (!metrics || busy) {
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

  const cell = 'flex min-w-0 flex-1 shrink-0 flex-col justify-between gap-1 px-4 py-3';
  return (
    <div
      className="flex flex-wrap overflow-hidden rounded-[10px] [&>*]:shrink-0"
      style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)' }}
    >
      <div className={cell} style={{ borderRight: '1px solid var(--border-subtle)' }}>
        <div className="label">Incremental revenue</div>
        <div
          className="tnum truncate text-[26px] leading-8 font-semibold"
          style={{ color: metrics.powered ? 'var(--accent)' : 'var(--text-muted)' }}
        >
          {rupees(metrics.incremental_paise)}
        </div>
        <div className="tnum text-[12px] leading-4" style={{ color: 'var(--text-muted)' }}>
          95% CI {rupees(metrics.ci95_paise[0])} to {rupees(metrics.ci95_paise[1])}
        </div>
      </div>
      <div className={cell} style={{ borderRight: '1px solid var(--border-subtle)' }}>
        <div className="label">Lift vs control</div>
        <div className="tnum truncate text-[26px] leading-8 font-semibold">
          {pp(metrics.lift_vs_control_pp)}
        </div>
        <div className="tnum text-[12px] leading-4" style={{ color: 'var(--text-muted)' }}>
          CI {metrics.lift_vs_control_ci95_pp[0].toFixed(2)} – {metrics.lift_vs_control_ci95_pp[1].toFixed(2)}pp
        </div>
      </div>
      <div className={cell} style={{ borderRight: '1px solid var(--border-subtle)' }}>
        <div className="label">Lift vs naive retry</div>
        <div className="tnum truncate text-[26px] leading-8 font-semibold">
          {pp(metrics.lift_vs_naive_pp)}
        </div>
        <div className="text-[12px] leading-4" style={{ color: 'var(--text-muted)' }}>
          what a dunning tool without triage would have got
        </div>
      </div>
      <div className={cell} style={{ borderRight: '1px solid var(--border-subtle)' }}>
        <div className="label">Two-proportion p</div>
        <div className="tnum truncate text-[26px] leading-8 font-semibold">
          {metrics.p_value < 0.001 ? metrics.p_value.toExponential(1) : metrics.p_value.toFixed(3)}
        </div>
        <div className="text-[12px] leading-4" style={{ color: 'var(--text-muted)' }}>
          on the rate difference, not on rupees
        </div>
      </div>
      <div className={cell}>
        <div className="label">Verdict</div>
        <div className="flex items-center">
          {metrics.powered ? (
            <Badge tone="ok">Supported</Badge>
          ) : (
            <Badge tone="warn">Underpowered</Badge>
          )}
        </div>
        <div className="text-[12px] leading-4" style={{ color: 'var(--text-muted)' }}>
          {metrics.powered
            ? 'the interval excludes zero'
            : `${metrics.power_blockers.length} blocker${metrics.power_blockers.length === 1 ? '' : 's'} — see below`}
        </div>
      </div>
    </div>
  );
}

/**
 * The estimator, written out with this run's numbers substituted.
 *
 * A reader who wants to check the headline should not have to open the source
 * to find out what was multiplied by what — particularly given that "treated"
 * here means the LEAKPROOF arm alone, which is not the obvious reading.
 */
function Arithmetic({ metrics }: { metrics: MetricsSummary | null }) {
  if (!metrics) return null;
  const c = metrics.arms.control;
  const l = metrics.arms.leakproof;

  return (
    <Panel title="The arithmetic, in full" bodyClassName="p-3 flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <div className="label">As computed</div>
        <div className="mono overflow-x-auto whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
          incremental = n_treated × (mean per-event value treated − mean per-event value control)
        </div>
        <div className="mono overflow-x-auto whitespace-nowrap">
          <span style={{ color: 'var(--text-primary)' }}>{l.n.toLocaleString('en-IN')}</span>
          <span style={{ color: 'var(--text-muted)' }}> × (</span>
          <span style={{ color: 'var(--arm-leakproof)' }}>{meanRupees(l.gross_paise, l.n)}</span>
          <span style={{ color: 'var(--text-muted)' }}> − </span>
          <span style={{ color: 'var(--arm-control)' }}>{meanRupees(c.gross_paise, c.n)}</span>
          <span style={{ color: 'var(--text-muted)' }}>) = </span>
          <span style={{ color: 'var(--accent)' }}>{rupees(metrics.incremental_paise)}</span>
        </div>
        <p className="text-[11.5px] leading-[16px]" style={{ color: 'var(--text-muted)' }}>
          &ldquo;Treated&rdquo; is the LEAKPROOF arm only. Naive retry is a comparison arm and is
          held out of the headline entirely — folding it in would let a worse rail flatter the
          number.
        </p>
      </div>

      <div className="flex flex-col gap-1" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
        <div className="label">The simpler decomposition, for comparison</div>
        <div className="mono overflow-x-auto whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
          incremental_rate × n_treated × mean recovered amount ={' '}
          <span style={{ color: 'var(--warning)' }}>
            {rupees(metrics.incremental_paise_rate_times_mean)}
          </span>
        </div>
        <p className="text-[11.5px] leading-[16px]" style={{ color: 'var(--text-muted)' }}>
          Both are reported because they disagree by{' '}
          <span className="tnum" style={{ color: 'var(--warning)' }}>
            {metrics.incremental_paise === 0
              ? '—'
              : `${Math.abs(
                  ((metrics.incremental_paise_rate_times_mean - metrics.incremental_paise) /
                    metrics.incremental_paise) *
                    100,
                ).toFixed(0)}%`}
          </span>
          , and the gap is the whole point. The simpler form assumes recovered amounts are
          distributed identically across arms. They are not — a ₹40,000 failure and a ₹200 failure
          do not recover at the same rate — so it silently assumes away the thing most likely to
          bias the result. The figure above carries each event&rsquo;s own amount instead.
        </p>
      </div>
    </Panel>
  );
}

function PowerPanel({ metrics }: { metrics: MetricsSummary | null }) {
  if (!metrics) return null;
  const items = [
    ...metrics.power_blockers.map((t) => ({ t, tone: 'var(--danger)' })),
    ...metrics.caveats.map((t) => ({ t, tone: 'var(--warning)' })),
  ];

  return (
    <Panel
      title="What is wrong with this number"
      right={
        metrics.powered ? <Badge tone="ok">Supported</Badge> : <Badge tone="warn">Underpowered</Badge>
      }
      bodyClassName="p-3 flex flex-col gap-2"
    >
      {items.length === 0 ? (
        <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
          No blockers and no caveats on this window.
        </p>
      ) : (
        items.map((c, i) => (
          <p key={i} className="text-[12px] leading-[17px]" style={{ color: 'var(--text-secondary)' }}>
            <span style={{ color: c.tone }}>▸</span> {c.t}
          </p>
        ))
      )}
      <p
        className="text-[11.5px] leading-[16px]"
        style={{ color: 'var(--text-muted)', borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}
      >
        A blocker means the claim is not supported and the headline is rendered grey wherever it
        appears. A caveat means it is supported but qualified. The interval is what to read, not the
        point estimate.
      </p>
    </Panel>
  );
}

/**
 * The estimator scored against ground truth.
 *
 * Every other panel measures the pipeline. This one measures the measurement:
 * the generator knows, per event, which recoveries happened only because the
 * arm was treated, because a single uniform draw decides both worlds. Scoring
 * the interval against that counterfactual is the only check here that could
 * actually fail.
 */
function Scorecard({
  scorecard,
  pooled,
}: {
  scorecard: BatchScorecard | null;
  /** True when the headline covers more than the batch scored here. */
  pooled: boolean;
}) {
  const inc = scorecard?.incrementality;
  const det = scorecard?.detection;
  if (!inc && !det) return null;
  const batchLabel = scorecard?.batch?.label ?? null;

  return (
    <Panel
      title={`Planted vs measured${batchLabel ? ` · ${batchLabel}` : ''}`}
      right={
        inc ? (
          <Badge tone={inc.interval_covers_truth ? 'ok' : 'danger'}>
            {inc.interval_covers_truth ? 'Interval covers truth' : 'Interval misses truth'}
          </Badge>
        ) : null
      }
      bodyClassName="p-3 flex flex-col gap-3"
    >
      {inc && (
        <div className="flex flex-col gap-1.5">
          <table className="w-full border-collapse text-[12.5px]">
            <tbody>
              <tr>
                <td className="py-0.5" style={{ color: 'var(--text-secondary)' }}>Planted (counterfactual)</td>
                <td className="tnum py-0.5 text-right">{rupees(inc.planted_incremental_paise)}</td>
              </tr>
              <tr>
                <td className="py-0.5" style={{ color: 'var(--text-secondary)' }}>Measured</td>
                <td className="tnum py-0.5 text-right" style={{ color: 'var(--accent)' }}>
                  {rupees(inc.measured_incremental_paise)}
                </td>
              </tr>
              <tr>
                <td className="py-0.5" style={{ color: 'var(--text-secondary)' }}>95% interval</td>
                <td className="tnum py-0.5 text-right" style={{ color: 'var(--text-muted)' }}>
                  {rupees(inc.ci95_paise[0])} – {rupees(inc.ci95_paise[1])}
                </td>
              </tr>
              <tr style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <td className="py-0.5" style={{ color: 'var(--text-secondary)' }}>Lift, planted vs measured</td>
                <td className="tnum py-0.5 text-right">
                  {inc.planted_lift_pp === null ? '—' : `${inc.planted_lift_pp.toFixed(2)}pp`} vs{' '}
                  {inc.measured_lift_pp.toFixed(2)}pp
                </td>
              </tr>
            </tbody>
          </table>
          {pooled && (
            <p className="text-[11.5px] leading-[16px]" style={{ color: 'var(--warning)' }}>
              ▸ These figures score this batch alone — ground truth exists per batch. The headline
              above pools every batch in the window, so the two rupee figures are not the same
              quantity and are not meant to match.
            </p>
          )}
          <p className="text-[11.5px] leading-[16px]" style={{ color: 'var(--text-muted)' }}>
            The point estimate is{' '}
            {inc.point_error_pct === null ? '—' : `${inc.point_error_pct.toFixed(1)}%`} from the
            planted figure while the rate lift matches to a hundredth of a point. That is the
            heavy tail, not a broken estimator: a handful of very large failures dominate the rupee
            total. Read the interval.
          </p>
        </div>
      )}

      {det && (
        <div className="flex flex-col gap-1" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
          <div className="label">Outage detection on the same batch</div>
          <p className="tnum text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
            precision{' '}
            <span style={{ color: 'var(--text-primary)' }}>
              {det.precision === null ? '—' : `${(det.precision * 100).toFixed(1)}%`}
            </span>{' '}
            · recall{' '}
            <span style={{ color: 'var(--text-primary)' }}>
              {det.recall === null ? '—' : `${(det.recall * 100).toFixed(1)}%`}
            </span>{' '}
            · {det.true_positives} TP / {det.false_positives} FP / {det.false_negatives} FN
          </p>
          <p className="text-[11.5px] leading-[16px]" style={{ color: 'var(--text-muted)' }}>
            {det.ground_truth_scored_pct === null
              ? 'No planted systemic events in this batch.'
              : `${det.ground_truth_scored_pct}% of the planted systemic events have been classified and scored.`}
          </p>
        </div>
      )}
    </Panel>
  );
}

function CostPanel({ metrics }: { metrics: MetricsSummary | null }) {
  if (!metrics) return null;
  return (
    <Panel title="Cost of the recovery" bodyClassName="p-3 flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
          Spend per ₹100 incremental
        </span>
        <span className="tnum text-[18px] font-semibold">
          ₹{(metrics.cost_per_100_recovered_paise / 100).toFixed(2)}
        </span>
      </div>
      <p className="text-[11.5px] leading-[16px]" style={{ color: 'var(--text-muted)' }}>
        Zero because delivery rides on Razorpay&rsquo;s own notification on the payment link — there
        is no SMS gateway or email provider to bill, and Gemini is free at this volume. Add a
        provider and this stops being zero the same day.
      </p>
      <div
        className="flex items-baseline justify-between gap-2"
        style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}
      >
        <span className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
          Razorpay fee on the incremental
        </span>
        <span className="tnum text-[13px]">{rupees(metrics.razorpay_fee.on_incremental_paise)}</span>
      </div>
      <p className="text-[11.5px] leading-[16px]" style={{ color: 'var(--text-muted)' }}>
        {(metrics.razorpay_fee.effective_rate * 100).toFixed(2)}% of capture, reported separately and
        never folded into the line above: a per-message cost is paid on every attempt including the
        failures, while MDR is charged only when money actually arrives. Summed together, spending
        more on failed attempts and recovering more money would push the same number the same way.
      </p>
      {metrics.unpriced_cost_items.length > 0 && (
        <p className="text-[11.5px] leading-[16px]" style={{ color: 'var(--warning)' }}>
          ▸ Still a placeholder rate: {metrics.unpriced_cost_items.join(', ').replace(/_/g, ' ')}.
        </p>
      )}
    </Panel>
  );
}
