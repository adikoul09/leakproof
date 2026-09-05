'use client';

/**
 * Cumulative recovery by arm.
 *
 * ── Why the default series is per-event and not gross rupees ──────────
 *
 * The arms are deliberately unequal: 18% control, 20% naive, 62% LEAKPROOF.
 * So a chart of cumulative *gross* rupees per arm has the LEAKPROOF line three
 * times higher than control before the system has done anything at all — it
 * plots the traffic split, not the result. It is the single most flattering
 * and least honest chart this project could show, which is exactly why it
 * needs saying out loud rather than quietly defaulting to something else.
 *
 * The default is therefore mean recovered value per event, which is
 * comparable across arms of any size and is also the estimator itself:
 *
 *   incremental = n_treated × (per-event value treated − per-event value control)
 *
 * i.e. the vertical gap between the teal and blue lines at the right-hand
 * edge, multiplied by the treated count. The headline number is the gap.
 *
 * Gross is still available, with a caution attached, because the blueprint
 * asked for it and hiding it would be its own kind of dishonesty.
 *
 * Drawn by hand in SVG rather than pulled from a chart library: three
 * polylines and an axis is less code than configuring someone else's
 * component, and it keeps the arm colours identical to every other surface.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { rupees } from '@/components/primitives';

export interface TimeseriesPoint {
  bucket: string;
  arm: 'control' | 'naive' | 'leakproof';
  n: number;
  recovered: number;
  gross_paise: number;
  cumulative_gross_paise: number;
}

export type ChartMode = 'per_event' | 'rate' | 'gross';

const ARMS = [
  { key: 'control', label: 'Control (held out)', colour: 'var(--arm-control)' },
  { key: 'naive', label: 'Naive retry', colour: 'var(--arm-naive)' },
  { key: 'leakproof', label: 'LEAKPROOF', colour: 'var(--arm-leakproof)' },
] as const;

const MODES: Array<{ key: ChartMode; label: string; title: string }> = [
  {
    key: 'per_event',
    label: '₹ / event',
    title: 'Mean recovered value per event. Comparable across arms; the gap at the right edge times the treated count is the headline number.',
  },
  {
    key: 'rate',
    label: 'recovery rate',
    title: 'Share of events in each arm that recovered. Comparable across arms.',
  },
  {
    key: 'gross',
    label: 'gross ₹',
    title: 'Total rupees recovered. NOT comparable across arms — the arms are different sizes by design.',
  },
];

/** Real pixel width, so nothing is drawn into a distorted viewBox. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

interface Series {
  arm: (typeof ARMS)[number]['key'];
  colour: string;
  values: number[];
}

const PAD = { top: 10, right: 12, bottom: 20, left: 54 };
const HEIGHT = 240;

export function CumulativeChart({
  points,
  mode,
  onModeChange,
  bucket,
  onBucketChange,
  loading,
  error = null,
}: {
  points: TimeseriesPoint[];
  mode: ChartMode;
  onModeChange: (m: ChartMode) => void;
  bucket: string;
  onBucketChange: (b: string) => void;
  loading: boolean;
  /** A failed fetch, so it can be told apart from a window with nothing in it. */
  error?: string | null;
}) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const { buckets, series, max } = useMemo(() => {
    const buckets = [...new Set(points.map((p) => p.bucket))].sort();
    const index = new Map(buckets.map((b, i) => [b, i]));

    const series: Series[] = ARMS.map((a) => {
      const cumN: number[] = new Array(buckets.length).fill(0);
      const cumRecovered: number[] = new Array(buckets.length).fill(0);
      const cumGross: number[] = new Array(buckets.length).fill(0);

      for (const p of points) {
        if (p.arm !== a.key) continue;
        const i = index.get(p.bucket);
        if (i === undefined) continue;
        cumN[i] += p.n;
        cumRecovered[i] += p.recovered;
        cumGross[i] += p.gross_paise;
      }

      /**
       * The API emits a row only for buckets where that arm had an event, so
       * a sparse arm would otherwise draw a line that dips back to zero
       * between its own observations. Carry the running totals forward.
       */
      let n = 0;
      let recovered = 0;
      let gross = 0;
      const values = buckets.map((_, i) => {
        n += cumN[i];
        recovered += cumRecovered[i];
        gross += cumGross[i];
        if (mode === 'gross') return gross;
        if (n === 0) return 0;
        return mode === 'rate' ? recovered / n : gross / n;
      });

      return { arm: a.key, colour: a.colour, values };
    });

    const max = Math.max(...series.flatMap((s) => s.values), mode === 'rate' ? 0.01 : 1);
    return { buckets, series, max };
  }, [points, mode]);

  const innerW = Math.max(width - PAD.left - PAD.right, 10);
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (buckets.length <= 1 ? 0 : (i / (buckets.length - 1)) * innerW);
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;

  const fmt = (v: number) =>
    mode === 'rate' ? `${(v * 100).toFixed(1)}%` : rupees(Math.round(v), { compact: mode === 'gross' });

  // Five gridlines, on round-ish values.
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const at = hover ?? buckets.length - 1;

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {MODES.map((m) => (
            <button
              key={m.key}
              onClick={() => onModeChange(m.key)}
              title={m.title}
              className="cursor-pointer rounded-sm px-2 py-1 text-[11.5px] transition-colors duration-200"
              style={{
                color: mode === m.key ? 'var(--accent)' : 'var(--text-secondary)',
                background: mode === m.key ? 'var(--accent-dim)' : 'transparent',
                border: `1px solid ${mode === m.key ? 'rgba(20,184,166,0.3)' : 'var(--border-subtle)'}`,
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5">
          <span className="label">bucket</span>
          <select
            value={bucket}
            onChange={(e) => onBucketChange(e.target.value)}
            className="rounded-sm px-1.5 py-0.5 text-[11.5px]"
            style={{
              background: 'var(--bg-surface-2)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-primary)',
            }}
          >
            {['5m', '15m', '1h'].map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div ref={wrapRef} className="relative w-full">
        {/*
          Loading and empty were the same branch, so a window with no points
          showed a shimmer that never resolved — the screen claimed to be
          fetching something it had already finished not finding.
        */}
        {loading ? (
          <div className="skeleton rounded-sm" style={{ height: HEIGHT }} />
        ) : error !== null ? (
          <div
            className="flex flex-col items-center justify-center gap-1 rounded-sm px-4 text-center"
            style={{ height: HEIGHT, border: '1px dashed rgba(240,85,79,0.4)' }}
          >
            <p className="text-[12.5px]" style={{ color: 'var(--danger)' }}>
              Could not load the series — {error}
            </p>
            <p className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
              This is a failed request, not an empty window. Nothing here has been measured.
            </p>
          </div>
        ) : buckets.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center gap-1 rounded-sm px-4 text-center"
            style={{ height: HEIGHT, border: '1px dashed var(--border-subtle)' }}
          >
            <p className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
              No events in this window.
            </p>
            <p className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
              Widen the bucket, or generate a batch — nothing has been recorded to plot.
            </p>
          </div>
        ) : (
          <svg
            width={width}
            height={HEIGHT}
            role="img"
            aria-label={`Cumulative ${mode.replace('_', ' ')} by arm`}
            onMouseLeave={() => setHover(null)}
            onMouseMove={(e) => {
              const rect = (e.target as SVGElement).ownerSVGElement?.getBoundingClientRect();
              if (!rect || buckets.length < 2) return;
              const f = (e.clientX - rect.left - PAD.left) / innerW;
              setHover(Math.max(0, Math.min(buckets.length - 1, Math.round(f * (buckets.length - 1)))));
            }}
          >
            {ticks.map((t, i) => (
              <g key={i}>
                <line
                  x1={PAD.left}
                  x2={width - PAD.right}
                  y1={y(t)}
                  y2={y(t)}
                  stroke="var(--border-subtle)"
                  strokeDasharray={i === 0 ? undefined : '2 4'}
                />
                <text
                  x={PAD.left - 6}
                  y={y(t) + 3.5}
                  textAnchor="end"
                  fill="var(--text-muted)"
                  style={{ fontSize: 10, fontVariantNumeric: 'tabular-nums' }}
                >
                  {fmt(t)}
                </text>
              </g>
            ))}

            {series.map((s) => (
              <polyline
                key={s.arm}
                fill="none"
                stroke={s.colour}
                strokeWidth={1.75}
                strokeLinejoin="round"
                points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')}
              />
            ))}

            {hover !== null && (
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={PAD.top}
                y2={PAD.top + innerH}
                stroke="var(--border-strong)"
              />
            )}
            {series.map((s) => (
              <circle
                key={`${s.arm}-dot`}
                cx={x(at)}
                cy={y(s.values[at] ?? 0)}
                r={2.75}
                fill={s.colour}
              />
            ))}

            <text
              x={PAD.left}
              y={HEIGHT - 6}
              fill="var(--text-muted)"
              style={{ fontSize: 10, fontVariantNumeric: 'tabular-nums' }}
            >
              {istLabel(buckets[0])}
            </text>
            <text
              x={width - PAD.right}
              y={HEIGHT - 6}
              textAnchor="end"
              fill="var(--text-muted)"
              style={{ fontSize: 10, fontVariantNumeric: 'tabular-nums' }}
            >
              {istLabel(buckets[buckets.length - 1])}
            </text>
          </svg>
        )}
      </div>

      {/* The legend doubles as the hover readout: values at the crosshair,
          or the final values when the pointer is away. */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        {ARMS.map((a) => {
          const s = series.find((x) => x.arm === a.key);
          return (
            <span key={a.key} className="flex items-baseline gap-1.5 text-[12px]">
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ background: a.colour }}
                aria-hidden
              />
              <span style={{ color: 'var(--text-secondary)' }}>{a.label}</span>
              <span className="tnum" style={{ color: 'var(--text-primary)' }}>
                {s && buckets.length > 0 && s.values[at] !== undefined ? fmt(s.values[at]) : '—'}
              </span>
            </span>
          );
        })}
        <span className="ml-auto text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
          {buckets.length === 0 ? '—' : hover === null ? 'final' : istLabel(buckets[at])}
        </span>
      </div>

      {mode === 'gross' && (
        <p className="text-[11.5px] leading-[16px]" style={{ color: 'var(--warning)' }}>
          ▸ Not a comparison. The arms are 18/20/62 by design, so this chart is mostly showing how
          much traffic each arm was given. Use ₹/event or recovery rate to compare them.
        </p>
      )}
      {mode !== 'gross' && (
        <p className="text-[11.5px] leading-[16px]" style={{ color: 'var(--text-muted)' }}>
          {mode === 'per_event' && (
            <>
              ▸ The vertical gap between LEAKPROOF and control at the right edge, times the treated
              event count, is the incremental figure above. The chart and the headline are the same
              arithmetic.{' '}
            </>
          )}
          Read the right-hand end, not the left: these are cumulative averages, so the first few
          buckets are computed over a handful of events and one large recovery swings them far more
          than anything the system did.
        </p>
      )}
    </div>
  );
}

function istLabel(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
