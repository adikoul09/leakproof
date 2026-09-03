/**
 * Rail routing, v1 — a static table keyed by failure class.
 *
 * 🔒 The bandit is a deliberate cut, stated in the README and the pitch. A
 * Thompson-sampling policy over (failure_class × rail) needs volume to beat a
 * table a human wrote, and a two-day synthetic corpus does not have it. An
 * unconverged bandit is a random number generator with a nice name. The
 * `bandit_arms` table and the α/β update path ship anyway, behind
 * FEATURE_BANDIT=false, so the design is reviewable.
 *
 * Each list is ordered by attempt number: first attempt takes rail[0], the
 * follow-up takes rail[1], and so on. Running off the end means `do_nothing`,
 * which is a real decision and is recorded as one.
 */
import type { FailureClass } from '@/core/triage/taxonomy';

export const RAILS = [
  'upi_payment_link',
  'card_retry_delayed_payday',
  'netbanking_link',
  'mandate_repair',
  'whatsapp_nudge',
  'email_link',
  'human_escalation',
  'do_nothing',
] as const;
export type Rail = (typeof RAILS)[number];

/**
 * Rationale is carried alongside the routing because the Decision Trace shows
 * it to a human who is deciding whether to trust the system.
 */
export const RAIL_TABLE: Record<FailureClass, { rails: Rail[]; why: string }> = {
  // ── Systemic: the customer did nothing wrong. Move them off the broken
  // rail rather than asking them to try harder on it.
  issuer_degraded: {
    rails: ['upi_payment_link', 'netbanking_link', 'do_nothing'],
    why: 'the issuer is down, so route around it — UPI does not touch the failing issuer',
  },
  network_degraded: {
    rails: ['upi_payment_link', 'do_nothing'],
    why: 'rail-level degradation with no named issuer; offer the simplest alternative and stop',
  },
  gateway_error: {
    rails: ['upi_payment_link', 'email_link', 'do_nothing'],
    why: 'transient technical failure; a fresh link on a different rail usually clears it',
  },

  // ── Idiosyncratic: something about this customer's instrument or balance.
  insufficient_funds: {
    rails: ['card_retry_delayed_payday', 'upi_payment_link', 'whatsapp_nudge'],
    why: 'retrying immediately fails again; wait for salary credit, then offer a link',
  },
  auth_failure: {
    rails: ['upi_payment_link', 'email_link', 'do_nothing'],
    why: 'the card details or OTP failed; a UPI link sidesteps the failing factor entirely',
  },
  expired_card: {
    rails: ['upi_payment_link', 'email_link', 'human_escalation'],
    why: 'the instrument is dead — a retry can never succeed, only a new instrument can',
  },
  mandate_invalid: {
    rails: ['mandate_repair', 'email_link', 'human_escalation'],
    why: 'the mandate itself is broken; repair it before charging again',
  },
  limit_exceeded: {
    rails: ['card_retry_delayed_payday', 'upi_payment_link', 'do_nothing'],
    why: 'a per-transaction or daily cap was hit; the same attempt tomorrow may clear',
  },
  risk_blocked: {
    rails: ['human_escalation', 'do_nothing'],
    why: 'never auto-retry a risk block — that is how a merchant account gets flagged',
  },
  customer_abandoned: {
    rails: ['whatsapp_nudge', 'upi_payment_link', 'do_nothing'],
    why: 'nothing technical failed; the customer walked away and a reminder is the whole job',
  },
  invoice_overdue: {
    rails: ['email_link', 'whatsapp_nudge', 'human_escalation'],
    why: 'B2B collections run on email; escalate to a human rather than nagging',
  },

  // ── We genuinely do not know. Do the cheapest, least intrusive thing.
  unknown: {
    rails: ['upi_payment_link', 'do_nothing'],
    why: 'insufficient signal to be clever; one low-cost attempt, then stop',
  },
};

export interface RailChoice {
  rail: Rail;
  chosenBy: 'static_table' | 'naive_fixed';
  /** Alternatives considered, recorded for the Decision Trace. */
  railScores: { considered: Rail[]; position: number; why: string };
}

/**
 * The naive arm's strawman: always email a link, immediately, regardless of
 * why the payment failed. This is what most dunning tools actually do, and it
 * is the comparison the incrementality result has to beat to mean anything.
 */
export function chooseRailNaive(attemptNo: number): RailChoice {
  return {
    rail: attemptNo <= 3 ? 'email_link' : 'do_nothing',
    chosenBy: 'naive_fixed',
    railScores: {
      considered: ['email_link'],
      position: attemptNo,
      why: 'naive arm: one fixed rail for every failure class, no routing decision',
    },
  };
}

/** Pure. `attemptNo` is 1-based. */
export function chooseRail(failureClass: FailureClass, attemptNo: number): RailChoice {
  const entry = RAIL_TABLE[failureClass] ?? RAIL_TABLE.unknown;
  const idx = Math.max(0, attemptNo - 1);
  const rail = entry.rails[idx] ?? 'do_nothing';
  return {
    rail,
    chosenBy: 'static_table',
    railScores: { considered: entry.rails, position: attemptNo, why: entry.why },
  };
}

/**
 * Rails that need a scheduling delay rather than immediate execution.
 * `card_retry_delayed_payday` is the whole reason durable scheduling is
 * load-bearing: retrying an insufficient-funds failure now just burns an
 * attempt against the cap.
 */
export const RAIL_DELAY_HOURS: Partial<Record<Rail, number>> = {
  card_retry_delayed_payday: 48,
};
