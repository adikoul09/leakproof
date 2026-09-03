/**
 * Razorpay webhook payload → LEAKPROOF domain objects.
 *
 * Pure: takes the parsed payload, returns rows. No database, no clock. The
 * simulator's `/api/events/ingest` produces the same shapes, so the pipeline
 * downstream of here cannot tell synthetic events from real ones — which is
 * the point.
 */
import { amountBand, istHour } from '@/core/triage/config';
import { maskEmail, maskPhone, sha256 } from '@/lib/hash';

export type Surface = 'payment' | 'subscription' | 'invoice';

export interface NormalizedCustomer {
  id: string;
  phoneHash: string;
  phoneMasked: string;
  emailHash: string | null;
  emailMasked: string | null;
}

export interface NormalizedEvent {
  id: string;
  surface: Surface;
  customerId: string | null;
  amountPaise: number;
  currency: string;
  method: string | null;
  issuer: string | null;
  cardNetwork: string | null;
  amountBand: string;
  timeBucket: number;
  errCode: string | null;
  errDescription: string | null;
  errSource: string | null;
  errStep: string | null;
  errReason: string | null;
  isSynthetic: boolean;
  failedAt: Date;
}

export interface NormalizedWebhook {
  /** What the webhook told us about a payment outcome, for cohort counters. */
  outcome: 'failed' | 'succeeded' | 'other';
  event: NormalizedEvent | null;
  customer: NormalizedCustomer | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

/**
 * Razorpay does not hand back one tidy "issuer" field; where it lives depends
 * on the method. Netbanking puts a bank code on the payment, cards put an
 * issuer on the (sometimes expanded) card object, wallets name the wallet, and
 * UPI has no issuer at all beyond the handle. Falls through to acquirer_data.
 */
export function resolveIssuer(payment: Json): string | null {
  const method = payment?.method as string | undefined;
  if (method === 'netbanking') return payment?.bank ?? null;
  if (method === 'card') return payment?.card?.issuer ?? payment?.acquirer_data?.issuer ?? null;
  if (method === 'wallet') return payment?.wallet ?? null;
  if (method === 'upi') {
    // UPI handle suffix is the closest thing to an issuer: "meera@okhdfcbank".
    const vpa = (payment?.vpa as string | undefined) ?? '';
    const handle = vpa.split('@')[1];
    return handle ? handle.toUpperCase() : null;
  }
  return payment?.bank ?? payment?.acquirer_data?.issuer ?? null;
}

/** Razorpay `created_at` is unix seconds. */
export const fromUnix = (seconds: number | undefined | null): Date =>
  new Date((typeof seconds === 'number' ? seconds : Math.floor(Date.now() / 1000)) * 1000);

/**
 * Derive a stable customer id from contact details. Razorpay's own
 * `customer_id` is often absent on a failed payment, but the contact almost
 * always is — and hashing it means the identifier is reproducible across
 * events without ever storing the raw number.
 */
export function normalizeCustomer(payment: Json): NormalizedCustomer | null {
  const contact = (payment?.contact as string | undefined) ?? '';
  const email = (payment?.email as string | undefined) ?? '';
  if (!contact && !email) return null;

  const phoneHash = contact ? sha256(contact) : sha256(email);
  const explicit = payment?.customer_id as string | undefined;
  return {
    id: explicit ?? `cust_${phoneHash.slice(0, 20)}`,
    phoneHash,
    phoneMasked: contact ? maskPhone(contact) : '••••',
    emailHash: email ? sha256(email.toLowerCase()) : null,
    emailMasked: email ? maskEmail(email) : null,
  };
}

const FAILURE_EVENTS = new Set(['payment.failed']);
const SUCCESS_EVENTS = new Set(['payment.captured', 'payment.authorized']);

/**
 * Turn a Razorpay webhook body into what the pipeline needs.
 *
 * Successful payments are normalised too, but produce no `payment_events` row:
 * they exist only so the cohort decline rate has a denominator. Without them
 * every cohort reads 100% declined and the systemic test is meaningless.
 */
export function normalizeWebhook(body: Json): NormalizedWebhook {
  const eventType = body?.event as string | undefined;
  const payment = body?.payload?.payment?.entity;

  if (!eventType || !payment) return { outcome: 'other', event: null, customer: null };

  const outcome: NormalizedWebhook['outcome'] = FAILURE_EVENTS.has(eventType)
    ? 'failed'
    : SUCCESS_EVENTS.has(eventType)
      ? 'succeeded'
      : 'other';

  const customer = normalizeCustomer(payment);
  const failedAt = fromUnix(payment?.created_at ?? body?.created_at);
  const amountPaise = Number(payment?.amount ?? 0);

  const event: NormalizedEvent = {
    id: String(payment.id),
    surface: 'payment',
    customerId: customer?.id ?? null,
    amountPaise,
    currency: String(payment?.currency ?? 'INR'),
    method: payment?.method ?? null,
    issuer: resolveIssuer(payment),
    cardNetwork: payment?.card?.network ?? null,
    amountBand: amountBand(amountPaise),
    timeBucket: istHour(failedAt),
    errCode: payment?.error_code ?? null,
    errDescription: payment?.error_description ?? null,
    errSource: payment?.error_source ?? null,
    errStep: payment?.error_step ?? null,
    errReason: payment?.error_reason ?? null,
    isSynthetic: false,
    failedAt,
  };

  return { outcome, event, customer };
}
