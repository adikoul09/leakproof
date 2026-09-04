/**
 * Razorpay error taxonomy → LEAKPROOF failure_class.
 *
 * Blueprint 6.5 step 1. Pure, no I/O, no dates — safe for the replay engine
 * to call directly.
 *
 * Razorpay hands back a four-field structured error on a failed payment:
 *   error_code        BAD_REQUEST_ERROR | GATEWAY_ERROR | SERVER_ERROR
 *   error_source      customer | business | bank | gateway | issuer | internal | network
 *   error_step        payment_initiation | payment_authentication |
 *                     payment_authorization | payment_response
 *   error_reason      a specific slug, e.g. payment_failed, insufficient_funds
 *
 * `error_reason` is the highest-signal field but is not always populated, so
 * matching degrades: reason → (source, step) heuristic → code → unknown. The
 * `confidence` a match carries is recorded so the Decision Trace can show
 * *why* we believe the label, not just the label.
 */

export const FAILURE_CLASSES = [
  'issuer_degraded',
  'network_degraded',
  'gateway_error',
  'insufficient_funds',
  'auth_failure',
  'expired_card',
  'mandate_invalid',
  'limit_exceeded',
  'risk_blocked',
  'customer_abandoned',
  'invoice_overdue',
  'unknown',
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export type FailureKind = 'systemic' | 'idiosyncratic' | 'unknown';

/**
 * What the raw error alone tells us, before any cohort evidence.
 *
 *  - 'customer'      the failure is about this customer's instrument or funds.
 *                    Cohort evidence cannot make it systemic.
 *  - 'infra'         the failure is about a bank/gateway/network. Might be one
 *                    unlucky transaction, might be an outage — only cohort
 *                    evidence can tell, so it starts as `unknown`.
 *  - 'indeterminate' not enough in the payload to say either way.
 */
export type Flavour = 'customer' | 'infra' | 'indeterminate';

export interface RawError {
  code?: string | null;
  description?: string | null;
  source?: string | null;
  step?: string | null;
  reason?: string | null;
}

export interface TaxonomyMatch {
  failureClass: FailureClass;
  flavour: Flavour;
  /** Confidence in the *label*, before cohort evidence. */
  confidence: number;
  /** Which rule fired — shown verbatim in the Decision Trace. */
  matchedOn: string;
}

const norm = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();

/**
 * Exact `error_reason` slugs. Highest confidence: Razorpay told us directly.
 * Slugs taken from the Razorpay payments error-source/reason reference.
 */
const REASON_MAP: Record<string, { failureClass: FailureClass; flavour: Flavour }> = {
  // ── customer funds / instrument ──
  insufficient_funds: { failureClass: 'insufficient_funds', flavour: 'customer' },
  payment_failed_due_to_insufficient_funds: {
    failureClass: 'insufficient_funds',
    flavour: 'customer',
  },
  expired_card: { failureClass: 'expired_card', flavour: 'customer' },
  invalid_expiry: { failureClass: 'expired_card', flavour: 'customer' },
  card_expired: { failureClass: 'expired_card', flavour: 'customer' },
  invalid_card: { failureClass: 'auth_failure', flavour: 'customer' },
  invalid_cvv: { failureClass: 'auth_failure', flavour: 'customer' },
  incorrect_card_details: { failureClass: 'auth_failure', flavour: 'customer' },
  card_disabled: { failureClass: 'auth_failure', flavour: 'customer' },
  card_not_supported: { failureClass: 'auth_failure', flavour: 'customer' },
  international_transaction_not_allowed: { failureClass: 'auth_failure', flavour: 'customer' },
  invalid_vpa: { failureClass: 'auth_failure', flavour: 'customer' },

  // ── authentication ──
  incorrect_otp: { failureClass: 'auth_failure', flavour: 'customer' },
  authentication_failed: { failureClass: 'auth_failure', flavour: 'customer' },
  invalid_3ds_response: { failureClass: 'auth_failure', flavour: 'customer' },
  payment_authentication_failed: { failureClass: 'auth_failure', flavour: 'customer' },

  // ── caps ──
  payment_limit_exceeded: { failureClass: 'limit_exceeded', flavour: 'customer' },
  card_limit_exceeded: { failureClass: 'limit_exceeded', flavour: 'customer' },
  amount_exceeds_limit: { failureClass: 'limit_exceeded', flavour: 'customer' },

  // ── risk ──
  risk_threshold_exceeded: { failureClass: 'risk_blocked', flavour: 'customer' },
  payment_blocked_by_risk: { failureClass: 'risk_blocked', flavour: 'customer' },
  business_payment_blocked: { failureClass: 'risk_blocked', flavour: 'customer' },
  suspected_fraud: { failureClass: 'risk_blocked', flavour: 'customer' },

  // ── mandates / subscriptions ──
  invalid_mandate: { failureClass: 'mandate_invalid', flavour: 'customer' },
  mandate_revoked: { failureClass: 'mandate_invalid', flavour: 'customer' },
  mandate_not_found: { failureClass: 'mandate_invalid', flavour: 'customer' },
  mandate_expired: { failureClass: 'mandate_invalid', flavour: 'customer' },
  emandate_registration_failure: { failureClass: 'mandate_invalid', flavour: 'customer' },
  /**
   * Synthesised by the ingestion layer from `subscription.halted`. Razorpay
   * halts a subscription only after its retries are exhausted, which means the
   * mandate can no longer be charged — so repairing the mandate is the correct
   * action, and `mandate_invalid` routes there. It is customer-flavoured: a
   * wave of halted subscriptions is a wave of individually broken mandates,
   * not an outage, and must never trip the circuit breaker.
   */
  subscription_halted: { failureClass: 'mandate_invalid', flavour: 'customer' },
  subscription_pending: { failureClass: 'mandate_invalid', flavour: 'customer' },

  // ── customer walked away ──
  payment_cancelled: { failureClass: 'customer_abandoned', flavour: 'customer' },
  payment_timed_out: { failureClass: 'customer_abandoned', flavour: 'customer' },
  upi_collect_expired: { failureClass: 'customer_abandoned', flavour: 'customer' },
  payment_window_closed: { failureClass: 'customer_abandoned', flavour: 'customer' },

  // ── infrastructure ──
  issuer_down: { failureClass: 'gateway_error', flavour: 'infra' },
  issuer_unavailable: { failureClass: 'gateway_error', flavour: 'infra' },
  bank_down: { failureClass: 'gateway_error', flavour: 'infra' },
  gateway_technical_error: { failureClass: 'gateway_error', flavour: 'infra' },
  gateway_error: { failureClass: 'gateway_error', flavour: 'infra' },
  network_error: { failureClass: 'gateway_error', flavour: 'infra' },
  server_error: { failureClass: 'gateway_error', flavour: 'infra' },
  service_unavailable: { failureClass: 'gateway_error', flavour: 'infra' },

  // ── deliberately ambiguous: Razorpay's catch-all ──
  payment_failed: { failureClass: 'unknown', flavour: 'indeterminate' },
};

/** `error_source` → what the source alone implies. */
const SOURCE_FLAVOUR: Record<string, Flavour> = {
  customer: 'customer',
  business: 'customer',
  bank: 'infra',
  issuer: 'infra',
  gateway: 'infra',
  network: 'infra',
  internal: 'infra',
};

/**
 * Last-resort keyword sniff over `error_description`. Deliberately narrow —
 * a wrong label here poisons rail routing, and 'unknown' is a legitimate,
 * honest answer that the policy engine already knows how to handle.
 */
const DESCRIPTION_HINTS: Array<[RegExp, FailureClass, Flavour]> = [
  [/insufficient|low balance|not enough/i, 'insufficient_funds', 'customer'],
  [/expired/i, 'expired_card', 'customer'],
  [/otp|authenticat|3ds|3-d secure/i, 'auth_failure', 'customer'],
  [/limit|exceed/i, 'limit_exceeded', 'customer'],
  [/risk|fraud|blocked/i, 'risk_blocked', 'customer'],
  [/mandate|emandate|subscription auth/i, 'mandate_invalid', 'customer'],
  [/cancel|timed out|timeout|abandon/i, 'customer_abandoned', 'customer'],
  [/issuer|bank.*(down|unavailable)|gateway|technical error|unavailable/i, 'gateway_error', 'infra'],
];

/**
 * Classify the raw Razorpay error into a failure class. No cohort evidence is
 * consulted here — `flavour: 'infra'` is the hand-off point where the cohort
 * detector decides between one unlucky transaction and an outage.
 */
export function classifyRawError(err: RawError): TaxonomyMatch {
  const reason = norm(err.reason);
  const code = norm(err.code);
  const source = norm(err.source);
  const step = norm(err.step);

  // 1. Exact reason slug — Razorpay said it out loud.
  const byReason = REASON_MAP[reason];
  if (byReason) {
    // `payment_failed` is Razorpay's shrug; fall through to the weaker signals.
    if (byReason.failureClass !== 'unknown') {
      return { ...byReason, confidence: 0.95, matchedOn: `error_reason=${reason}` };
    }
  }

  // 2. Description keywords.
  const description = err.description ?? '';
  for (const [re, failureClass, flavour] of DESCRIPTION_HINTS) {
    if (re.test(description)) {
      return {
        failureClass,
        flavour,
        confidence: 0.72,
        matchedOn: `error_description~/${re.source}/`,
      };
    }
  }

  // 3. Structural: code + source + step.
  if (code === 'gateway_error' || code === 'server_error') {
    return {
      failureClass: 'gateway_error',
      flavour: 'infra',
      confidence: 0.7,
      matchedOn: `error_code=${code}`,
    };
  }

  const sourceFlavour = SOURCE_FLAVOUR[source];
  if (sourceFlavour === 'infra') {
    return {
      failureClass: 'gateway_error',
      flavour: 'infra',
      confidence: 0.6,
      matchedOn: `error_source=${source}`,
    };
  }
  if (sourceFlavour === 'customer') {
    // Customer-side but unspecific. The step narrows it a little.
    if (step === 'payment_authentication') {
      return {
        failureClass: 'auth_failure',
        flavour: 'customer',
        confidence: 0.6,
        matchedOn: `error_source=${source},error_step=${step}`,
      };
    }
    return {
      failureClass: 'customer_abandoned',
      flavour: 'customer',
      confidence: 0.52,
      matchedOn: `error_source=${source}`,
    };
  }

  // 4. Give up honestly. 'unknown' is a first-class outcome, not a bug.
  return {
    failureClass: 'unknown',
    flavour: 'indeterminate',
    confidence: 0.5,
    matchedOn: byReason ? `error_reason=${reason}` : 'no_match',
  };
}

/**
 * When cohort evidence promotes an infra-flavoured failure to systemic, the
 * class sharpens: a named issuer means the issuer is degraded; no issuer means
 * it is a rail/network-level problem.
 */
export function escalateToSystemic(issuer: string | null | undefined): FailureClass {
  return issuer ? 'issuer_degraded' : 'network_degraded';
}
