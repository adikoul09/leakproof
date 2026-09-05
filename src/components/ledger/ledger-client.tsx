'use client';

/**
 * SCREEN 6 — the Audit Ledger.
 *
 * Every decision the pipeline made, in order, hash-chained. The screen's only
 * real job is to stop the chain being decorative.
 *
 * A green "INTACT" badge that the server hands down proves nothing: it is the
 * same server that would be serving a tampered row. So expanding a row
 * recomputes its hash **in the reader's own browser**, from the row's own
 * fields, using `canonicalString` — the exact module the server hashes with,
 * not a second implementation of the same rules. If the two disagree, the row
 * says so in red. A judge can therefore check the claim without trusting
 * anything on this page except their own machine's SHA-256.
 */
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArmChip, Badge, ConsoleNav, Panel, istDateTime, rupees } from '@/components/primitives';
import { canonicalString } from '@/core/ledger/canonical';

interface LedgerRow {
  seq: number;
  ts: string;
  event_id: string | null;
  failure_class: string | null;
  policy_version: string | null;
  gate_result: string | null;
  arm: string | null;
  llm_prompt_hash: string | null;
  action: string;
  outcome: string | null;
  cost_paise: number;
  actor: string;
  detail: Record<string, unknown> | null;
  prev_hash: string;
  hash: string;
}

interface VerifyResult {
  intact: boolean;
  records: number;
  genesis_hash: string | null;
  head_hash: string | null;
  verified_in_ms: number;
  broken_at_seq?: number;
  break?: { seq: number; kind: string; expected: string; actual: string; explanation: string };
}

const GENESIS_PREV_HASH = '0'.repeat(64);

/**
 * The bytes the server hashed, rebuilt from the row.
 *
 * Key order is irrelevant — `canonicalString` sorts at every depth — but the
 * *field set* is not: a field the server hashed and this omits would make every
 * row fail, and a field this adds would do the same. It mirrors `hashedPayload`
 * in `core/ledger/append.ts` exactly, which is why `llm_prompt_hash` is in the
 * API response despite never being rendered.
 */
function hashedPayload(r: LedgerRow) {
  return {
    ts: r.ts,
    event_id: r.event_id,
    failure_class: r.failure_class,
    policy_version: r.policy_version,
    gate_result: r.gate_result,
    arm: r.arm,
    llm_prompt_hash: r.llm_prompt_hash,
    action: r.action,
    outcome: r.outcome,
    cost_paise: r.cost_paise,
    actor: r.actor,
    detail: r.detail,
  };
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const short = (h: string | null) => (h ? `${h.slice(0, 8)}…${h.slice(-6)}` : '—');

const inputStyle = {
  background: 'var(--bg-surface-2)',
  border: '1px solid var(--border-subtle)',
  color: 'var(--text-primary)',
};

const ACTION_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'info' | 'accent' | 'muted'> = {
  classified: 'info',
  arm_assigned: 'muted',
  held_out_control: 'muted',
  deferred: 'warn',
  blocked_by_policy: 'warn',
  action_sent: 'accent',
  recovered: 'ok',
  breaker_opened: 'danger',
  operator_override: 'danger',
};

export function LedgerClient({
  initialSeq,
  initialEventId,
}: {
  /** `?seq=` opens that record's detail — a linkable receipt for one decision. */
  initialSeq: number | null;
  /** `?event=` filters the chain to one payment, which survives pagination. */
  initialEventId: string | null;
}) {
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [verifying, setVerifying] = useState(true);
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(initialSeq);
  const [error, setError] = useState<string | null>(null);

  const [arm, setArm] = useState('');
  const [action, setAction] = useState('');
  const [eventId, setEventId] = useState(initialEventId ?? '');

  const runVerify = useCallback(async () => {
    setVerifying(true);
    try {
      const res = await fetch('/api/ledger/verify');
      setVerify(await res.json());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setVerifying(false);
    }
  }, []);

  const query = useCallback(
    (c: number | null) => {
      const p = new URLSearchParams({ limit: '50' });
      if (arm) p.set('arm', arm);
      if (action) p.set('action', action);
      if (eventId) p.set('event_id', eventId);
      if (c !== null) p.set('cursor', String(c));
      return `/api/ledger?${p}`;
    },
    [arm, action, eventId],
  );

  const loadFirst = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(query(null));
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      setRows(body.items);
      setCursor(body.next_cursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [query]);

  const loadMore = useCallback(async () => {
    if (cursor === null) return;
    const res = await fetch(query(cursor));
    const body = await res.json();
    setRows((prev) => [...prev, ...body.items]);
    setCursor(body.next_cursor);
  }, [cursor, query]);

  useEffect(() => {
    void runVerify();
  }, [runVerify]);
  useEffect(() => {
    void loadFirst();
  }, [loadFirst]);

  // Populates the filter datalists from what is actually in the chain, so the
  // suggestions cannot go stale against a new action name.
  const actions = [...new Set(rows.map((r) => r.action))].sort();

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
        <ConsoleNav active="ledger" />
        <a
          href="/api/ledger/export.csv"
          className="ml-auto rounded-[6px] px-2.5 py-1 text-[12.5px]"
          style={{ color: 'var(--accent)', border: '1px solid rgba(20,184,166,0.3)' }}
        >
          Export CSV ↓
        </a>
      </header>

      <ChainHeader verify={verify} verifying={verifying} onVerify={() => void runVerify()} />

      <Panel
        title="Filters"
        right={
          <button
            onClick={() => {
              setArm('');
              setAction('');
              setEventId('');
            }}
            className="cursor-pointer text-[11.5px]"
            style={{ color: 'var(--text-muted)' }}
          >
            clear
          </button>
        }
        bodyClassName="p-3 flex flex-wrap items-end gap-3"
      >
        <label className="flex flex-col gap-1">
          <span className="label">Arm</span>
          <select
            value={arm}
            onChange={(e) => setArm(e.target.value)}
            className="rounded-sm px-2 py-1 text-[12.5px]"
            style={inputStyle}
          >
            <option value="">any</option>
            <option value="control">control</option>
            <option value="naive">naive</option>
            <option value="leakproof">leakproof</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="label">Action</span>
          <input
            list="ledger-actions"
            value={action}
            onChange={(e) => setAction(e.target.value)}
            placeholder="any"
            className="mono rounded-sm px-2 py-1"
            style={inputStyle}
          />
          <datalist id="ledger-actions">
            {actions.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </label>
        <label className="flex flex-col gap-1">
          <span className="label">Event id</span>
          <input
            value={eventId}
            onChange={(e) => setEventId(e.target.value)}
            placeholder="pay_…"
            className="mono rounded-sm px-2 py-1"
            style={{ ...inputStyle, minWidth: 200 }}
          />
        </label>
        <span className="ml-auto text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
          {rows.length.toLocaleString('en-IN')} row{rows.length === 1 ? '' : 's'} loaded
          {cursor !== null ? ', more available' : ''}
        </span>
      </Panel>

      {error && (
        <p className="px-1 text-[12px]" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}

      <Panel
        title="Records — newest first"
        right={
          <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
            click a row to recompute its hash here in your browser
          </span>
        }
        bodyClassName="p-0"
      >
        {loading ? (
          <div className="flex flex-col gap-1 p-3">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="skeleton h-6 rounded-sm" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="px-3 py-8 text-center" style={{ color: 'var(--text-secondary)' }}>
            No records match these filters.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[12.5px]">
              <thead style={{ background: 'var(--bg-surface-2)' }}>
                <tr>
                  <th scope="col" className="label px-2 py-1.5 text-right">Seq</th>
                  <th scope="col" className="label px-2 py-1.5 text-left">Time (IST)</th>
                  <th scope="col" className="label px-2 py-1.5 text-left">Action</th>
                  <th scope="col" className="label px-2 py-1.5 text-left">Event</th>
                  <th scope="col" className="label px-2 py-1.5 text-left">Arm</th>
                  <th scope="col" className="label px-2 py-1.5 text-left">Gate</th>
                  <th scope="col" className="label px-2 py-1.5 text-left">Outcome</th>
                  <th scope="col" className="label px-2 py-1.5 text-right">Cost</th>
                  <th scope="col" className="label px-2 py-1.5 text-left">Actor</th>
                  <th scope="col" className="label px-2 py-1.5 text-left">Hash</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <RowPair
                    key={r.seq}
                    row={r}
                    open={expanded === r.seq}
                    onToggle={() => {
                      const next = expanded === r.seq ? null : r.seq;
                      setExpanded(next);
                      syncUrl(next, eventId);
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {cursor !== null && !loading && (
          <div className="p-2">
            <button
              onClick={() => void loadMore()}
              className="w-full cursor-pointer rounded-sm py-1.5 text-[12.5px]"
              style={{ background: 'var(--bg-surface-2)', color: 'var(--text-secondary)' }}
            >
              Load 50 more
            </button>
          </div>
        )}
      </Panel>
    </div>
  );
}

/** Mirrors the tower: `history.replaceState`, so a receipt stays shareable. */
function syncUrl(seq: number | null, eventId: string) {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (seq === null) url.searchParams.delete('seq');
  else url.searchParams.set('seq', String(seq));
  if (eventId) url.searchParams.set('event', eventId);
  else url.searchParams.delete('event');
  window.history.replaceState(null, '', url.toString());
}

function ChainHeader({
  verify,
  verifying,
  onVerify,
}: {
  verify: VerifyResult | null;
  verifying: boolean;
  onVerify: () => void;
}) {
  const broken = verify !== null && !verify.intact;
  return (
    <div
      className="flex flex-col gap-2 rounded-[10px] px-3 py-2.5"
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-subtle)',
        borderLeft: `3px solid ${broken ? 'var(--danger)' : verify ? 'var(--success)' : 'var(--border-subtle)'}`,
      }}
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex items-center gap-2">
          {verifying || !verify ? (
            <Badge tone="muted">Verifying…</Badge>
          ) : verify.intact ? (
            <Badge tone="ok">Chain intact</Badge>
          ) : (
            <Badge tone="danger">Chain broken</Badge>
          )}
          <span className="tnum text-[15px] font-semibold">
            {verify ? verify.records.toLocaleString('en-IN') : '—'}
          </span>
          <span className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
            records
          </span>
        </div>
        <div className="flex flex-col">
          <span className="label">Genesis</span>
          <span className="mono" title={verify?.genesis_hash ?? undefined} style={{ color: 'var(--text-secondary)' }}>
            {short(verify?.genesis_hash ?? null)}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="label">Head</span>
          <span className="mono" title={verify?.head_hash ?? undefined} style={{ color: 'var(--text-secondary)' }}>
            {short(verify?.head_hash ?? null)}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="label">Recomputed in</span>
          <span className="mono tnum" style={{ color: 'var(--text-secondary)' }}>
            {verify ? `${verify.verified_in_ms.toLocaleString('en-IN')} ms` : '—'}
          </span>
        </div>
        <button
          onClick={onVerify}
          disabled={verifying}
          className="ml-auto cursor-pointer rounded-sm px-3 py-1.5 text-[12.5px] font-medium disabled:cursor-not-allowed disabled:opacity-40"
          style={{
            background: 'var(--accent-dim)',
            border: '1px solid rgba(20,184,166,0.4)',
            color: 'var(--accent)',
          }}
        >
          {verifying ? 'Recomputing…' : 'Re-verify whole chain'}
        </button>
      </div>

      {verify?.break && (
        <p className="text-[12px] leading-[17px]" style={{ color: 'var(--danger)' }}>
          ▸ seq {verify.break.seq} · {verify.break.kind} — {verify.break.explanation} Expected{' '}
          <span className="mono">{short(verify.break.expected)}</span>, found{' '}
          <span className="mono">{short(verify.break.actual)}</span>.
        </p>
      )}

      <p className="mono" style={{ color: 'var(--text-muted)' }}>
        hash = sha256(prev_hash ‖ canonical(record)) · genesis prev_hash = 64 zeroes · keys sorted at
        every depth, array order preserved
      </p>
    </div>
  );
}

function RowPair({ row, open, onToggle }: { row: LedgerRow; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer transition-colors duration-200 hover:bg-[var(--bg-hover)]"
        style={{
          borderBottom: `1px solid var(--border-subtle)`,
          background: open ? 'var(--bg-surface-2)' : undefined,
        }}
      >
        <td className="tnum px-2 py-1.5 text-right" style={{ color: 'var(--text-muted)' }}>
          {row.seq}
        </td>
        <td className="px-2 py-1.5 whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
          {istDateTime(row.ts)}
        </td>
        <td className="px-2 py-1.5">
          <Badge tone={ACTION_TONE[row.action] ?? 'muted'}>{row.action.replace(/_/g, ' ')}</Badge>
        </td>
        <td className="mono px-2 py-1.5">
          {row.event_id ? (
            <a
              href={`/tower?event=${encodeURIComponent(row.event_id)}`}
              onClick={(e) => e.stopPropagation()}
              style={{ color: 'var(--accent)' }}
            >
              {row.event_id}
            </a>
          ) : (
            <span style={{ color: 'var(--text-muted)' }}>—</span>
          )}
        </td>
        <td className="px-2 py-1.5 whitespace-nowrap">
          <ArmChip arm={row.arm} />
        </td>
        <td className="px-2 py-1.5" style={{ color: 'var(--text-secondary)' }}>
          {row.gate_result ?? '—'}
        </td>
        <td className="px-2 py-1.5" style={{ color: 'var(--text-secondary)' }}>
          {row.outcome ?? '—'}
        </td>
        <td className="tnum px-2 py-1.5 text-right" style={{ color: 'var(--text-muted)' }}>
          {row.cost_paise === 0 ? '₹0' : rupees(row.cost_paise)}
        </td>
        <td className="px-2 py-1.5" style={{ color: 'var(--text-muted)' }}>
          {row.actor}
        </td>
        <td className="mono px-2 py-1.5" style={{ color: 'var(--text-muted)' }} title={row.hash}>
          {short(row.hash)}
        </td>
      </tr>
      {open && (
        <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <td colSpan={10} className="p-0">
            <RowDetail row={row} />
          </td>
        </tr>
      )}
    </>
  );
}

function RowDetail({ row }: { row: LedgerRow }) {
  const [check, setCheck] = useState<{ computed: string; ok: boolean } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const payload = hashedPayload(row);
  const canonical = canonicalString(payload);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    (async () => {
      try {
        const computed = await sha256Hex(row.prev_hash + canonical);
        if (alive.current) setCheck({ computed, ok: computed === row.hash });
      } catch (e) {
        // Web Crypto needs a secure context. Say so rather than showing a
        // silent nothing where a verification result should be.
        if (alive.current) setFailed((e as Error).message);
      }
    })();
    return () => {
      alive.current = false;
    };
  }, [row.prev_hash, row.hash, canonical]);

  return (
    <div className="flex flex-col gap-2 px-3 py-2.5" style={{ background: 'var(--bg-base)' }}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="label">Verified in your browser</span>
        {failed ? (
          <Badge tone="warn" title={failed}>
            Web Crypto unavailable
          </Badge>
        ) : check === null ? (
          <Badge tone="muted">Computing…</Badge>
        ) : check.ok ? (
          <Badge tone="ok">SHA-256 matches</Badge>
        ) : (
          <Badge tone="danger">SHA-256 does not match</Badge>
        )}
        {check && !check.ok && (
          <span className="mono" style={{ color: 'var(--danger)' }}>
            computed {short(check.computed)}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-x-6 gap-y-1 lg:grid-cols-[auto_1fr]">
        <span className="label self-center">prev_hash</span>
        <span
          className="mono break-all"
          style={{ color: row.prev_hash === GENESIS_PREV_HASH ? 'var(--text-muted)' : 'var(--text-secondary)' }}
        >
          {row.prev_hash}
          {row.prev_hash === GENESIS_PREV_HASH && ' (genesis)'}
        </span>

        <span className="label self-center">canonical(record)</span>
        <span
          className="mono max-h-40 overflow-auto rounded-sm px-2 py-1 break-all"
          style={{ background: 'var(--bg-surface)', color: 'var(--text-secondary)' }}
        >
          {canonical}
        </span>

        <span className="label self-center">hash</span>
        <span
          className="mono break-all"
          style={{ color: check?.ok === false ? 'var(--danger)' : 'var(--success)' }}
        >
          {row.hash}
        </span>
      </div>

      <p className="text-[11.5px] leading-[16px]" style={{ color: 'var(--text-muted)' }}>
        ▸ These bytes were rebuilt from the row above and hashed by{' '}
        <code className="mono">crypto.subtle</code> on your machine — the server was not asked
        whether it matches. The serialisation is the same module the pipeline hashes with, so a
        record edited in the database at any depth, <code className="mono">detail</code> included,
        changes this digest and every one after it.
      </p>
    </div>
  );
}
