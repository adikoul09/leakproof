'use client';

/**
 * SCREEN 1 — the way in.
 *
 * `/` used to redirect straight to `/tower`, which meant the first thing a
 * judge saw was a dense grid mid-poll with no explanation of what they were
 * looking at. This screen buys about eight seconds of context before that.
 *
 * It is deliberately NOT a marketing page. No feature grid, no testimonials,
 * no gradient wordmark. The numbers on it are read live from the same APIs the
 * console uses, the ledger badge is a real chain verification, and when the
 * instance is cold it says so rather than showing invented figures. The
 * atmosphere is meant to read as the console booting, not as a landing page
 * selling one.
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { rupees } from '@/components/primitives';
import { CountUp, MaskLine, Reveal } from '@/components/motion';

interface Summary {
  arms: Record<string, { n: number; recovered: number; recovery_rate: number; gross_paise: number }>;
  incremental_paise: number;
  ci95_paise: [number, number];
  lift_vs_control_pp: number;
  p_value: number;
  powered: boolean;
  power_blockers: string[];
  error?: string;
}

interface Chain {
  intact: boolean;
  records: number;
  head_hash: string;
  verified_in_ms: number;
}

const STAGES = [
  { k: 'Webhook', d: 'payment.failed' },
  { k: 'Classify', d: 'systemic / idiosyncratic' },
  { k: 'Policy gate', d: 'caps · window · breaker' },
  { k: 'Rail', d: 'link · WhatsApp' },
  { k: 'Ledger', d: 'hash-chained' },
];

const PROOF = [
  {
    n: '01',
    title: 'A held-out control arm',
    body: 'Every event is assigned by a stable hash to control, naive retry, or LEAKPROOF. The control arm is never contacted — not throttled, not delayed, never contacted. The headline figure is the gap between arms, with a bootstrapped 95% interval and a p-value beside it.',
    tag: 'Bootstrap · 10k iterations · fixed seed',
  },
  {
    n: '02',
    title: 'A policy that can say no',
    body: 'Contact caps, quiet hours, per-customer windows, stop-on-recovery, and a circuit breaker that trips on an issuer outage. Every block is written down with the clause that caused it, so a refusal to act is as auditable as an action.',
    tag: 'Versioned YAML · replayable',
  },
  {
    n: '03',
    title: 'A receipt for every action',
    body: 'Each decision appends to a hash-chained ledger. Change one historical row and the chain stops verifying at that sequence number and names it. The verification below ran against the live database when this page loaded.',
    tag: 'Tamper-evident · CSV export',
  },
];

export function EntryScreen() {
  const [m, setM] = useState<Summary | null>(null);
  const [chain, setChain] = useState<Chain | null>(null);
  const [cold, setCold] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    let alive = true;

    const loadMetrics = async () => {
      try {
        const s = await fetch('/api/metrics/summary').then((r) => r.json());
        if (!alive) return;
        setM(s?.error ? null : s);
        setCold(Boolean(s?.error));
      } catch {
        if (alive) setCold(true);
      }
    };

    void loadMetrics();
    const t = setInterval(() => void loadMetrics(), 15000);

    // Once, not on the timer. Verification walks the entire chain — thousands
    // of rehashes, seconds of database time — and a landing page left open in a
    // tab should not be re-running it every fifteen seconds against the same
    // instance the console is polling.
    void fetch('/api/ledger/verify')
      .then((r) => r.json())
      .then((c) => alive && setChain(c))
      .catch(() => {});

    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const arms = m?.arms ?? {};
  const classified = Object.values(arms).reduce((a, x) => a + x.n, 0);
  const gross = Object.values(arms).reduce((a, x) => a + x.gross_paise, 0);

  return (
    <div className="relative min-h-screen overflow-x-clip" style={{ background: 'var(--bg-void)' }}>
      <TopBar scrolled={scrolled} />

      {/* ---------------------------------------------------------------- hero */}
      <section className="relative flex min-h-[100svh] flex-col justify-center px-6 pt-24 pb-16 sm:px-10">
        <Atmosphere />

        <div className="relative mx-auto w-full max-w-[1180px]">
          <Reveal immediate variant="fade" className="mb-7 flex items-center gap-2.5">
            <span
              className="ping relative inline-block h-1.5 w-1.5 rounded-full"
              style={{ background: 'var(--accent)', color: 'var(--accent)' }}
              aria-hidden
            />
            <span className="eyebrow">Razorpay Buildathon · Track 03</span>
            {/* Both halves at 0.22em tracking wrap into three ragged lines on a
                phone. The second half is context, not information — drop it
                rather than let it break the line. */}
            <span
              className="hidden h-3 w-px sm:block"
              style={{ background: 'var(--border-strong)' }}
              aria-hidden
            />
            <span className="eyebrow hidden sm:inline" style={{ letterSpacing: '0.18em' }}>
              Revenue recovery control tower
            </span>
          </Reveal>

          <h1
            className="display max-w-[15ch]"
            style={{ fontSize: 'clamp(2.7rem, 8.2vw, 5.75rem)', color: 'var(--text-primary)' }}
          >
            <MaskLine delay={0}>Recover the revenue.</MaskLine>
            <MaskLine delay={1}>
              <span style={{ color: 'var(--accent)' }}>Prove it was you.</span>
            </MaskLine>
          </h1>

          <div className="mt-7 flex flex-col gap-10 lg:flex-row lg:items-start lg:gap-14">
            <div className="min-w-0 flex-1">
              <Reveal immediate delay={5} className="max-w-[58ch]">
                <p
                  className="text-[16.5px] leading-[27px]"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  LEAKPROOF reads every failed payment, separates an issuer outage from a customer
                  problem, and routes recovery through a policy gate that is allowed to say no. Then
                  it measures the rupees it actually added — against a control group it never
                  touched.
                </p>
              </Reveal>

              <Reveal immediate delay={7} className="mt-8 flex flex-wrap items-center gap-3">
                <Link
                  href="/tower"
                  className="sheen press group inline-flex w-full items-center justify-center gap-2.5 rounded-[8px] px-5 py-3 text-[14px] font-semibold sm:w-auto sm:justify-start"
                  style={{
                    background: 'var(--accent)',
                    color: '#03211e',
                    boxShadow: '0 10px 34px -14px var(--glow-accent)',
                  }}
                >
                  <span className="sheen-bar" aria-hidden />
                  Enter the Control Tower
                  <span
                    className="inline-block transition-transform duration-300 group-hover:translate-x-1"
                    aria-hidden
                  >
                    →
                  </span>
                </Link>
                <Link
                  href="/replay"
                  className="press lift inline-flex w-full items-center justify-center gap-2 rounded-[8px] px-5 py-3 text-[14px] font-medium sm:w-auto"
                  style={{
                    border: '1px solid var(--border-strong)',
                    color: 'var(--text-primary)',
                    background: 'rgba(24,36,58,0.5)',
                  }}
                >
                  Replay &amp; what-if
                </Link>
                <span className="mono ml-1" style={{ color: 'var(--text-muted)' }}>
                  live instance · synthetic events · no real customer is contacted
                </span>
              </Reveal>
            </div>

            {/*
              The three arms, from the live database, on the first screen.
              The single idea a judge has to leave with is that the headline is a
              *difference between arms*, not a tally of payments that happened to
              land after a nudge. Saying it in a sentence takes a paragraph nobody
              reads; three bars say it before they finish the headline.
            */}
            <Reveal immediate delay={8} variant="scale" className="w-full shrink-0 lg:w-[330px]">
              <ArmsCard m={m} />
            </Reveal>
          </div>

          <Reveal immediate delay={9} className="mt-14">
            <LiveStrip
              cold={cold}
              ready={m !== null}
              classified={classified}
              gross={gross}
              m={m}
              chain={chain}
            />
          </Reveal>
        </div>

        <Reveal
          immediate
          delay={12}
          variant="fade"
          className="relative mx-auto mt-14 w-full max-w-[1180px]"
        >
          <Pipeline />
        </Reveal>
      </section>

      {/* --------------------------------------------------------------- proof */}
      <section className="relative px-6 py-24 sm:px-10">
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-px"
          style={{
            background: 'linear-gradient(90deg, transparent, var(--border-strong), transparent)',
          }}
          aria-hidden
        />
        <div className="mx-auto w-full max-w-[1180px]">
          <Reveal className="mb-3">
            <span className="eyebrow">Why the number is trustworthy</span>
          </Reveal>
          <Reveal delay={1}>
            <h2
              className="display max-w-[20ch]"
              style={{ fontSize: 'clamp(1.75rem, 3.6vw, 2.75rem)' }}
            >
              Recovery tools are easy. Attribution is the hard part.
            </h2>
          </Reveal>
          <Reveal delay={2} className="mt-4 max-w-[64ch]">
            <p className="text-[15px] leading-[25px]" style={{ color: 'var(--text-secondary)' }}>
              Most of these systems count every payment that lands after a nudge as revenue they
              recovered. A good share of those customers would have paid anyway. Three things
              separate a claim from a measurement here.
            </p>
          </Reveal>

          <div className="mt-12 grid gap-3 md:grid-cols-3">
            {PROOF.map((p, i) => (
              <Reveal key={p.n} delay={i} className="h-full">
                <article
                  className="lift hairline flex h-full flex-col gap-3 rounded-[12px] p-5"
                  style={{
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border-subtle)',
                  }}
                >
                  <span className="mono" style={{ color: 'var(--accent)' }}>
                    {p.n}
                  </span>
                  <h3 className="text-[18px]">{p.title}</h3>
                  <p
                    className="flex-1 text-[13.5px] leading-[22px]"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {p.body}
                  </p>
                  <span
                    className="mono pt-2"
                    style={{ color: 'var(--text-muted)', borderTop: '1px solid var(--border-subtle)' }}
                  >
                    {p.tag}
                  </span>
                </article>
              </Reveal>
            ))}
          </div>

          <Reveal delay={1} className="mt-16">
            <div
              className="flex flex-wrap items-center justify-between gap-6 rounded-[12px] px-6 py-7"
              style={{
                background:
                  'linear-gradient(120deg, rgba(20,184,166,0.10), rgba(91,157,249,0.06) 55%, transparent)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              <div className="max-w-[54ch]">
                <h3 className="text-[22px]">
                  The console is live. Go and pull it apart.
                </h3>
                <p className="mt-1.5 text-[13.5px]" style={{ color: 'var(--text-secondary)' }}>
                  Open any row for its full decision trace — the classification and its confidence,
                  the policy clause that allowed or blocked it, the rail, and the ledger entry with
                  its hash.
                </p>
              </div>
              <Link
                href="/tower"
                className="sheen press group inline-flex shrink-0 items-center gap-2.5 rounded-[8px] px-5 py-3 text-[14px] font-semibold"
                style={{ background: 'var(--accent)', color: '#03211e' }}
              >
                <span className="sheen-bar" aria-hidden />
                Open the Control Tower
                <span
                  className="inline-block transition-transform duration-300 group-hover:translate-x-1"
                  aria-hidden
                >
                  →
                </span>
              </Link>
            </div>
          </Reveal>
        </div>
      </section>

      <footer
        className="px-6 py-8 sm:px-10"
        style={{ borderTop: '1px solid var(--border-subtle)' }}
      >
        <div className="mx-auto flex w-full max-w-[1180px] flex-wrap items-center gap-x-5 gap-y-2">
          <span className="mono" style={{ color: 'var(--text-muted)' }}>
            LEAKPROOF · money in paise · timestamps IST
          </span>
          <span className="mono ml-auto" style={{ color: 'var(--text-muted)' }}>
            Every figure on this page is computed from the live database. None of it is illustrative.
          </span>
        </div>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------ chrome */

function TopBar({ scrolled }: { scrolled: boolean }) {
  return (
    <header
      className="fixed inset-x-0 top-0 z-50 transition-all duration-500"
      style={{
        background: scrolled ? 'rgba(6,10,17,0.78)' : 'transparent',
        backdropFilter: scrolled ? 'blur(14px)' : 'none',
        WebkitBackdropFilter: scrolled ? 'blur(14px)' : 'none',
        borderBottom: `1px solid ${scrolled ? 'var(--border-subtle)' : 'transparent'}`,
      }}
    >
      <div className="mx-auto flex w-full max-w-[1180px] items-center gap-4 px-6 py-3.5 sm:px-10">
        <span
          className="text-[15px] font-semibold tracking-tight"
          style={{ color: 'var(--accent)' }}
        >
          ▣ LEAKPROOF
        </span>
        <nav className="ml-auto flex items-center gap-1.5">
          <Link
            href="/tower"
            className="link-underline rounded-[6px] px-2.5 py-1.5 text-[13px]"
            style={{ color: 'var(--text-secondary)' }}
          >
            Control tower
          </Link>
          <Link
            href="/replay"
            className="link-underline rounded-[6px] px-2.5 py-1.5 text-[13px]"
            style={{ color: 'var(--text-secondary)' }}
          >
            Replay
          </Link>
        </nav>
      </div>
    </header>
  );
}

/** Depth, and nothing else. Everything in here is aria-hidden and inert. */
function Atmosphere() {
  return (
    <div className="grain pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      <div
        className="aurora aurora-a"
        style={{
          top: '-22%',
          left: '2%',
          width: '58vw',
          height: '58vw',
          background: 'radial-gradient(circle, rgba(20,184,166,0.20), transparent 62%)',
        }}
      />
      <div
        className="aurora aurora-b"
        style={{
          top: '-8%',
          right: '-10%',
          width: '50vw',
          height: '50vw',
          background: 'radial-gradient(circle, rgba(91,157,249,0.16), transparent 62%)',
        }}
      />
      <div className="grid-field absolute inset-0" />
      <div
        className="boot-sweep absolute inset-x-0 top-0 h-px"
        style={{
          background: 'linear-gradient(90deg, transparent, rgba(20,184,166,0.9), transparent)',
        }}
      />
      <div
        className="absolute inset-x-0 bottom-0 h-40"
        style={{ background: 'linear-gradient(to bottom, transparent, var(--bg-void))' }}
      />
    </div>
  );
}

/* ------------------------------------------------------------- live figures */

function Cell({
  label,
  children,
  sub,
  accent = false,
}: {
  label: string;
  children: React.ReactNode;
  sub: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5 px-5 py-4">
      <span className="label">{label}</span>
      <span
        className="tnum truncate text-[27px] leading-9 font-semibold"
        style={{ color: accent ? 'var(--accent)' : 'var(--text-primary)' }}
      >
        {children}
      </span>
      <span className="text-[11.5px] leading-4" style={{ color: 'var(--text-muted)' }}>
        {sub}
      </span>
    </div>
  );
}

function LiveStrip({
  cold,
  ready,
  classified,
  gross,
  m,
  chain,
}: {
  cold: boolean;
  ready: boolean;
  classified: number;
  gross: number;
  m: Summary | null;
  chain: Chain | null;
}) {
  return (
    <div
      className="overflow-hidden rounded-[12px]"
      style={{
        background: 'rgba(17,26,43,0.66)',
        border: '1px solid var(--border-subtle)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
      }}
    >
      <div
        className="flex items-center gap-2 px-5 py-2"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${ready ? '' : 'pulse-danger'}`}
          style={{ background: ready ? 'var(--success)' : 'var(--warning)' }}
          aria-hidden
        />
        <span className="eyebrow" style={{ letterSpacing: '0.18em' }}>
          {ready ? 'Live from this instance' : cold ? 'Instance cold — no batch loaded' : 'Reading…'}
        </span>
      </div>

      <div className="flex flex-wrap divide-x" style={{ borderColor: 'var(--border-subtle)' }}>
        <Cell
          label="Events classified"
          sub="across all three arms"
          // A dash, not a zero. A zero here would be a claim we cannot make yet.
        >
          {ready ? <CountUp value={classified} format={(n) => Math.round(n).toLocaleString('en-IN')} /> : '—'}
        </Cell>
        <Cell label="Gross recovered" sub="every arm, before attribution">
          {ready ? <CountUp value={gross} format={(n) => rupees(n, { compact: true })} /> : '—'}
        </Cell>
        <Cell
          label="Incremental"
          accent={Boolean(m?.powered)}
          sub={
            m?.powered ? (
              <span className="tnum">
                95% CI {rupees(m.ci95_paise[0], { compact: true })} –{' '}
                {rupees(m.ci95_paise[1], { compact: true })}
              </span>
            ) : ready ? (
              // The refusal, in the metrics module's own words. This is the most
              // credible thing on the page and it should not be paraphrased.
              (m?.power_blockers?.[0] ?? 'not yet powered')
            ) : (
              'vs the held-out control arm'
            )
          }
        >
          {m?.powered ? (
            <CountUp value={m.incremental_paise} format={(n) => rupees(n, { compact: true })} />
          ) : (
            <span style={{ color: 'var(--text-muted)' }}>——</span>
          )}
        </Cell>
        <Cell
          label="Ledger chain"
          sub={
            chain
              ? `${chain.records.toLocaleString('en-IN')} entries · verified in ${chain.verified_in_ms}ms`
              : 'verifying…'
          }
        >
          {chain ? (
            <span style={{ color: chain.intact ? 'var(--success)' : 'var(--danger)' }}>
              {chain.intact ? 'Intact' : 'Broken'}
            </span>
          ) : (
            '—'
          )}
        </Cell>
      </div>
    </div>
  );
}


/* ------------------------------------------------------------------- arms */

const ARM_ROWS = [
  { key: 'control', label: 'Control (held out)', colour: 'var(--arm-control)' },
  { key: 'naive', label: 'Naive retry', colour: 'var(--arm-naive)' },
  { key: 'leakproof', label: 'LEAKPROOF', colour: 'var(--arm-leakproof)' },
] as const;

function ArmsCard({ m }: { m: Summary | null }) {
  // Bars grow from zero once the data lands. The growth is the point — a static
  // bar chart is read as a picture, a growing one is read as a measurement.
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    if (!m) return;
    const t = setTimeout(() => setGrown(true), 120);
    return () => clearTimeout(t);
  }, [m]);

  const max = m
    ? Math.max(...ARM_ROWS.map((r) => m.arms[r.key]?.recovery_rate ?? 0), 0.01)
    : 1;

  return (
    <div
      className="lift hairline rounded-[12px] p-4"
      style={{
        background: 'rgba(17,26,43,0.62)',
        border: '1px solid var(--border-subtle)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
      }}
    >
      <div className="mb-3.5 flex items-baseline justify-between">
        <span className="eyebrow" style={{ letterSpacing: '0.18em' }}>
          Recovery rate by arm
        </span>
        <span className="mono" style={{ color: 'var(--text-muted)' }}>
          live
        </span>
      </div>

      <div className="flex flex-col gap-3.5">
        {ARM_ROWS.map((r) => {
          const a = m?.arms[r.key];
          const pct = a ? (a.recovery_rate / max) * 100 : 0;
          return (
            <div key={r.key} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[12.5px]">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: r.colour }}
                    aria-hidden
                  />
                  <span style={{ color: 'var(--text-secondary)' }}>{r.label}</span>
                </span>
                <span className="tnum text-[13px] font-medium">
                  {a ? `${(a.recovery_rate * 100).toFixed(2)}%` : '—'}
                </span>
              </div>
              <div
                className="h-1.5 w-full overflow-hidden rounded-full"
                style={{ background: 'var(--bg-surface-2)' }}
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: grown ? `${pct}%` : '0%',
                    background: r.colour,
                    transition: 'width 1.1s var(--ease-out-expo)',
                    transitionDelay: `${ARM_ROWS.indexOf(r) * 110}ms`,
                  }}
                />
              </div>
              <span className="tnum text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {a ? `${a.recovered.toLocaleString('en-IN')} of ${a.n.toLocaleString('en-IN')} recovered` : 'reading…'}
              </span>
            </div>
          );
        })}
      </div>

      <p
        className="mt-4 pt-3 text-[11.5px] leading-[17px]"
        style={{ color: 'var(--text-muted)', borderTop: '1px solid var(--border-subtle)' }}
      >
        The control arm is never contacted. The gap between it and LEAKPROOF is the only revenue
        this system claims.
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- pipeline */

/**
 * The actual path an event takes, with packets running it. It is the fastest
 * way to explain the product to someone who has not read a word of the README,
 * and it is the same five stages the trace drawer shows per event.
 */
function Pipeline() {
  return (
    <div
      className="relative overflow-hidden rounded-[12px] px-5 py-4"
      style={{ background: 'rgba(17,26,43,0.4)', border: '1px solid var(--border-subtle)' }}
    >
      <div className="relative h-px w-full" style={{ background: 'var(--border-subtle)' }}>
        {[0, 1.15, 2.3].map((d, i) => (
          <span
            key={i}
            className="travel absolute -top-[2px] h-[5px] w-[5px] rounded-full"
            style={{
              background: 'var(--accent)',
              boxShadow: '0 0 10px 2px var(--glow-accent)',
              '--delay': `${d}s`,
            } as React.CSSProperties}
            aria-hidden
          />
        ))}
      </div>

      <ol className="mt-4 grid grid-cols-2 gap-y-4 sm:grid-cols-3 md:grid-cols-5">
        {STAGES.map((s, i) => (
          <li key={s.k} className="flex flex-col gap-1">
            <span className="flex items-center gap-2">
              <span
                className="mono text-[10px]"
                style={{ color: 'var(--text-muted)' }}
              >{`0${i + 1}`}</span>
              <span className="text-[13px] font-medium">{s.k}</span>
            </span>
            <span className="mono" style={{ color: 'var(--text-muted)' }}>
              {s.d}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
