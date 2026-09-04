'use client';

import {
  ArmChip,
  Badge,
  ClassificationChip,
  Empty,
  StateBadge,
  istTime,
  rupees,
} from '@/components/primitives';

export interface QueueRow {
  id: string;
  surface: string;
  failed_at: string;
  amount_paise: number;
  customer_masked: string | null;
  method: string | null;
  issuer: string | null;
  failure_class: string | null;
  kind: string | null;
  confidence: number | null;
  cohort_key: string | null;
  arm: string | null;
  state: string;
  rail: string | null;
  attempt_no: number | null;
  scheduled_for: string | null;
  attempt_outcome: string | null;
  gate_result: string | null;
  recovered_at: string | null;
  recovered_paise: number | null;
  is_synthetic: boolean;
}

export type QueueFilter =
  | 'all'
  | 'systemic'
  | 'idiosyncratic'
  | 'blocked'
  | 'control'
  | 'recovered';

const FILTERS: Array<{ key: QueueFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'systemic', label: 'Systemic' },
  { key: 'idiosyncratic', label: 'Idiosyncratic' },
  { key: 'blocked', label: 'Blocked by policy' },
  { key: 'control', label: 'Control' },
  { key: 'recovered', label: 'Recovered' },
];

export function QueueFilterTabs({
  active,
  counts,
  onChange,
}: {
  active: QueueFilter;
  counts: Record<QueueFilter, number> | null;
  onChange: (f: QueueFilter) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1" role="tablist" aria-label="Queue filter">
      {FILTERS.map((f) => {
        const on = f.key === active;
        return (
          <button
            key={f.key}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(f.key)}
            className="cursor-pointer rounded-sm px-2 py-1 text-[12px] transition-colors"
            style={{
              color: on ? 'var(--accent)' : 'var(--text-secondary)',
              background: on ? 'var(--accent-dim)' : 'transparent',
              border: `1px solid ${on ? 'rgba(20,184,166,0.32)' : 'var(--border-subtle)'}`,
            }}
          >
            {f.label}
            {counts && (
              <span className="tnum ml-1.5" style={{ color: 'var(--text-muted)' }}>
                {counts[f.key].toLocaleString('en-IN')}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

const TH = 'px-2 py-1.5 text-left label whitespace-nowrap';
const TD = 'px-2 py-1.5 align-middle whitespace-nowrap';

/** What the row says will happen next, in the language the operator thinks in. */
function nextAction(r: QueueRow): { text: string; tone: 'muted' | 'warn' | 'accent' | 'info' } {
  if (r.recovered_at) return { text: 'closed — money in', tone: 'muted' };
  if (r.arm === 'control') return { text: 'held out, never contacted', tone: 'info' };
  if (r.state === 'blocked_by_policy') {
    return { text: r.gate_result?.replace('block:', '') ?? 'blocked', tone: 'warn' };
  }
  if (r.state === 'waiting_out_outage') return { text: 'waiting out the outage', tone: 'warn' };
  if (r.scheduled_for && !r.attempt_outcome) {
    return { text: `${r.rail ?? 'send'} at ${istTime(r.scheduled_for)}`, tone: 'accent' };
  }
  if (r.state === 'action_sent') return { text: `${r.rail ?? 'sent'} · awaiting`, tone: 'accent' };
  return { text: 'awaiting triage', tone: 'muted' };
}

export function AtRiskQueueTable({
  rows,
  loading,
  newIds,
  selectedId,
  onSelect,
  onLoadMore,
  hasMore,
}: {
  rows: QueueRow[];
  loading: boolean;
  newIds: Set<string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onLoadMore: () => void;
  hasMore: boolean;
}) {
  if (loading && rows.length === 0) {
    return (
      <div className="flex flex-col gap-px p-2">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="skeleton h-8 rounded-sm" />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <Empty
        message="No events yet. Run the simulator to generate a batch."
        action={
          <code className="mono rounded-sm px-2 py-1" style={{ background: 'var(--bg-surface-2)' }}>
            npm run simulate -- --preset panel
          </code>
        }
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-[12.5px]">
          <thead
            className="sticky top-0 z-10"
            style={{ background: 'var(--bg-surface-2)', boxShadow: '0 1px 0 var(--border-subtle)' }}
          >
            <tr>
              <th scope="col" className={TH}>Time</th>
              <th scope="col" className={`${TH} text-right`}>Amount</th>
              <th scope="col" className={TH}>Customer</th>
              <th scope="col" className={TH}>Issuer / method</th>
              <th scope="col" className={TH}>Classification</th>
              <th scope="col" className={TH}>Arm</th>
              <th scope="col" className={TH}>Status</th>
              <th scope="col" className={TH}>Next action</th>
              <th scope="col" className={TH} aria-label="Open trace" />
            </tr>
          </thead>
          <tbody role="log" aria-live="polite" aria-relevant="additions">
            {rows.map((r) => {
              const na = nextAction(r);
              const selected = r.id === selectedId;
              return (
                <tr
                  key={r.id}
                  tabIndex={0}
                  onClick={() => onSelect(r.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelect(r.id);
                    }
                  }}
                  className={`cursor-pointer ${newIds.has(r.id) ? 'row-new' : ''}`}
                  style={{
                    borderBottom: '1px solid var(--border-subtle)',
                    borderLeft: `2px solid ${selected ? 'var(--accent)' : 'transparent'}`,
                    background: selected ? 'var(--bg-hover)' : undefined,
                  }}
                  aria-label={`${rupees(r.amount_paise)} ${r.issuer ?? ''} ${r.failure_class ?? ''}`}
                >
                  <td className={`${TD} tnum`} style={{ color: 'var(--text-muted)' }}>
                    {istTime(r.failed_at)}
                  </td>
                  <td className={`${TD} tnum text-right font-medium`}>{rupees(r.amount_paise)}</td>
                  <td className={`${TD} mono`} style={{ color: 'var(--text-secondary)' }}>
                    {r.customer_masked ?? '—'}
                  </td>
                  <td className={TD} style={{ color: 'var(--text-secondary)' }}>
                    {r.issuer ?? '—'}
                    <span style={{ color: 'var(--text-muted)' }}> / {r.method ?? '—'}</span>
                  </td>
                  <td className={TD}>
                    <ClassificationChip
                      kind={r.kind}
                      failureClass={r.failure_class}
                      confidence={r.confidence}
                    />
                  </td>
                  <td className={TD}>
                    <ArmChip arm={r.arm} />
                  </td>
                  <td className={TD}>
                    <StateBadge state={r.state} recovered={r.recovered_at !== null} />
                  </td>
                  <td className={TD} style={{ color: `var(--${na.tone === 'muted' ? 'text-muted' : na.tone === 'warn' ? 'warning' : na.tone === 'info' ? 'info' : 'accent'})` }}>
                    {na.text}
                  </td>
                  <td className={TD} style={{ color: 'var(--text-muted)' }} aria-hidden>
                    ▸
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div
        className="flex shrink-0 items-center justify-between gap-2 px-3 py-2"
        style={{ borderTop: '1px solid var(--border-subtle)' }}
      >
        <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
          {rows.length.toLocaleString('en-IN')} rows loaded
          {rows.some((r) => r.is_synthetic) && (
            <>
              {' · '}
              <Badge tone="muted">All data synthetic</Badge>
            </>
          )}
        </span>
        {hasMore && (
          <button
            onClick={onLoadMore}
            disabled={loading}
            className="cursor-pointer rounded-sm px-2.5 py-1 text-[12px] disabled:cursor-not-allowed disabled:opacity-40"
            style={{ border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' }}
          >
            {loading ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </div>
  );
}
