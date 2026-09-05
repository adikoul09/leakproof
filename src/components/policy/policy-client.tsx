'use client';

/**
 * SCREEN 4 — the Policy Studio.
 *
 * The gate is the part of this system that says no, and a gate nobody can read
 * is indistinguishable from no gate at all. This screen exists so the rules can
 * be read in the form they are actually evaluated in — the stored YAML, not a
 * rendering of it — and so a change to them leaves a receipt.
 *
 * Two things it deliberately does not do. It does not let a draft be edited
 * into the live version in place: publishing is a separate, explicit act on a
 * validated draft, because the alternative is a policy that changes while the
 * pipeline is halfway through evaluating it. And it does not hide the
 * validation errors behind a summary — the API returns the failing path, and
 * the failing path is what an operator needs.
 */
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Badge, ConsoleNav, Panel, istDateTime } from '@/components/primitives';

interface PolicyListItem {
  version: string;
  status: string;
  author: string | null;
  publishedAt: string | null;
  createdAt: string;
}

interface PolicyDetail {
  version: string;
  yaml_source: string;
  parsed: Record<string, unknown> | null;
  status: string;
  published_at: string | null;
  author: string | null;
}

interface ApiIssue {
  path: string;
  message: string;
}

const STATUS_TONE: Record<string, 'ok' | 'info' | 'muted'> = {
  live: 'ok',
  draft: 'info',
  archived: 'muted',
};

const inputStyle = {
  background: 'var(--bg-surface-2)',
  border: '1px solid var(--border-subtle)',
  color: 'var(--text-primary)',
};

const actionButton =
  'cursor-pointer rounded-sm px-3 py-1.5 text-[12.5px] font-medium transition-colors duration-200 hover:bg-[rgba(20,184,166,0.2)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-[var(--accent-dim)]';

const actionStyle = {
  background: 'var(--accent-dim)',
  border: '1px solid rgba(20,184,166,0.4)',
  color: 'var(--accent)',
};

export function PolicyClient({ initialVersion }: { initialVersion: string | null }) {
  const [items, setItems] = useState<PolicyListItem[] | null>(null);
  const [selected, setSelected] = useState<string | null>(initialVersion);
  const [detail, setDetail] = useState<PolicyDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [operatorKey, setOperatorKey] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<null | 'draft' | 'publish'>(null);
  const [issues, setIssues] = useState<ApiIssue[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    try {
      const res = await fetch('/api/policies');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const list = (body.items ?? []) as PolicyListItem[];
      setItems(list);
      setListError(null);
      // Default to whatever is live — that is the one the pipeline is using,
      // and the one a reader almost always means.
      setSelected((cur) => cur ?? list.find((i) => i.status === 'live')?.version ?? list[0]?.version ?? null);
    } catch (e) {
      setListError((e as Error).message);
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (!selected) return;
    let alive = true;
    setDetailLoading(true);
    fetch(`/api/policies/${encodeURIComponent(selected)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: PolicyDetail) => {
        if (!alive) return;
        setDetail(d);
        setDraft(d.yaml_source);
      })
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setDetailLoading(false));
    return () => {
      alive = false;
    };
  }, [selected]);

  const select = useCallback((version: string) => {
    setSelected(version);
    setIssues(null);
    setNotice(null);
    setError(null);
    window.history.replaceState(null, '', `/policy?version=${encodeURIComponent(version)}`);
  }, []);

  const saveDraft = useCallback(async () => {
    setBusy('draft');
    setIssues(null);
    setNotice(null);
    setError(null);
    try {
      const res = await fetch('/api/policies', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorKey}` },
        body: JSON.stringify({ yaml_source: draft }),
      });
      const body = await res.json();
      if (!res.ok) {
        // The API hands back the failing path; showing only the message would
        // throw away the half an operator actually needs to fix it.
        setIssues(Array.isArray(body?.error?.detail) ? body.error.detail : null);
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      setNotice(`Draft ${body.version} validated and stored. It is not live until published.`);
      await loadList();
      setSelected(body.version);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [draft, operatorKey, loadList]);

  const publish = useCallback(async () => {
    if (!detail) return;
    setBusy('publish');
    setIssues(null);
    setNotice(null);
    setError(null);
    try {
      const res = await fetch(`/api/policies/${encodeURIComponent(detail.version)}/publish`, {
        method: 'POST',
        headers: { authorization: `Bearer ${operatorKey}` },
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      setNotice(`${detail.version} is live. The previous live version was archived in the same transaction.`);
      await loadList();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [detail, operatorKey, loadList]);

  const dirty = detail !== null && draft !== detail.yaml_source;

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
        <ConsoleNav active="policy" />
        <span className="ml-auto text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
          {items === null ? 'Loading versions…' : `${items.length} version${items.length === 1 ? '' : 's'}`}
        </span>
      </header>

      {/*
        The three columns take the height the viewport leaves them rather than
        the height their content happens to need. On a 1440px screen the
        content-sized version ended two thirds of the way down and left a
        stripe of page background under it, which reads as a screen that
        stopped loading rather than as a console.
      */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 xl:grid-cols-[260px_1fr_360px]">
        <Panel title="Versions" bodyClassName="p-0 overflow-y-auto">
          {items === null ? (
            <div className="flex flex-col gap-1 p-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="skeleton h-9 rounded-sm" style={{ opacity: 0.5 }} />
              ))}
            </div>
          ) : listError ? (
            <p className="px-3 py-6 text-center text-[12.5px]" style={{ color: 'var(--danger)' }}>
              Could not load versions — {listError}
            </p>
          ) : items.length === 0 ? (
            <p className="px-3 py-6 text-center text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
              No policies stored. Seed one with <span className="mono">npm run db:seed</span>.
            </p>
          ) : (
            <ul className="flex flex-col">
              {items.map((it) => {
                const on = it.version === selected;
                return (
                  <li key={it.version}>
                    <button
                      onClick={() => select(it.version)}
                      className="flex w-full cursor-pointer flex-col gap-1 px-3 py-2 text-left transition-colors duration-150 hover:bg-[var(--bg-surface-2)]"
                      style={{
                        borderBottom: '1px solid var(--border-subtle)',
                        borderLeft: `2px solid ${on ? 'var(--accent)' : 'transparent'}`,
                        background: on ? 'var(--bg-hover)' : undefined,
                      }}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="mono" style={{ color: 'var(--text-primary)' }}>
                          {it.version}
                        </span>
                        <Badge tone={STATUS_TONE[it.status] ?? 'muted'}>{it.status}</Badge>
                      </span>
                      <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        {it.status === 'live' && it.publishedAt
                          ? `published ${istDateTime(it.publishedAt)}`
                          : `created ${istDateTime(it.createdAt)}`}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel
          title={detail ? `Source · ${detail.version}` : 'Source'}
          right={
            detail ? (
              <span className="flex items-center gap-2">
                {dirty && <Badge tone="warn">edited, not saved</Badge>}
                <Badge tone={STATUS_TONE[detail.status] ?? 'muted'}>{detail.status}</Badge>
              </span>
            ) : null
          }
          bodyClassName="p-3 flex flex-col gap-2 min-h-0"
        >
          {detailLoading && !detail ? (
            <div className="skeleton flex-1 rounded-sm" style={{ minHeight: 320 }} />
          ) : (
            <>
              {/*
                A plain textarea, not an embedded editor. Monaco is ~2MB for
                syntax colour on a file that is forty lines of YAML, and the
                thing that actually catches mistakes here is the server-side
                schema — which runs on save and reports the failing path.
              */}
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                aria-label="Policy YAML source"
                className="mono w-full flex-1 resize-y rounded-sm px-3 py-2"
                style={{ ...inputStyle, minHeight: 320, lineHeight: '20px' }}
              />
              <p className="text-[11.5px] leading-[16px]" style={{ color: 'var(--text-muted)' }}>
                ▸ Saving validates against the policy schema and stores a new{' '}
                <strong style={{ color: 'var(--text-secondary)' }}>draft</strong> — the version comes
                from the YAML itself, and nothing changes for the pipeline until you publish it.
              </p>
            </>
          )}
        </Panel>

        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
          <Panel title="Operator actions" bodyClassName="p-3 flex flex-col gap-2.5">
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
              onClick={() => void saveDraft()}
              disabled={busy !== null || !operatorKey || !dirty}
              className={actionButton}
              style={actionStyle}
            >
              {busy === 'draft' ? 'Validating…' : 'Validate & save as draft'}
            </button>

            <button
              onClick={() => void publish()}
              disabled={busy !== null || !operatorKey || detail === null || detail.status === 'live'}
              className={actionButton}
              style={actionStyle}
            >
              {busy === 'publish'
                ? 'Publishing…'
                : detail?.status === 'live'
                  ? 'Already live'
                  : `Publish ${detail?.version ?? ''}`}
            </button>

            {/* Same rule as Replay: a disabled control states its reason. */}
            {!operatorKey && (
              <p className="text-[11.5px] leading-[16px]" style={{ color: 'var(--text-muted)' }}>
                ▸ Both actions write to the ledger, so they need the operator key. It is{' '}
                <code className="mono">OPERATOR_ACCESS_KEY</code> from the environment.
              </p>
            )}
            {operatorKey && !dirty && detail?.status !== 'live' && (
              <p className="text-[11.5px] leading-[16px]" style={{ color: 'var(--text-muted)' }}>
                ▸ Saving is disabled because the source is unchanged. Edit it to create a draft.
              </p>
            )}

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
            {issues && issues.length > 0 && (
              <ul className="flex flex-col gap-1">
                {issues.map((i, n) => (
                  <li key={n} className="text-[11.5px] leading-[16px]">
                    <span className="mono" style={{ color: 'var(--danger)' }}>
                      {i.path || '(root)'}
                    </span>{' '}
                    <span style={{ color: 'var(--text-secondary)' }}>{i.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <ParsedSummary detail={detail} />

          <Panel title="What publishing does" className="flex-1" bodyClassName="p-3 flex flex-col gap-1.5">
            <p className="text-[12px] leading-[17px]" style={{ color: 'var(--text-secondary)' }}>
              The previous live version is archived in the same transaction, and the publish appends
              a <span className="mono">policy_published</span> record to the audit ledger with the
              caps, the contact window and the breaker trigger that went live.
            </p>
            <p className="text-[11.5px] leading-[16px]" style={{ color: 'var(--text-muted)' }}>
              ▸ It is never retroactive. Events already decided keep the version they were decided
              under, which is why the ledger stores the version per record rather than looking it up.
            </p>
          </Panel>
        </div>
      </div>
    </div>
  );
}

/**
 * The fields the gate actually reads, pulled out of the parsed policy.
 *
 * Rendered from `parsed` rather than from the YAML text: what matters is what
 * the server understood, and if those two ever disagree this panel is where it
 * would show.
 */
function ParsedSummary({ detail }: { detail: PolicyDetail | null }) {
  if (!detail?.parsed) return null;
  const p = detail.parsed as Record<string, unknown>;
  const caps = (p.caps ?? {}) as Record<string, unknown>;
  const win = (p.contact_window ?? {}) as Record<string, unknown>;
  const breaker = (p.circuit_breaker ?? {}) as Record<string, unknown>;
  const stopOn = Array.isArray(p.stop_on) ? (p.stop_on as unknown[]) : [];

  const rows: Array<[string, string]> = [
    ...Object.entries(caps).map(([k, v]) => [k.replace(/_/g, ' '), fmt(v)] as [string, string]),
    // The schema field is `tz`, not `timezone`; reading the wrong key printed
    // a trailing em-dash where the zone should be. `fmt` returning '—' for a
    // missing value is what made it visible rather than silently blank.
    ['contact window', `${fmt(win.start)} – ${fmt(win.end)} ${win.tz ? fmt(win.tz) : ''}`.trim()],
    ['breaker trigger', fmt(breaker.trigger)],
  ];

  return (
    <Panel title="As the gate reads it" bodyClassName="p-3 flex flex-col gap-1.5">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-3 text-[12.5px]">
          <span style={{ color: 'var(--text-secondary)' }}>{k}</span>
          <span className="mono tnum text-right break-all" style={{ color: 'var(--text-primary)' }}>
            {v}
          </span>
        </div>
      ))}
      {stopOn.length > 0 && (
        <div className="flex flex-col gap-1 pt-1" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <span className="label">stop on</span>
          <span className="flex flex-wrap gap-1">
            {stopOn.map((s, i) => (
              <Badge key={i} tone="muted">
                {String(s).replace(/_/g, ' ')}
              </Badge>
            ))}
          </span>
        </div>
      )}
    </Panel>
  );
}

/**
 * `String()`, never bare interpolation. Same trap the decision trace hit: a
 * policy value can legitimately be `false` or `0`, and React renders `false`
 * as nothing at all.
 */
function fmt(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.map((x) => String(x)).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
