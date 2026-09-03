/**
 * Circuit breaker.
 *
 * The evaluation is pure — a trigger, an observed value, a decision. Reading
 * and writing the state lives in `breaker-store.ts`, so the replay engine can
 * drive the same comparison over historical cohort rates without touching the
 * database, and so this file can be unit-tested without one.
 *
 * Scope matters: the breaker is keyed per cohort ('HDFC|card'), not globally.
 * One issuer having a bad afternoon should not halt recovery for every other
 * bank on the platform, and a global breaker is the kind of blunt instrument
 * that gets switched off permanently after its first false trip.
 */
import type { BreakerTrigger } from './schema';

export const GLOBAL_SCOPE = 'global';

export interface BreakerEvaluation {
  shouldOpen: boolean;
  observed: number;
  threshold: number;
  trigger: string;
  explanation: string;
}

const compare = (op: BreakerTrigger['op'], a: number, b: number): boolean => {
  switch (op) {
    case '>':
      return a > b;
    case '>=':
      return a >= b;
    case '<':
      return a < b;
    case '<=':
      return a <= b;
  }
};

/** Pure: does this observation trip the breaker? */
export function evaluateBreaker(trigger: BreakerTrigger, observed: number): BreakerEvaluation {
  const shouldOpen = compare(trigger.op, observed, trigger.threshold);
  return {
    shouldOpen,
    observed,
    threshold: trigger.threshold,
    trigger: trigger.source,
    explanation: `${trigger.metric} ${(observed * 100).toFixed(1)}% ${trigger.op} ${(trigger.threshold * 100).toFixed(1)}% → ${shouldOpen ? 'OPEN' : 'closed'}`,
  };
}

export interface BreakerStatus {
  scope: string;
  open: boolean;
  reason: string | null;
  openedAt: Date | null;
  actor: string;
}
