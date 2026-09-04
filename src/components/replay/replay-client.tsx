'use client';

/**
 * SCREEN 7 — Replay & What-If.
 *
 * Re-runs a historical corpus through the same pure functions the live pipeline
 * uses, under a different policy, different detector thresholds, or different
 * flags, and shows what would have changed.
 *
 * The screen's job is to keep two kinds of number apart. Decision, contact,
 * message and cost deltas are MEASURED — they follow from the gate alone and
 * are exact. Revenue is MODELLED, because whether a customer would still have
 * paid under a different policy is a counterfactual no corpus can answer. They
 * are rendered differently and labelled, because a confident rupee figure with
 * no such marking is the most persuasive way to be wrong here.
 */
import { useCallback, useEffect, useState } from 'react';
import { Badge, Panel, istDateTime, rupees } from '@/components/primitives';

interface Counts {
  events: number;
  systemic: number;
  allowed: number;
  deferred: number;
  blocked: number;
  contacted: number;
  messages: number;
  cost_paise: number;
}

interface ReplayResult {
  spec: {
    policy_version: string;
    thresholds: { minCohortN: number; sigmaMultiplier: number; absoluteFloor: number } | null;
    flags: { disable_llm: boolean; naive_rails: boolean; alt_salt?: string };
    seed: number;
  };
  baseline: Counts;
  replayed: Counts;
  measured_delta: Record<string, number>;
  modelled_revenue: {
    baseline_recovered_paise: number;
    replayed_recovered_paise: number;
    delta_paise: number;
    model: string;
    inputs: {
      control_recovery_rate: number;
      treated_recovery_rate: number;
      control_n: number;
      treated_n: number;
    };
  };
  changed_decisions: Array<{
    event_id: string;
    failed_at: string;
    amount_paise: number;
    issuer: string | null;
    method: string | null;
    changes: Array<{ kind: string; from: string; to: string; why: string }>;
  }>;
  changed_count: number;
  caveats: string[];
  events_per_second: number;
}

interface RunEnvelope {
  run: {
    id: string;
    corpus: string;
    policy_version: string;
    seed: number;
    events_count: number | null;
    started_at: string;
    finished_at: string | null;
    status: string;
    error: string | null;
  };
  result: ReplayResult | null;
}

const CORPORA = [
  { key: 'recent', label: 'Recent at-risk events' },
  { key: 'outage_window', label: 'Systemic only' },
  { key: 'adversarial', label: 'Unlabelled failures' },
] as const;

const inputStyle = {
  background: 'var(--bg-surface-2)',
  border: '1px solid var(--border-subtle)',
  color: 'var(--text-primary)',
};

function DiffRow({
  label,
  before,
  after,
  format = (n: number) => n.toLocaleString('en-IN'),
}: {
  label: string;
  before: number;
  after: number;
  format?: (n: number) => string;
}) {
  const d = after - before;
  return (
    <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
      <td className="px-2 py-1.5" style={{ color: 'var(--text-secondary)' }}>
        {label}
      </td>
      <td className="tnum px-2 py-1.5 text-right">{format(before)}</td>
      <td className="tnum px-2 py-1.5 text-right">{format(after)}</td>
      <td className="px-2 py-1.5 text-right">
        <span
          className="tnum"
          style={{ color: d === 0 ? 'var(--text-muted)' : d > 0 ? 'var(--success)' : 'var(--danger)' }}
        >
          {d > 0 ? '+' : ''}
          {format(d)}
        </span>
      </td>
    </tr>
  );
}

export function ReplayClient() {
  const [corpus, setCorpus] = useState<string>('recent');
  const [policyVersion, setPolicyVersion] = useState('live');
  const [policies, setPolicies] = useState<Array<{ version: string; status: string }>>([]);
  const [sizes, setSizes] = useState<Record<string, number>>({});
  const [limit, setLimit] = useState(3000);
  const [disableLlm, setDisableLlm] = useState(false);
  const [naiveRails, setNaiveRails] = useState(false);
  const [seed, setSeed] = useState(42);
  const [tuneThresholds, setTuneThresholds] = useState(false);
  const [minCohortN, setMinCohortN] = useState(8);
  const [floor, setFloor] = useState(0.35);
  const [operatorKey, setOperatorKey] = useState('');

  const [runId, setRunId] = useState<string | null>(null);
  const [envelope, setEnvelope] = useState<RunEnvelope | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const saved = sessionStorage.getItem('leakproof_operator_key');
    if (saved) setOperatorKey(saved);
    fetch('/api/replay')
      .then((r) => r.json())
      .then((d) => {
        setSizes(d.corpus_sizes ?? {});
        setPolicies(d.policies ?? []);
      })
      .catch(() => undefined);
  }, []);

  // Poll the run until it finishes. Replaying 3,000 events is a second or two
  // of compute; the wait is loading the corpus and its cohort counters.
  useEffect(() => {
    if (!runId) return;
    let alive = true;
    const t = setInterval(() => void tick(), 1500);
    async function tick() {
      const r = await fetch(`/api/replay/${runId}`).then((x) => x.json());
      if (!alive) return;
      setEnvelope(r);
      if (r.run.status !== 'running') {
        setBusy(false);
        clearInterval(t);
      }
    }
    void tick();
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [runId]);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    setEnvelope(null);
    sessionStorage.setItem('leakproof_operator_key', operatorKey);
    try {
      const res = await fetch('/api/replay', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorKey}` },
        body: JSON.stringify({
          corpus,
          policy_version: policyVersion,
          limit,
          flags: { disable_llm: disableLlm, naive_rails: naiveRails },
          ...(tuneThresholds
            ? { thresholds: { minCohortN, sigmaMultiplier: 3, absoluteFloor: floor } }
            : {}),
          seed,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      setRunId(body.run_id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }, [corpus, policyVersion, limit, disableLlm, naiveRails, tuneThresholds, minCohortN, floor, seed, operatorKey]);

  const result = envelope?.result ?? null;

  return (
    <div className="mx-auto flex min-h-screen max-w-[1600px] flex-col gap-2 p-3">
      <header className="flex flex-wrap items-center gap-3">
        <a href="/tower" className="text-[17px] font-semibold tracking-tight" style={{ color: 'var(--accent)' }}>
          ▣ LEAKPROOF
        </a>
        <span className="label" style={{ letterSpacing: '0.08em' }}>
          Replay &amp; what-if
        </span>
        {/*
          Blueprint's demo-critical detail: when the screen shows replayed
          rather than live data it must be unmistakable. The panel should never
          have to wonder whether a number is real.
        */}
        {result && (
          <span
            className="rounded-sm px-2 py-1 text-[12px] font-medium"
            style={{
              background: 'rgba(155,135,245,0.16)',
              color: 'var(--arm-naive)',
              border: '1px solid rgba(155,135,245,0.4)',
            }}
          >
            REPLAY MODE — policy {result.spec.policy_version} ·{' '}
            {envelope?.run.events_count?.toLocaleString('en-IN')} historical events · not live data
          </span>
        )}
        <a href="/tower" className="ml-auto text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
          ← Control tower
        </a>
      </header>

      <div className="grid grid-cols-1 gap-2 xl:grid-cols-[360px_1fr]">
        <Panel title="Replay configuration" bodyClassName="p-3 flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="label">Corpus</span>
            <select
              value={corpus}
              onChange={(e) => setCorpus(e.target.value)}
              className="rounded-sm px-2 py-1.5 text-[12.5px]"
              style={inputStyle}
            >
              {CORPORA.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label} ({(sizes[c.key] ?? 0).toLocaleString('en-IN')})
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="label">Policy version</span>
            <select
              value={policyVersion}
              onChange={(e) => setPolicyVersion(e.target.value)}
              className="rounded-sm px-2 py-1.5 text-[12.5px]"
              style={inputStyle}
            >
              <option value="live">live (whatever is published now)</option>
              {policies.map((p) => (
                <option key={p.version} value={p.version}>
                  {p.version} · {p.status}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="label">Corpus size</span>
            <input
              type="number"
              value={limit}
              min={1}
              max={20000}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="tnum rounded-sm px-2 py-1.5 text-[12.5px]"
              style={inputStyle}
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="label">Flags</span>
            <label className="flex items-center gap-2 text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={disableLlm} onChange={(e) => setDisableLlm(e.target.checked)} />
              Disable the LLM entirely (template fallback)
            </label>
            <label className="flex items-center gap-2 text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={naiveRails} onChange={(e) => setNaiveRails(e.target.checked)} />
              Force naive rails (prices the routing table)
            </label>
            <label className="flex items-center gap-2 text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
              <input
                type="checkbox"
                checked={tuneThresholds}
                onChange={(e) => setTuneThresholds(e.target.checked)}
              />
              Override detector thresholds
            </label>
            {tuneThresholds && (
              <div className="flex gap-2 pl-6">
                <label className="flex flex-1 flex-col gap-1">
                  <span className="label">min cohort n</span>
                  <input
                    type="number"
                    value={minCohortN}
                    onChange={(e) => setMinCohortN(Number(e.target.value))}
                    className="tnum rounded-sm px-2 py-1 text-[12.5px]"
                    style={inputStyle}
                  />
                </label>
                <label className="flex flex-1 flex-col gap-1">
                  <span className="label">absolute floor</span>
                  <input
                    type="number"
                    step="0.05"
                    value={floor}
                    onChange={(e) => setFloor(Number(e.target.value))}
                    className="tnum rounded-sm px-2 py-1 text-[12.5px]"
                    style={inputStyle}
                  />
                </label>
              </div>
            )}
          </div>

          <label className="flex flex-col gap-1">
            <span className="label">Seed</span>
            <input
              type="number"
              value={seed}
              onChange={(e) => setSeed(Number(e.target.value))}
              className="tnum rounded-sm px-2 py-1.5 text-[12.5px]"
              style={inputStyle}
            />
          </label>

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
            onClick={run}
            disabled={busy || !operatorKey}
            className="cursor-pointer rounded-sm px-3 py-2 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-40"
            style={{
              background: 'var(--accent-dim)',
              border: '1px solid rgba(20,184,166,0.4)',
              color: 'var(--accent)',
            }}
          >
            {busy ? 'Replaying…' : 'Run replay'}
          </button>

          {error && (
            <p className="text-[12px]" style={{ color: 'var(--danger)' }}>
              {error}
            </p>
          )}
          {envelope?.run.error && (
            <p className="text-[12px]" style={{ color: 'var(--danger)' }}>
              {envelope.run.error}
            </p>
          )}
        </Panel>

        <div className="flex flex-col gap-2">
          {!result && !busy && (
            <Panel bodyClassName="p-6">
              <p style={{ color: 'var(--text-secondary)' }}>
                Pick a corpus and a policy, then run. The engine calls the same{' '}
                <code className="mono">classify</code>, <code className="mono">evaluatePolicy</code>{' '}
                and <code className="mono">chooseRail</code> the live pipeline uses — not a second
                implementation — so the difference it reports is a difference in the policy, not in
                the code.
              </p>
            </Panel>
          )}
          {busy && !result && (
            <Panel bodyClassName="p-6">
              <div className="skeleton h-6 w-1/2 rounded-sm" />
            </Panel>
          )}

          {result && (
            <>
              <Panel
                title="Measured — exact, follows from the decision alone"
                right={
                  <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                    {result.events_per_second.toLocaleString('en-IN')} events/sec
                  </span>
                }
                bodyClassName="p-0"
              >
                <table className="w-full border-collapse text-[12.5px]">
                  <thead style={{ background: 'var(--bg-surface-2)' }}>
                    <tr>
                      <th scope="col" className="label px-2 py-1.5 text-left">Metric</th>
                      <th scope="col" className="label px-2 py-1.5 text-right">As it happened</th>
                      <th scope="col" className="label px-2 py-1.5 text-right">Replayed</th>
                      <th scope="col" className="label px-2 py-1.5 text-right">Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    <DiffRow label="Events" before={result.baseline.events} after={result.replayed.events} />
                    <DiffRow label="Called systemic" before={result.baseline.systemic} after={result.replayed.systemic} />
                    <DiffRow label="Gate allowed" before={result.baseline.allowed} after={result.replayed.allowed} />
                    <DiffRow label="Gate deferred" before={result.baseline.deferred} after={result.replayed.deferred} />
                    <DiffRow label="Gate blocked" before={result.baseline.blocked} after={result.replayed.blocked} />
                    <DiffRow label="Customers contacted" before={result.baseline.contacted} after={result.replayed.contacted} />
                    <DiffRow label="Messages sent" before={result.baseline.messages} after={result.replayed.messages} />
                    <DiffRow
                      label="Spend"
                      before={result.baseline.cost_paise}
                      after={result.replayed.cost_paise}
                      format={(n) => rupees(n)}
                    />
                  </tbody>
                </table>
              </Panel>

              <Panel
                title="Modelled — requires an assumption about customer behaviour"
                bodyClassName="p-3 flex flex-col gap-2"
              >
                <div className="flex flex-wrap items-baseline gap-6">
                  <div>
                    <div className="label">Recovered, as it happened</div>
                    <div className="tnum text-[20px] font-semibold">
                      {rupees(result.modelled_revenue.baseline_recovered_paise)}
                    </div>
                  </div>
                  <div>
                    <div className="label">Modelled under this policy</div>
                    <div className="tnum text-[20px] font-semibold" style={{ color: 'var(--arm-naive)' }}>
                      {rupees(result.modelled_revenue.replayed_recovered_paise)}
                    </div>
                  </div>
                  <div>
                    <div className="label">Δ (modelled)</div>
                    <div
                      className="tnum text-[20px] font-semibold"
                      style={{
                        color:
                          result.modelled_revenue.delta_paise === 0
                            ? 'var(--text-muted)'
                            : result.modelled_revenue.delta_paise > 0
                              ? 'var(--success)'
                              : 'var(--danger)',
                      }}
                    >
                      {result.modelled_revenue.delta_paise > 0 ? '+' : ''}
                      {rupees(result.modelled_revenue.delta_paise)}
                    </div>
                  </div>
                </div>
                <p className="text-[12px] leading-[17px]" style={{ color: 'var(--warning)' }}>
                  {result.modelled_revenue.model}
                </p>
                <p className="mono" style={{ color: 'var(--text-muted)' }}>
                  control {(result.modelled_revenue.inputs.control_recovery_rate * 100).toFixed(2)}% (n=
                  {result.modelled_revenue.inputs.control_n}) · treated{' '}
                  {(result.modelled_revenue.inputs.treated_recovery_rate * 100).toFixed(2)}% (n=
                  {result.modelled_revenue.inputs.treated_n})
                </p>
              </Panel>

              <Panel title="Read this with the numbers" bodyClassName="p-3 flex flex-col gap-1.5">
                {result.caveats.map((c, i) => (
                  <p key={i} className="text-[12px] leading-[17px]" style={{ color: 'var(--text-secondary)' }}>
                    <span style={{ color: 'var(--warning)' }}>▸</span> {c}
                  </p>
                ))}
              </Panel>

              <Panel
                title={`Decisions that changed · ${result.changed_count.toLocaleString('en-IN')}`}
                right={
                  result.changed_decisions.length < result.changed_count ? (
                    <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                      showing first {result.changed_decisions.length}
                    </span>
                  ) : null
                }
                bodyClassName="p-0"
              >
                {result.changed_decisions.length === 0 ? (
                  <p className="px-3 py-6 text-center" style={{ color: 'var(--text-secondary)' }}>
                    Not one decision changed. Under this configuration the system would have done
                    exactly what it did.
                  </p>
                ) : (
                  <div className="max-h-[420px] overflow-auto">
                    <table className="w-full border-collapse text-[12.5px]">
                      <tbody>
                        {result.changed_decisions.map((d) => (
                          <tr key={d.event_id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                            <td className="px-2 py-1.5 align-top whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                              {istDateTime(d.failed_at)}
                            </td>
                            <td className="tnum px-2 py-1.5 text-right align-top whitespace-nowrap">
                              {rupees(d.amount_paise)}
                            </td>
                            <td className="px-2 py-1.5 align-top whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
                              {d.issuer ?? '—'}/{d.method ?? '—'}
                            </td>
                            <td className="px-2 py-1.5">
                              {d.changes.map((c, i) => (
                                <div key={i} className="flex flex-wrap items-baseline gap-1.5">
                                  <Badge tone="muted">{c.kind}</Badge>
                                  <span className="mono" style={{ color: 'var(--danger)' }}>
                                    {c.from}
                                  </span>
                                  <span style={{ color: 'var(--text-muted)' }}>→</span>
                                  <span className="mono" style={{ color: 'var(--success)' }}>
                                    {c.to}
                                  </span>
                                  <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                                    {c.why}
                                  </span>
                                </div>
                              ))}
                            </td>
                            <td className="px-2 py-1.5 align-top">
                              <a
                                href={`/tower?event=${encodeURIComponent(d.event_id)}`}
                                className="mono"
                                style={{ color: 'var(--accent)' }}
                              >
                                trace →
                              </a>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
