'use client';

import { Badge, Panel, rupees } from '@/components/primitives';
import { CountUp, useChangePulse } from '@/components/motion';

export interface MetricsSummary {
  arms: Record<
    string,
    {
      n: number;
      recovered: number;
      recovery_rate: number;
      recovery_rate_ci95: [number, number];
      gross_paise: number;
      mean_ticket_paise: number;
      cost_paise: number;
      messages_sent: number;
    }
  >;
  incremental_paise: number;
  ci95_paise: [number, number];
  /** The blueprint's simpler decomposition, shown beside it on the lab. */
  incremental_paise_rate_times_mean: number;
  lift_vs_control_pp: number;
  lift_vs_control_ci95_pp: [number, number];
  lift_vs_naive_pp: number;
  p_value: number;
  powered: boolean;
  power_blockers: string[];
  caveats: string[];
  cost_per_100_recovered_paise: number;
  razorpay_fee: {
    on_incremental_paise: number;
    on_gross_recovered_paise: number;
    effective_rate: number;
    note: string;
  };
  false_nudge_rate: number;
  contact_budget: { used: number; cap: number };
  cost_breakdown_paise: Record<string, number>;
  balance: {
    mean_ticket_spread_pct: number;
    balanced: boolean;
    p_value: number;
    null_median_pct: number;
    null_p95_pct: number;
    iterations: number;
  };
  provenance: { bootstrap_iterations: number; bootstrap_seed: number; alpha: number };
  unpriced_cost_items: string[];
}

/**
 * One KPI.
 *
 * `numeric`/`format` opt the tile into a counted transition instead of a hard
 * swap. That is not decoration on a 5-second poll: a figure that jumps from
 * ₹4.2L to ₹4.8L between blinks is easy to miss entirely, and the tile also
 * flashes its own background once when the value underneath it changes. Tiles
 * whose value is not a number (an em-dash, a percentage with a sign) pass
 * `value` and get the flash without the count.
 */
function Tile({
  label,
  value,
  numeric,
  format,
  sub,
  tone = 'default',
  title,
}: {
  label: string;
  value: string;
  numeric?: number;
  format?: (n: number) => string;
  sub?: React.ReactNode;
  tone?: 'default' | 'muted' | 'warn' | 'accent';
  title?: string;
}) {
  const pulse = useChangePulse(numeric ?? value);
  const colour =
    tone === 'muted'
      ? 'var(--text-muted)'
      : tone === 'warn'
        ? 'var(--warning)'
        : tone === 'accent'
          ? 'var(--accent)'
          : 'var(--text-primary)';
  return (
    <div
      className={`group relative flex min-w-0 flex-1 flex-col justify-between gap-1 px-4 py-3 transition-colors duration-300 hover:bg-[var(--bg-surface-2)] ${pulse}`}
      title={title}
      style={{ borderRight: '1px solid var(--border-subtle)' }}
    >
      <div className="label transition-colors duration-300 group-hover:text-[var(--text-secondary)]">
        {label}
      </div>
      <div className="tnum truncate text-[26px] leading-8 font-semibold" style={{ color: colour }}>
        {numeric !== undefined && format ? (
          <CountUp value={numeric} format={format} />
        ) : (
          value
        )}
      </div>
      <div className="text-[12px] leading-4" style={{ color: 'var(--text-muted)' }}>
        {sub}
      </div>
    </div>
  );
}

export function KpiStrip({
  metrics,
  atRisk,
  breakerOpen,
  loading,
}: {
  metrics: MetricsSummary | null;
  atRisk: { events: number; paise: number } | null;
  breakerOpen: boolean;
  loading: boolean;
}) {
  if (loading || !metrics || !atRisk) {
    return (
      <div
        className="flex h-[92px] overflow-hidden rounded-[10px]"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)' }}
      >
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="skeleton flex-1" style={{ opacity: 0.5 }} />
        ))}
      </div>
    );
  }

  const lp = metrics.arms.leakproof;
  const ctrl = metrics.arms.control;
  const grossPaise = Object.values(metrics.arms).reduce((a, x) => a + x.gross_paise, 0);

  return (
    <div
      className="flex flex-wrap overflow-hidden rounded-[10px]"
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-subtle)',
        // Blueprint: breaker open puts a red left border on the whole strip.
        borderLeft: breakerOpen ? '3px solid var(--danger)' : '1px solid var(--border-subtle)',
      }}
    >
      <Tile
        label="At risk now"
        value={rupees(atRisk.paise, { compact: true })}
        numeric={atRisk.paise}
        format={(n) => rupees(n, { compact: true })}
        sub={`${atRisk.events.toLocaleString('en-IN')} open events`}
        tone="warn"
        title={rupees(atRisk.paise)}
      />
      <Tile
        label="Gross recovered"
        value={rupees(grossPaise, { compact: true })}
        numeric={grossPaise}
        format={(n) => rupees(n, { compact: true })}
        sub={`${Object.values(metrics.arms).reduce((a, x) => a + x.recovered, 0)} events, all arms`}
      />
      {/*
        The headline. Rendered grey and labelled when the experiment cannot
        support the claim — an underpowered number shown confidently is the
        single most misleading thing this screen could do.
      */}
      <Tile
        label="Incremental"
        value={metrics.powered ? rupees(metrics.incremental_paise, { compact: true }) : '——'}
        numeric={metrics.powered ? metrics.incremental_paise : undefined}
        format={(n) => rupees(n, { compact: true })}
        tone={metrics.powered ? 'accent' : 'muted'}
        title={
          metrics.powered
            ? `${rupees(metrics.incremental_paise)} · 95% CI ${rupees(metrics.ci95_paise[0])} to ${rupees(metrics.ci95_paise[1])}`
            : metrics.power_blockers.join(' · ')
        }
        sub={
          metrics.powered ? (
            <span className="tnum">
              95% CI {rupees(metrics.ci95_paise[0], { compact: true })} –{' '}
              {rupees(metrics.ci95_paise[1], { compact: true })}
            </span>
          ) : (
            <Badge tone="muted" title={metrics.power_blockers.join(' · ')}>
              Underpowered
            </Badge>
          )
        }
      />
      <Tile
        label="Lift vs control"
        value={`${metrics.lift_vs_control_pp >= 0 ? '+' : ''}${metrics.lift_vs_control_pp.toFixed(2)}pp`}
        tone={metrics.powered ? 'default' : 'muted'}
        title={`leakproof ${(lp?.recovery_rate * 100).toFixed(2)}% vs control ${(ctrl?.recovery_rate * 100).toFixed(2)}%`}
        sub={
          <span className="tnum">
            CI {metrics.lift_vs_control_ci95_pp[0].toFixed(1)} –{' '}
            {metrics.lift_vs_control_ci95_pp[1].toFixed(1)}pp · p=
            {metrics.p_value < 0.001 ? metrics.p_value.toExponential(1) : metrics.p_value.toFixed(3)}
          </span>
        }
      />
      {/*
        Zero is the honest answer, not a missing number: delivery is Razorpay's
        own notification on the payment link, so there is no per-message charge
        to bill. The sub-line says so, because a bare ₹0.00 reads as a bug.
      */}
      <Tile
        label="Cost per ₹100"
        value={`₹${(metrics.cost_per_100_recovered_paise / 100).toFixed(2)}`}
        title={
          'Delivery is bundled with the Razorpay payment link — no SMS gateway, no email provider, no LLM spend at this volume. ' +
          `Razorpay's fee on recovered money is reported separately: ${(metrics.razorpay_fee.effective_rate * 100).toFixed(2)}% of capture.`
        }
        sub={
          <span>
            messaging bundled · Razorpay fee{' '}
            {(metrics.razorpay_fee.effective_rate * 100).toFixed(2)}% on capture
          </span>
        }
      />
    </div>
  );
}

export interface LiveOutage {
  cohort: string;
  issuer: string | null;
  method: string | null;
  events: number;
  decline_rate: number;
  paise_parked: number;
  first_seen: string;
  last_seen: string;
  peak_confidence: number;
  downtime_api_agrees: boolean | null;
  downtime_api_why?: string | null;
  open?: boolean;
}

export function OutageBanner({ outages }: { outages: LiveOutage[] }) {
  if (outages.length === 0) return null;

  /**
   * Biggest first, and only the top few get a banner.
   *
   * The detector's false positives are real and belong on the screen, but they
   * are single-event blips — giving each one the same full-width red bar as a
   * 36-event outage that parked ₹1.5 lakh buries the incident that matters
   * under the noise it also found. The rest are counted on one line, so nothing
   * is hidden.
   */
  const ranked = [...outages].sort((a, b) => b.events - a.events || b.paise_parked - a.paise_parked);
  const open = ranked.filter((o) => o.open !== false);
  const shown = ranked.slice(0, Math.max(open.length, 2));
  const rest = ranked.slice(shown.length);

  return (
    <div className="flex flex-col gap-1.5">
      {shown.map((o) => (
        <div
          key={o.cohort}
          role="status"
          className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-[10px] px-3 py-2"
          style={{
            // A resolved incident still belongs on the screen — a batch replays
            // a day in minutes — but it must not look like it is happening now.
            background: o.open === false ? 'rgba(100,120,154,0.09)' : 'rgba(240,85,79,0.09)',
            border: `1px solid ${o.open === false ? 'var(--border-subtle)' : 'rgba(240,85,79,0.35)'}`,
          }}
        >
          <span className="flex items-center gap-2">
            <span
              className={`inline-block h-2 w-2 rounded-full ${o.open === false ? '' : 'pulse-danger'}`}
              style={{ background: o.open === false ? 'var(--text-muted)' : 'var(--danger)' }}
              aria-hidden
            />
            <strong style={{ color: o.open === false ? 'var(--text-secondary)' : 'var(--danger)' }}>
              {o.open === false ? 'RESOLVED' : 'OUTAGE'} · {o.issuer ?? 'unknown'} /{' '}
              {o.method ?? 'unknown'}
            </strong>
          </span>
          <span className="tnum" style={{ color: 'var(--text-secondary)' }}>
            {(o.decline_rate * 100).toFixed(0)}% decline
          </span>
          <span className="tnum" style={{ color: 'var(--text-secondary)' }}>
            {rupees(o.paise_parked)} parked
          </span>
          <span className="tnum" style={{ color: 'var(--text-secondary)' }}>
            {o.events} event{o.events === 1 ? '' : 's'} held
          </span>
          {/*
            "No signal" and "disagreed" are different facts and are shown as
            different things. The Downtime API is recorded as corroboration and
            is never an input to the classification — feeding it in would make
            validating the classifier against it circular.
          */}
          <span className="ml-auto">
            {o.downtime_api_agrees === true ? (
              <Badge tone="ok" title={o.downtime_api_why ?? undefined}>
                Downtime API agrees
              </Badge>
            ) : o.downtime_api_agrees === false ? (
              <Badge tone="warn" title={o.downtime_api_why ?? undefined}>
                Downtime API disagrees
              </Badge>
            ) : (
              <Badge
                tone="muted"
                title={o.downtime_api_why ?? 'Recorded as corroboration only, never an input'}
              >
                Downtime API — no signal
              </Badge>
            )}
          </span>
        </div>
      ))}
      {rest.length > 0 && (
        <p className="px-1 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
          + {rest.length} smaller cohort{rest.length === 1 ? '' : 's'} also flagged (
          {rest.reduce((a, o) => a + o.events, 0)} event
          {rest.reduce((a, o) => a + o.events, 0) === 1 ? '' : 's'} total) —{' '}
          <a href="/api/outages" style={{ color: 'var(--accent)' }}>
            all windows
          </a>
        </p>
      )}
    </div>
  );
}

export function ArmComparison({ metrics }: { metrics: MetricsSummary | null }) {
  if (!metrics) return null;
  const rows: Array<{ arm: string; colour: string; label: string }> = [
    { arm: 'control', colour: 'var(--arm-control)', label: 'Control (held out)' },
    { arm: 'naive', colour: 'var(--arm-naive)', label: 'Naive retry' },
    { arm: 'leakproof', colour: 'var(--arm-leakproof)', label: 'LEAKPROOF' },
  ];
  const max = Math.max(...rows.map((r) => metrics.arms[r.arm]?.recovery_rate ?? 0), 0.01);

  return (
    <Panel title="Arms" bodyClassName="p-3 flex flex-col gap-3">
      {rows.map((r) => {
        const a = metrics.arms[r.arm];
        if (!a) return null;
        return (
          <div key={r.arm} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[12.5px]">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: r.colour }}
                  aria-hidden
                />
                <span style={{ color: 'var(--text-secondary)' }}>{r.label}</span>
              </span>
              <span className="tnum text-[12.5px]" style={{ color: 'var(--text-primary)' }}>
                {(a.recovery_rate * 100).toFixed(2)}%
              </span>
            </div>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full"
              style={{ background: 'var(--bg-surface-2)' }}
            >
              <div
                className="h-full rounded-full"
                style={{ width: `${(a.recovery_rate / max) * 100}%`, background: r.colour }}
              />
            </div>
            <div className="tnum text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {a.recovered}/{a.n} · CI {(a.recovery_rate_ci95[0] * 100).toFixed(1)}–
              {(a.recovery_rate_ci95[1] * 100).toFixed(1)}%
            </div>
          </div>
        );
      })}
      {!metrics.balance.balanced && (
        <p className="text-[11.5px]" style={{ color: 'var(--warning)' }}>
          Randomisation check: mean ticket differs {metrics.balance.mean_ticket_spread_pct.toFixed(1)}%
          across arms, more than chance accounts for at these arm sizes (p=
          {metrics.balance.p_value.toFixed(3)}, chance typically gives{' '}
          {metrics.balance.null_median_pct.toFixed(1)}%) — treat the headline with caution.
        </p>
      )}
    </Panel>
  );
}
