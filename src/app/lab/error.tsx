'use client';

/**
 * The Lab's error boundary.
 *
 * Every other console screen fetches from the browser, so when the database
 * refuses a query they degrade into their own error state and the shell stays
 * up. `/lab` is the exception: it awaits `corpusProvenance()` in a server
 * component, because the synthetic-corpus disclosure has to render *with* the
 * headline rather than arrive after someone has already read it. That is the
 * right call for honesty and it means a rejected query takes the whole route
 * with it — which is exactly what happened when Neon's data-transfer quota ran
 * out: five screens degraded, and the one the project is judged on served a
 * bare 500 page.
 *
 * This does not paper over that. It keeps the frame — nav, and the disclosure
 * itself, which is the one claim on this screen that does not depend on any
 * query succeeding — and states plainly that the numbers are missing rather
 * than showing a screen that looks like it is still loading them.
 */
import { useEffect } from 'react';
import Link from 'next/link';
import { Badge, ConsoleNav, Panel } from '@/components/primitives';

export default function LabError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The digest is the only handle on the server-side stack from a browser;
    // without it in the console, diagnosing this from a judge's screenshot
    // means guessing.
    console.error('[lab] render failed', error.digest ?? '(no digest)', error.message);
  }, [error]);

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
        <span className="ml-auto">
          <Badge tone="danger">data unavailable</Badge>
        </span>
      </header>

      {/* Capped: a paragraph set across 1400px of console is a banner, not a message. */}
      <Panel
        title="Incrementality lab — could not load"
        className="max-w-[860px]"
        bodyClassName="p-4 flex flex-col gap-3"
      >
        <p className="text-[13px] leading-[19px]" style={{ color: 'var(--text-secondary)' }}>
          This screen reads the corpus provenance on the server before it renders anything, so a
          database that will not answer takes the whole page rather than one panel. Nothing here is
          cached and nothing is being shown from an earlier request — there are no numbers on this
          screen right now, which is why you are looking at this instead of a set of them.
        </p>

        <div className="flex flex-col gap-1.5">
          <span className="label">What is still true without the query</span>
          <p className="text-[12px] leading-[17px]" style={{ color: 'var(--text-muted)' }}>
            ▸ Every event in this corpus is synthetic, produced by the generator in this repo. That
            is a property of the build, not something read from the database, so it holds whether or
            not this page can reach one.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={reset}
            className="press cursor-pointer rounded-sm px-3 py-1.5 text-[12.5px] font-medium transition-colors duration-200 hover:bg-[rgba(20,184,166,0.2)]"
            style={{
              background: 'var(--accent-dim)',
              border: '1px solid rgba(20,184,166,0.4)',
              color: 'var(--accent)',
            }}
          >
            Try again
          </button>
          <Link
            href="/tower"
            className="press cursor-pointer rounded-sm px-3 py-1.5 text-[12.5px] transition-colors duration-200 hover:bg-[var(--bg-surface-2)]"
            style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
          >
            Control tower
          </Link>
        </div>

        {error.digest && (
          <p className="mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
            digest {error.digest}
          </p>
        )}
      </Panel>
    </div>
  );
}
