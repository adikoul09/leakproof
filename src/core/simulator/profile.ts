/**
 * The generative model, in one auditable place.
 *
 * Every number below is a modelling choice, and each one changes the headline
 * result. If they are scattered through the generator they are effectively
 * hidden; collected here they can be read, argued with, and changed by someone
 * who thinks they are wrong. `docs/data-generation.md` walks through the
 * reasoning — this file is the machine-readable version of that document.
 *
 * 🔸 ASSUMPTION throughout. These are plausible figures for an Indian D2C /
 * subscription merchant, not measurements of Razorpay's real traffic. Nothing
 * here has been calibrated against a production dataset, and the README says
 * so. The generator's job is to be *honestly shaped*, not to be true.
 */
import type { Weighted } from './rng';

export type Method = 'upi' | 'card' | 'netbanking' | 'wallet';

/**
 * Method mix. UPI dominates Indian retail payments by volume while carrying
 * the smallest average ticket, which is exactly the shape that makes "recover
 * the most rupees" and "recover the most payments" different objectives.
 */
export const METHOD_MIX: ReadonlyArray<Weighted<Method>> = [
  { value: 'upi', weight: 0.62 },
  { value: 'card', weight: 0.22 },
  { value: 'netbanking', weight: 0.11 },
  { value: 'wallet', weight: 0.05 },
];

/**
 * Issuer mix per method. Deliberately *not* uniform: a realistic long tail of
 * small banks is what makes the `cohort_n >= 8` guard bite. If every issuer
 * carried equal volume, small-sample noise would never appear and the guard
 * would look like dead code.
 */
export const ISSUER_MIX: Record<Method, ReadonlyArray<Weighted<string>>> = {
  upi: [
    { value: 'HDFC', weight: 0.2 },
    { value: 'ICICI', weight: 0.16 },
    { value: 'SBI', weight: 0.22 },
    { value: 'AXIS', weight: 0.12 },
    { value: 'KOTAK', weight: 0.08 },
    { value: 'PAYTM', weight: 0.09 },
    { value: 'BOB', weight: 0.05 },
    { value: 'PNB', weight: 0.04 },
    { value: 'IDFC', weight: 0.04 },
  ],
  card: [
    { value: 'HDFC', weight: 0.28 },
    { value: 'ICICI', weight: 0.19 },
    { value: 'SBI', weight: 0.16 },
    { value: 'AXIS', weight: 0.14 },
    { value: 'KOTAK', weight: 0.09 },
    { value: 'INDUSIND', weight: 0.06 },
    { value: 'YES', weight: 0.04 },
    { value: 'RBL', weight: 0.04 },
  ],
  netbanking: [
    { value: 'HDFC', weight: 0.24 },
    { value: 'ICICI', weight: 0.2 },
    { value: 'SBI', weight: 0.26 },
    { value: 'AXIS', weight: 0.12 },
    { value: 'KOTAK', weight: 0.07 },
    { value: 'PNB', weight: 0.06 },
    { value: 'BOB', weight: 0.05 },
  ],
  wallet: [
    { value: 'PAYTM', weight: 0.42 },
    { value: 'PHONEPE', weight: 0.28 },
    { value: 'AMAZONPAY', weight: 0.18 },
    { value: 'FREECHARGE', weight: 0.12 },
  ],
};

/** Card networks, only meaningful for `method: 'card'`. */
export const CARD_NETWORKS: ReadonlyArray<Weighted<string>> = [
  { value: 'Visa', weight: 0.4 },
  { value: 'MasterCard', weight: 0.31 },
  { value: 'RuPay', weight: 0.24 },
  { value: 'Amex', weight: 0.05 },
];

/**
 * Log-normal ticket size per method, in paise.
 *
 * `mu` is ln(median). UPI's median lands near ₹420 and card's near ₹1,850,
 * with sigma wide enough that the top 1% of card tickets clear ₹50,000. That
 * tail is the whole point — see `lognormal` in rng.ts.
 */
export const AMOUNT_LOGNORMAL: Record<Method, { mu: number; sigma: number; maxPaise: number }> = {
  upi: { mu: Math.log(42_000), sigma: 1.15, maxPaise: 10_000_00 },
  card: { mu: Math.log(185_000), sigma: 1.35, maxPaise: 200_000_00 },
  netbanking: { mu: Math.log(420_000), sigma: 1.25, maxPaise: 500_000_00 },
  wallet: { mu: Math.log(28_000), sigma: 0.95, maxPaise: 2_000_00 },
};

/**
 * Relative transaction volume by IST hour, 0–23.
 *
 * The overnight trough is not cosmetic. It is what produces cohorts that fall
 * below `cohort_n >= 8` at 04:00, and a detector that has never been shown a
 * quiet hour will happily call an outage off three transactions.
 */
export const HOURLY_VOLUME: readonly number[] = [
  0.22, 0.13, 0.08, 0.06, 0.05, 0.07, // 00–05
  0.16, 0.34, 0.62, 0.88, 1.05, 1.18, // 06–11
  1.24, 1.16, 1.02, 0.98, 1.06, 1.19, // 12–17
  1.34, 1.42, 1.38, 1.15, 0.78, 0.44, // 18–23
];

/**
 * Payday cycle. Salary credits in India cluster at the end and start of the
 * month, and both volume and success rate move with them — people have money
 * on the 2nd and do not on the 28th. Multiplier by day-of-month (1-indexed).
 */
export function paydayVolumeMultiplier(dayOfMonth: number, strength: number): number {
  const payday = dayOfMonth <= 5 || dayOfMonth >= 28 ? 1 : dayOfMonth >= 25 ? 0.5 : 0;
  const lean = dayOfMonth >= 18 && dayOfMonth <= 24 ? 1 : 0;
  return 1 + strength * (0.45 * payday - 0.2 * lean);
}

/**
 * Insufficient-funds rate moves in the *opposite* direction to volume across
 * the month: the pre-payday lean period is when balances run out. Returns a
 * multiplier on the insufficient_funds share of failures.
 */
export function paydayInsufficientFundsMultiplier(dayOfMonth: number, strength: number): number {
  const lean = dayOfMonth >= 18 && dayOfMonth <= 27 ? 1 : 0;
  const flush = dayOfMonth <= 5 ? 1 : 0;
  return Math.max(0.2, 1 + strength * (0.9 * lean - 0.5 * flush));
}

/** Baseline probability that an attempt on this method fails, absent an outage. */
export const BASE_DECLINE_RATE: Record<Method, number> = {
  upi: 0.088,
  card: 0.132,
  netbanking: 0.115,
  wallet: 0.047,
};

/**
 * A realistic Razorpay error payload. `reason` is the slug the taxonomy keys
 * on; the rest is what an operator would actually see in the dashboard.
 *
 * `flavour` here is the *ground truth* the generator planted — it is never
 * passed to the classifier, only used to score it afterwards.
 */
export interface FailureShape {
  code: string;
  reason: string;
  description: string;
  source: string;
  step: string;
  /** What this failure genuinely is, for scoring. */
  truth: 'customer' | 'infra';
}

const CUSTOMER: Omit<FailureShape, 'reason' | 'description' | 'code' | 'source' | 'step'> = {
  truth: 'customer',
};

/**
 * Failure-reason mix per method, as weights over realistic payloads.
 *
 * Note there is no `payment_failed` catch-all in the *idiosyncratic* mix even
 * though Razorpay emits it constantly — it appears in ADVERSARIAL_SHAPES
 * instead, because an unlabelled failure is an adversarial input for a
 * classifier, not a routine one.
 */
export const FAILURE_MIX: Record<Method, ReadonlyArray<Weighted<FailureShape>>> = {
  upi: [
    { value: { code: 'BAD_REQUEST_ERROR', reason: 'insufficient_funds', description: 'Your account does not have enough balance to complete this transaction.', source: 'customer', step: 'payment_authorization', ...CUSTOMER }, weight: 0.34 },
    { value: { code: 'BAD_REQUEST_ERROR', reason: 'payment_timed_out', description: 'Payment was not completed on time.', source: 'customer', step: 'payment_authentication', ...CUSTOMER }, weight: 0.2 },
    { value: { code: 'BAD_REQUEST_ERROR', reason: 'upi_collect_expired', description: 'The UPI collect request expired before it was approved.', source: 'customer', step: 'payment_authentication', ...CUSTOMER }, weight: 0.14 },
    { value: { code: 'BAD_REQUEST_ERROR', reason: 'invalid_vpa', description: 'The virtual payment address is invalid.', source: 'customer', step: 'payment_initiation', ...CUSTOMER }, weight: 0.08 },
    { value: { code: 'BAD_REQUEST_ERROR', reason: 'payment_limit_exceeded', description: 'Transaction limit exceeded for this account.', source: 'customer', step: 'payment_authorization', ...CUSTOMER }, weight: 0.06 },
    { value: { code: 'BAD_REQUEST_ERROR', reason: 'payment_cancelled', description: 'Payment was cancelled by the customer.', source: 'customer', step: 'payment_authentication', ...CUSTOMER }, weight: 0.09 },
    { value: { code: 'GATEWAY_ERROR', reason: 'gateway_technical_error', description: 'Payment processing failed due to an error at the bank.', source: 'gateway', step: 'payment_authorization', truth: 'infra' }, weight: 0.06 },
    { value: { code: 'GATEWAY_ERROR', reason: 'issuer_unavailable', description: 'The bank is currently unavailable. Please try again.', source: 'issuer', step: 'payment_authorization', truth: 'infra' }, weight: 0.03 },
  ],
  card: [
    { value: { code: 'BAD_REQUEST_ERROR', reason: 'insufficient_funds', description: 'Your card does not have sufficient balance to complete this transaction.', source: 'customer', step: 'payment_authorization', ...CUSTOMER }, weight: 0.22 },
    { value: { code: 'BAD_REQUEST_ERROR', reason: 'incorrect_otp', description: 'The OTP entered is incorrect.', source: 'customer', step: 'payment_authentication', ...CUSTOMER }, weight: 0.17 },
    { value: { code: 'BAD_REQUEST_ERROR', reason: 'payment_authentication_failed', description: '3D Secure authentication failed.', source: 'customer', step: 'payment_authentication', ...CUSTOMER }, weight: 0.14 },
    { value: { code: 'BAD_REQUEST_ERROR', reason: 'expired_card', description: 'The card has expired.', source: 'customer', step: 'payment_initiation', ...CUSTOMER }, weight: 0.09 },
    { value: { code: 'BAD_REQUEST_ERROR', reason: 'invalid_cvv', description: 'The CVV entered is incorrect.', source: 'customer', step: 'payment_initiation', ...CUSTOMER }, weight: 0.07 },
    { value: { code: 'BAD_REQUEST_ERROR', reason: 'card_limit_exceeded', description: 'Transaction amount exceeds the limit set on this card.', source: 'customer', step: 'payment_authorization', ...CUSTOMER }, weight: 0.06 },
    { value: { code: 'BAD_REQUEST_ERROR', reason: 'international_transaction_not_allowed', description: 'International transactions are not enabled on this card.', source: 'customer', step: 'payment_authorization', ...CUSTOMER }, weight: 0.05 },
    { value: { code: 'BAD_REQUEST_ERROR', reason: 'risk_threshold_exceeded', description: 'Payment blocked as it was flagged as high risk.', source: 'business', step: 'payment_authorization', ...CUSTOMER }, weight: 0.04 },
    { value: { code: 'GATEWAY_ERROR', reason: 'gateway_technical_error', description: 'Payment processing failed due to an error at the bank.', source: 'gateway', step: 'payment_authorization', truth: 'infra' }, weight: 0.1 },
    { value: { code: 'GATEWAY_ERROR', reason: 'issuer_unavailable', description: 'The card issuer is currently unavailable.', source: 'issuer', step: 'payment_authorization', truth: 'infra' }, weight: 0.06 },
  ],
  netbanking: [
    { value: { code: 'BAD_REQUEST_ERROR', reason: 'insufficient_funds', description: 'Your account does not have enough balance.', source: 'customer', step: 'payment_authorization', ...CUSTOMER }, weight: 0.24 },
    { value: { code: 'BAD_REQUEST_ERROR', reason: 'authentication_failed', description: 'Netbanking login failed.', source: 'customer', step: 'payment_authentication', ...CUSTOMER }, weight: 0.16 },
    { value: { code: 'BAD_REQUEST_ERROR', reason: 'payment_timed_out', description: 'The bank page timed out before the payment completed.', source: 'customer', step: 'payment_authentication', ...CUSTOMER }, weight: 0.15 },
    { value: { code: 'BAD_REQUEST_ERROR', reason: 'payment_cancelled', description: 'Payment was cancelled on the bank page.', source: 'customer', step: 'payment_authentication', ...CUSTOMER }, weight: 0.11 },
    { value: { code: 'GATEWAY_ERROR', reason: 'bank_down', description: 'The bank is not responding. Please try another method.', source: 'bank', step: 'payment_authorization', truth: 'infra' }, weight: 0.18 },
    { value: { code: 'GATEWAY_ERROR', reason: 'gateway_technical_error', description: 'Payment processing failed due to an error at the bank.', source: 'gateway', step: 'payment_authorization', truth: 'infra' }, weight: 0.1 },
    { value: { code: 'SERVER_ERROR', reason: 'service_unavailable', description: 'The service is temporarily unavailable.', source: 'internal', step: 'payment_response', truth: 'infra' }, weight: 0.06 },
  ],
  wallet: [
    { value: { code: 'BAD_REQUEST_ERROR', reason: 'insufficient_funds', description: 'Wallet balance is too low for this transaction.', source: 'customer', step: 'payment_authorization', ...CUSTOMER }, weight: 0.46 },
    { value: { code: 'BAD_REQUEST_ERROR', reason: 'authentication_failed', description: 'Wallet authentication failed.', source: 'customer', step: 'payment_authentication', ...CUSTOMER }, weight: 0.21 },
    { value: { code: 'BAD_REQUEST_ERROR', reason: 'payment_timed_out', description: 'Payment was not completed on time.', source: 'customer', step: 'payment_authentication', ...CUSTOMER }, weight: 0.18 },
    { value: { code: 'GATEWAY_ERROR', reason: 'gateway_technical_error', description: 'Wallet provider returned an error.', source: 'gateway', step: 'payment_authorization', truth: 'infra' }, weight: 0.15 },
  ],
};

/**
 * What an issuer outage actually looks like on the wire.
 *
 * The failures that arrive during a real degradation are not uniformly
 * labelled `issuer_down` — that would make detection trivial and the injected
 * outage worthless as a test. A genuine outage is a mix: some clearly-labelled
 * issuer errors, a lot of unhelpful gateway errors, and Razorpay's `payment_failed`
 * shrug. The detector has to find the *cohort* signal, not read a label.
 */
export const OUTAGE_SHAPES: ReadonlyArray<Weighted<FailureShape>> = [
  { value: { code: 'GATEWAY_ERROR', reason: 'issuer_unavailable', description: 'The bank is currently unavailable. Please try again.', source: 'issuer', step: 'payment_authorization', truth: 'infra' }, weight: 0.26 },
  { value: { code: 'GATEWAY_ERROR', reason: 'gateway_technical_error', description: 'Payment processing failed due to an error at the bank.', source: 'gateway', step: 'payment_authorization', truth: 'infra' }, weight: 0.3 },
  { value: { code: 'GATEWAY_ERROR', reason: 'payment_failed', description: 'Payment failed.', source: 'gateway', step: 'payment_authorization', truth: 'infra' }, weight: 0.22 },
  { value: { code: 'SERVER_ERROR', reason: 'server_error', description: 'The bank reported an internal error.', source: 'bank', step: 'payment_authorization', truth: 'infra' }, weight: 0.14 },
  // A real outage window still contains ordinary customer failures. These are
  // ground-truth *idiosyncratic* even though they land inside the window, and
  // they are what stops precision from being free.
  { value: { code: 'BAD_REQUEST_ERROR', reason: 'insufficient_funds', description: 'Your account does not have enough balance.', source: 'customer', step: 'payment_authorization', ...CUSTOMER }, weight: 0.08 },
];

/** Adversarial payloads — deliberately unhelpful, but genuinely emitted. */
export const ADVERSARIAL_SHAPES: ReadonlyArray<Weighted<FailureShape>> = [
  { value: { code: 'BAD_REQUEST_ERROR', reason: 'payment_failed', description: 'Payment failed.', source: 'customer', step: 'payment_authorization', truth: 'customer' }, weight: 0.4 },
  { value: { code: 'SERVER_ERROR', reason: '', description: '', source: '', step: '', truth: 'customer' }, weight: 0.25 },
  { value: { code: '', reason: 'ERR_UNMAPPED_9001', description: 'Unrecognised downstream response', source: 'gateway', step: 'payment_response', truth: 'infra' }, weight: 0.2 },
  { value: { code: 'BAD_REQUEST_ERROR', reason: 'payment_failed', description: 'The payment could not be completed.', source: 'bank', step: 'payment_authorization', truth: 'infra' }, weight: 0.15 },
];

/** Share of failed customers who have already opted out of contact. */
export const OPT_OUT_RATE = 0.035;

/** Share of at-risk events belonging to a repeat-failure customer. */
export const REPEAT_CUSTOMER_RATE = 0.28;

export const SUBSCRIPTION_SHARE = 0.06;
