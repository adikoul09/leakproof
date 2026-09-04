'use client';

/**
 * Motion primitives.
 *
 * Deliberately dependency-free. A spring library would be ~40kB gzipped to do
 * what four keyframes and one IntersectionObserver already do here, and the
 * console's budget is better spent on the pipeline than on an animation
 * runtime. Everything below drives the CSS in globals.css rather than
 * animating in JavaScript.
 */
import { useEffect, useRef, useState, type ElementType, type ReactNode } from 'react';

const REDUCED = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/**
 * True once the element has been on screen. Fires once and disconnects — a
 * reveal that replays on every scroll-by is a distraction, not a reveal.
 *
 * Falls back to visible-immediately when IntersectionObserver is missing, so
 * an unsupported browser gets a plain page rather than a blank one.
 */
export function useInView<T extends HTMLElement>(rootMargin = '-12% 0px -8% 0px') {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { rootMargin, threshold: 0.05 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [rootMargin]);

  return { ref, inView };
}

/** Fade-and-rise on entry. `delay` is in stagger steps, not milliseconds. */
export function Reveal({
  children,
  delay = 0,
  as: As = 'div',
  className = '',
  variant = 'rise',
  immediate = false,
}: {
  children: ReactNode;
  delay?: number;
  as?: ElementType;
  className?: string;
  variant?: 'rise' | 'fade' | 'scale';
  immediate?: boolean;
}) {
  const { ref, inView } = useInView<HTMLDivElement>();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const on = immediate ? mounted : inView;
  const variantClass = variant === 'fade' ? 'reveal-fade' : variant === 'scale' ? 'reveal-scale' : '';
  return (
    <As
      ref={ref}
      className={`reveal ${variantClass} ${on ? 'in' : ''} ${className}`}
      style={{ '--i': delay } as React.CSSProperties}
    >
      {children}
    </As>
  );
}

/** A headline line that slides out from behind its own clip box. */
export function MaskLine({
  children,
  delay = 0,
  className = '',
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <span
      className={`line-mask ${mounted ? 'in' : ''} ${className}`}
      style={{ '--i': delay } as React.CSSProperties}
    >
      <span>{children}</span>
    </span>
  );
}

/**
 * Counts a number up on first paint and on every subsequent change.
 *
 * `format` receives the interpolated value, so callers keep control of units —
 * this never learns what a rupee is. Reduced motion skips straight to the
 * value: a count-up is pure ornament and is the first thing that should go.
 */
export function CountUp({
  value,
  format,
  duration = 900,
  className = '',
}: {
  value: number;
  format: (n: number) => string;
  duration?: number;
  className?: string;
}) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    if (REDUCED()) {
      setShown(value);
      from.current = value;
      return;
    }
    const start = performance.now();
    const a = from.current;
    const b = value;
    if (a === b) return;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // Expo-out, matching --ease-out-expo: fast commit, long settle.
      const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
      setShown(a + (b - a) * eased);
      if (t < 1) raf.current = requestAnimationFrame(step);
      else from.current = b;
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      from.current = value;
    };
  }, [value, duration]);

  return <span className={`tnum ${className}`}>{format(shown)}</span>;
}

/**
 * Adds `.tick` for one animation cycle whenever `value` changes. On a 5-second
 * poll this is the only thing telling an operator that the figure they are
 * looking at was just replaced.
 */
export function useChangePulse(value: number | string | null | undefined) {
  const prev = useRef(value);
  const [pulsing, setPulsing] = useState(false);
  useEffect(() => {
    if (prev.current === value) return;
    prev.current = value;
    setPulsing(true);
    const t = setTimeout(() => setPulsing(false), 1100);
    return () => clearTimeout(t);
  }, [value]);
  return pulsing ? 'tick' : '';
}
