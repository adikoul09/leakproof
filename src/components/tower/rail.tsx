'use client';

import { Panel, rupees } from '@/components/primitives';
import type { MetricsSummary } from './kpi';

export function FailureMix({
  mix,
  windowMinutes,
}: {
  mix: Array<{ failure_class: string; n: number; paise: number }>;
  windowMinutes: number;
}) {
  const total = mix.reduce((a, m) => a + m.n, 0);
  return (
    <Panel title={`Failure mix · last ${windowMinutes}m`} bodyClassName="p-3 flex flex-col gap-2">
      {total === 0 ? (
        <p className="text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
          Nothing classified in this window.
        </p>
      ) : (
        mix.slice(0, 7).map((m) => (
          <div key={m.failure_class} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
              <span className="truncate" style={{ color: 'var(--text-secondary)' }}>
                {m.failure_class.replace(/_/g, ' ')}
              </span>
              <span className="tnum shrink-0" style={{ color: 'var(--text-muted)' }}>
                {m.n} · {rupees(m.paise, { compact: true })}
              </span>
            </div>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full"
              style={{ background: 'var(--bg-surface-2)' }}
            >
              <div
                className="h-full rounded-full"
                style={{
                  width: `${(m.n / total) * 100}%`,
                  background:
                    m.failure_class === 'issuer_degraded' || m.failure_class === 'network_degraded'
                      ? 'var(--danger)'
                      : 'var(--info)',
                }}
              />
            </div>
          </div>
        ))
      )}
    </Panel>
  );
}

export function ContactBudget({ metrics }: { metrics: MetricsSummary | null }) {
  if (!metrics) return null;
  const { used, cap } = metrics.contact_budget;
  const pct = cap === 0 ? 0 : Math.min(100, (used / cap) * 100);
  return (
    <Panel title="Contact budget" bodyClassName="p-3 flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="tnum text-[20px] font-semibold">{used.toLocaleString('en-IN')}</span>
        <span className="tnum text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
          / {cap.toLocaleString('en-IN')} messages
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full"
        style={{ background: 'var(--bg-surface-2)' }}
      >
        <div
          className="h-full rounded-full"
          style={{
            width: `${pct}%`,
            background: pct > 85 ? 'var(--warning)' : 'var(--accent)',
          }}
        />
      </div>
      <p className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
        Weekly cap from the live policy. The gate blocks past it — the cap is not advisory.
      </p>
    </Panel>
  );
}

export function CostToday({ metrics }: { metrics: MetricsSummary | null }) {
  if (!metrics) return null;
  const entries = Object.entries(metrics.cost_breakdown_paise).filter(([, v]) => v > 0);
  const total = entries.reduce((a, [, v]) => a + v, 0);
  return (
    <Panel title="Cost" bodyClassName="p-3 flex flex-col gap-1.5">
      <div className="tnum text-[20px] font-semibold">{rupees(total)}</div>
      {entries.length === 0 ? (
        <p className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
          Nothing spent yet.
        </p>
      ) : (
        entries.map(([k, v]) => (
          <div key={k} className="flex justify-between text-[12.5px]">
            <span style={{ color: 'var(--text-secondary)' }}>{k.replace(/_/g, ' ')}</span>
            <span className="tnum" style={{ color: 'var(--text-muted)' }}>
              {rupees(v)}
            </span>
          </div>
        ))
      )}
      {entries.length === 0 && (
        <p className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
          Delivery is bundled with the Razorpay payment link — no SMS gateway, no email provider,
          and Gemini is free at this volume. Nothing is billed per attempt.
        </p>
      )}

      {/*
        Reported separately and never summed into the line above. A per-message
        cost is incurred on every attempt including the failures; MDR is charged
        only on capture. Adding them makes "cost per ₹100 recovered" meaningless.
      */}
      <div
        className="mt-1 flex flex-col gap-0.5 pt-2"
        style={{ borderTop: '1px solid var(--border-subtle)' }}
      >
        <div className="flex justify-between text-[12.5px]">
          <span style={{ color: 'var(--text-secondary)' }}>
            Razorpay fee on recovered ({(metrics.razorpay_fee.effective_rate * 100).toFixed(2)}%)
          </span>
          <span className="tnum" style={{ color: 'var(--text-muted)' }}>
            {rupees(metrics.razorpay_fee.on_gross_recovered_paise)}
          </span>
        </div>
        <p className="text-[11px] leading-[15px]" style={{ color: 'var(--text-muted)' }}>
          Charged on capture, not per attempt — so it is a fee on money that would otherwise have
          been lost, not a cost of trying. Kept out of the figure above for that reason.
        </p>
      </div>

      {metrics.unpriced_cost_items.length > 0 && (
        <p className="mt-1 text-[11.5px]" style={{ color: 'var(--warning)' }}>
          Still a placeholder: {metrics.unpriced_cost_items.join(', ')}.
        </p>
      )}
    </Panel>
  );
}

/**
 * The caveats the metrics module attaches to its own result, shown beside the
 * number rather than buried in a methodology note. If the experiment cannot
 * support a claim, the screen that shows the claim has to say so.
 */
export function Caveats({ metrics }: { metrics: MetricsSummary | null }) {
  if (!metrics) return null;
  const items = [...metrics.power_blockers, ...metrics.caveats];
  if (items.length === 0) return null;
  return (
    <Panel title="Read this with the number" bodyClassName="p-3 flex flex-col gap-1.5">
      {items.map((c, i) => (
        <p key={i} className="text-[12px] leading-[17px]" style={{ color: 'var(--text-secondary)' }}>
          <span style={{ color: 'var(--warning)' }}>▸</span> {c}
        </p>
      ))}
      <p className="mono mt-1" style={{ color: 'var(--text-muted)' }}>
        bootstrap seed {metrics.provenance.bootstrap_seed} ·{' '}
        {metrics.provenance.bootstrap_iterations.toLocaleString('en-IN')} iterations · α{' '}
        {metrics.provenance.alpha}
      </p>
    </Panel>
  );
}
