'use client';

import { useEffect, useState } from 'react';
import { Badge, istDateTime, rupees } from '@/components/primitives';

interface RuleTrace {
  rule: string;
  expected: string;
  actual: string;
  pass: boolean;
}

interface Trace {
  event: {
    id: string;
    surface: string;
    state: string;
    amount_paise: number;
    currency: string;
    method: string | null;
    issuer: string | null;
    card_network: string | null;
    order_id: string | null;
    amount_band: string | null;
    is_synthetic: boolean;
    failed_at: string;
    recovered_at: string | null;
    recovered_paise: number | null;
    error: Record<string, string | null>;
    customer: {
      id: string;
      phone_masked: string;
      opted_out_at: string | null;
      opt_out_reason: string | null;
    } | null;
  };
  classification: {
    kind: string;
    failure_class: string;
    confidence: number;
    cohort_key: string;
    cohort_decline_rate: number | null;
    cohort_n: number | null;
    downtime_api_agrees: boolean | null;
    classified_at: string;
  } | null;
  arm: {
    arm: string;
    bucket: number;
    hash_input_sha256: string;
    salt_version: string;
    assigned_at: string;
    note: string;
  } | null;
  policy_evaluations: Array<{
    policy_version: string;
    gate_result: string;
    rules_trace: unknown;
    evaluated_at: string;
  }>;
  attempts: Array<{
    id: string;
    attempt_no: number;
    rail: string;
    chosen_by: string;
    rail_scores: unknown;
    scheduled_for: string | null;
    executed_at: string | null;
    razorpay_link_id: string | null;
    outcome: string | null;
    cost_paise: number;
  }>;
  messages: Array<{
    channel: string;
    body: string;
    llm_model: string | null;
    llm_prompt_hash: string | null;
    tokens_in: number | null;
    tokens_out: number | null;
    cost_paise: number;
    is_fallback: boolean;
    sent_at: string | null;
  }>;
  ledger: Array<{
    seq: number;
    ts: string;
    action: string;
    detail: unknown;
    hash: string;
    prev_hash: string;
  }>;
}

function Card({
  n,
  title,
  right,
  children,
}: {
  n: number;
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      className="rounded-[10px]"
      style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)' }}
    >
      <header
        className="flex items-center justify-between gap-2 px-3 py-2"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <h3 className="label">
          <span style={{ color: 'var(--text-muted)' }}>{n}.</span> {title}
        </h3>
        {right}
      </header>
      <div className="px-3 py-2.5">{children}</div>
    </section>
  );
}

function Row({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-3 py-0.5">
      <span className="label w-[120px] shrink-0">{k}</span>
      <span
        className={`min-w-0 flex-1 break-words ${mono ? 'mono' : 'text-[12.5px]'}`}
        style={{ color: 'var(--text-primary)' }}
      >
        {v ?? <span style={{ color: 'var(--text-muted)' }}>—</span>}
      </span>
    </div>
  );
}

function RuleChecklist({ trace }: { trace: unknown }) {
  const rules = Array.isArray(trace) ? (trace as RuleTrace[]) : [];
  if (rules.length === 0) return <p style={{ color: 'var(--text-muted)' }}>No rules recorded.</p>;
  return (
    <div className="flex flex-col gap-0.5">
      {rules.map((r, i) => (
        <div key={`${r.rule}-${i}`} className="flex items-baseline gap-2 text-[12px]">
          <span style={{ color: r.pass ? 'var(--success)' : 'var(--danger)' }} aria-hidden>
            {r.pass ? '✓' : '✗'}
          </span>
          <span className="w-[190px] shrink-0" style={{ color: 'var(--text-secondary)' }}>
            {r.rule}
          </span>
          {/* The values actually compared, not a summary of them. */}
          <span className="mono min-w-0 flex-1" style={{ color: 'var(--text-muted)' }}>
            expected {r.expected} · actual {r.actual}
          </span>
        </div>
      ))}
    </div>
  );
}

export function TraceDrawer({ eventId, onClose }: { eventId: string | null; onClose: () => void }) {
  const [trace, setTrace] = useState<Trace | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!eventId) return;
    setTrace(null);
    setError(null);
    const ac = new AbortController();
    fetch(`/api/events/${encodeURIComponent(eventId)}/trace`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setTrace)
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => ac.abort();
  }, [eventId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!eventId) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-40"
        style={{ background: 'rgba(4,8,16,0.6)' }}
        onClick={onClose}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Decision trace"
        className="fixed top-0 right-0 z-50 flex h-full w-full max-w-[620px] flex-col"
        style={{
          background: 'var(--bg-base)',
          borderLeft: '1px solid var(--border-strong)',
          boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
        }}
      >
        <header
          className="flex shrink-0 items-center justify-between gap-3 px-4 py-3"
          style={{ borderBottom: '1px solid var(--border-subtle)' }}
        >
          <div className="min-w-0">
            <div className="label">Decision trace</div>
            <div className="mono truncate" style={{ color: 'var(--text-primary)' }}>
              {eventId}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close trace"
            autoFocus
            className="cursor-pointer rounded-sm px-2 py-1 text-[12px]"
            style={{ border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' }}
          >
            Esc
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
          {error && (
            <p className="rounded-sm px-3 py-2" style={{ color: 'var(--danger)', background: 'rgba(240,85,79,0.1)' }}>
              Could not load trace: {error}
            </p>
          )}
          {!trace && !error && (
            <>
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="skeleton h-24 rounded-[10px]" />
              ))}
            </>
          )}

          {trace && (
            <>
              <Card
                n={1}
                title="Event"
                right={trace.event.is_synthetic ? <Badge tone="muted">Synthetic</Badge> : null}
              >
                <Row k="Amount" v={<span className="tnum">{rupees(trace.event.amount_paise)}</span>} />
                <Row k="Failed at" v={istDateTime(trace.event.failed_at)} />
                <Row
                  k="Instrument"
                  v={`${trace.event.issuer ?? '—'} · ${trace.event.method ?? '—'}${trace.event.card_network ? ` · ${trace.event.card_network}` : ''}`}
                />
                <Row k="Order" v={trace.event.order_id} mono />
                <Row k="Customer" v={trace.event.customer?.phone_masked ?? '—'} mono />
                {trace.event.customer?.opted_out_at && (
                  <Row
                    k="Opted out"
                    v={
                      <Badge tone="warn">
                        {trace.event.customer.opt_out_reason ?? 'opted out'}
                      </Badge>
                    }
                  />
                )}
                {/* Razorpay's structured taxonomy, raw. A normalised summary here
                    would hide exactly what the classifier had to work with. */}
                <div
                  className="mt-2 rounded-sm px-2 py-1.5"
                  style={{ background: 'var(--bg-surface-2)' }}
                >
                  {Object.entries(trace.event.error).map(([k, v]) => (
                    <div key={k} className="mono flex gap-2">
                      <span style={{ color: 'var(--text-muted)' }}>{k}</span>
                      <span style={{ color: 'var(--text-primary)' }}>{v ?? 'null'}</span>
                    </div>
                  ))}
                </div>
              </Card>

              <Card
                n={2}
                title="Classification"
                right={
                  trace.classification ? (
                    <Badge tone={trace.classification.kind === 'systemic' ? 'danger' : 'info'}>
                      {trace.classification.kind}
                    </Badge>
                  ) : null
                }
              >
                {trace.classification ? (
                  <>
                    <Row k="Failure class" v={trace.classification.failure_class} />
                    <Row
                      k="Confidence"
                      v={<span className="tnum">{(trace.classification.confidence * 100).toFixed(0)}%</span>}
                    />
                    <Row k="Cohort key" v={trace.classification.cohort_key} mono />
                    <Row
                      k="Cohort evidence"
                      v={
                        <span className="tnum">
                          n={trace.classification.cohort_n ?? '—'} · decline{' '}
                          {trace.classification.cohort_decline_rate === null
                            ? '—'
                            : `${(trace.classification.cohort_decline_rate * 100).toFixed(1)}%`}
                        </span>
                      }
                    />
                    <Row
                      k="Downtime API"
                      v={
                        trace.classification.downtime_api_agrees === true ? (
                          <Badge tone="ok">agreed</Badge>
                        ) : trace.classification.downtime_api_agrees === false ? (
                          <Badge tone="warn">disagreed</Badge>
                        ) : (
                          <Badge tone="muted" title="Recorded as corroboration, never an input">
                            no signal
                          </Badge>
                        )
                      }
                    />
                  </>
                ) : (
                  <p style={{ color: 'var(--text-muted)' }}>Not classified yet.</p>
                )}
              </Card>

              <Card
                n={3}
                title="Arm assignment"
                right={trace.arm ? <Badge tone="accent">{trace.arm.arm}</Badge> : null}
              >
                {trace.arm ? (
                  <>
                    <Row k="Bucket" v={<span className="tnum">{trace.arm.bucket} / 100</span>} />
                    <Row k="Salt version" v={trace.arm.salt_version} mono />
                    <Row k="Hash input" v={trace.arm.hash_input_sha256} mono />
                    <p className="mt-1.5 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                      {trace.arm.note}
                    </p>
                  </>
                ) : (
                  <p style={{ color: 'var(--text-muted)' }}>Not assigned yet.</p>
                )}
              </Card>

              <Card
                n={4}
                title="Policy gate"
                right={
                  trace.policy_evaluations.length > 0 ? (
                    <Badge
                      tone={
                        trace.policy_evaluations.at(-1)!.gate_result.startsWith('allow')
                          ? 'ok'
                          : trace.policy_evaluations.at(-1)!.gate_result.startsWith('defer')
                            ? 'warn'
                            : 'danger'
                      }
                    >
                      {trace.policy_evaluations.at(-1)!.gate_result}
                    </Badge>
                  ) : null
                }
              >
                {trace.policy_evaluations.length === 0 ? (
                  <p style={{ color: 'var(--text-muted)' }}>Gate has not run for this event.</p>
                ) : (
                  trace.policy_evaluations.map((e, i) => (
                    <div key={i} className={i > 0 ? 'mt-3' : ''}>
                      <Row k="Policy" v={`${e.policy_version} · ${istDateTime(e.evaluated_at)}`} />
                      <div className="mt-1.5">
                        <RuleChecklist trace={e.rules_trace} />
                      </div>
                    </div>
                  ))
                )}
              </Card>

              <Card n={5} title="Rail choice">
                {trace.attempts.length === 0 ? (
                  <p style={{ color: 'var(--text-muted)' }}>
                    No attempt — held out, blocked, or not yet planned.
                  </p>
                ) : (
                  trace.attempts.map((a) => (
                    <div key={a.id} className="mb-2">
                      <Row k={`Attempt ${a.attempt_no}`} v={`${a.rail} · chosen by ${a.chosen_by}`} />
                      <Row k="Scheduled" v={istDateTime(a.scheduled_for)} />
                      <Row k="Executed" v={istDateTime(a.executed_at)} />
                      <Row k="Outcome" v={a.outcome ?? 'pending'} />
                      <Row k="Cost" v={<span className="tnum">{rupees(a.cost_paise)}</span>} />
                      {a.razorpay_link_id && <Row k="Razorpay link" v={a.razorpay_link_id} mono />}
                      {a.rail_scores !== null && (
                        <pre
                          className="mono mt-1 overflow-x-auto rounded-sm px-2 py-1.5"
                          style={{ background: 'var(--bg-surface-2)', color: 'var(--text-secondary)' }}
                        >
                          {JSON.stringify(a.rail_scores, null, 2)}
                        </pre>
                      )}
                    </div>
                  ))
                )}
              </Card>

              <Card n={6} title="Message">
                {trace.messages.length === 0 ? (
                  <p style={{ color: 'var(--text-muted)' }}>Nothing sent.</p>
                ) : (
                  trace.messages.map((m, i) => (
                    <div key={i}>
                      <Row
                        k="Channel"
                        v={
                          <>
                            {m.channel}{' '}
                            {m.is_fallback && <Badge tone="warn">template fallback</Badge>}
                          </>
                        }
                      />
                      <Row k="Model" v={m.llm_model ?? '—'} />
                      <Row k="Prompt hash" v={m.llm_prompt_hash} mono />
                      <Row
                        k="Tokens"
                        v={
                          <span className="tnum">
                            {m.tokens_in ?? 0} in / {m.tokens_out ?? 0} out · {rupees(m.cost_paise)}
                          </span>
                        }
                      />
                      <pre
                        className="mono mt-1.5 whitespace-pre-wrap rounded-sm px-2 py-1.5"
                        style={{ background: 'var(--bg-surface-2)' }}
                      >
                        {m.body}
                      </pre>
                    </div>
                  ))
                )}
              </Card>

              <Card
                n={7}
                title="Outcome & receipts"
                right={
                  trace.event.recovered_at ? (
                    <Badge tone="ok">recovered {rupees(trace.event.recovered_paise)}</Badge>
                  ) : null
                }
              >
                <Row k="State" v={trace.event.state} />
                <Row k="Recovered at" v={istDateTime(trace.event.recovered_at)} />
                {trace.ledger.length === 0 ? (
                  <p className="mt-1" style={{ color: 'var(--text-muted)' }}>
                    No ledger records yet.
                  </p>
                ) : (
                  <div className="mt-2 flex flex-col gap-1">
                    {trace.ledger.map((l) => (
                      <div
                        key={l.seq}
                        className="rounded-sm px-2 py-1.5"
                        style={{ background: 'var(--bg-surface-2)' }}
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-[12.5px]" style={{ color: 'var(--text-primary)' }}>
                            <span className="tnum" style={{ color: 'var(--text-muted)' }}>
                              #{l.seq}
                            </span>{' '}
                            {l.action}
                          </span>
                          <span className="mono" style={{ color: 'var(--text-muted)' }}>
                            {istDateTime(l.ts)}
                          </span>
                        </div>
                        <div className="mono truncate" style={{ color: 'var(--text-muted)' }}>
                          hash {l.hash.slice(0, 16)}… ← prev {l.prev_hash.slice(0, 12)}…
                        </div>
                      </div>
                    ))}
                    <p className="mono mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      hash = sha256(prev_hash ‖ canonical_json(record))
                    </p>
                  </div>
                )}
              </Card>

              <div className="flex gap-2 pb-2">
                <button
                  onClick={() => navigator.clipboard?.writeText(JSON.stringify(trace, null, 2))}
                  className="cursor-pointer rounded-sm px-2.5 py-1 text-[12px]"
                  style={{ border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' }}
                >
                  Copy trace as JSON
                </button>
                <a
                  href={`/api/events/${encodeURIComponent(eventId)}/trace`}
                  target="_blank"
                  rel="noreferrer"
                  className="cursor-pointer rounded-sm px-2.5 py-1 text-[12px]"
                  style={{ border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' }}
                >
                  Open raw JSON
                </a>
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
