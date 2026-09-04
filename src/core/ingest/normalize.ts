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
  orderId: string | null;
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

/**
 * A signal that some at-risk payment has been recovered.
 *
 *  - `link_paid`     one of our recovery links was paid. `referenceId` is the
 *                    attempt UUID we set, so attribution is exact.
 *  - `payment_captured` a payment succeeded. It is almost never the same
 *                    payment id that failed — a retry creates a new one — so
 *                    the order id is what ties it back. This is the path that
 *                    detects *organic* recovery, including in the control arm,
 *                    which is the baseline the whole result rests on.
 */
export type RecoverySignal =
  | { kind: 'link_paid'; referenceId: string; amountPaise: number; at: Date }
  | { kind: 'payment_captured'; orderId: string | null; paymentId: string; amountPaise: number; at: Date }
  | { kind: 'subscription_charged'; subscriptionId: string; amountPaise: number; at: Date };

/**
 * A subscription that can no longer be charged.
 *
 * `amountPaise` is null when the webhook payload does not embed the plan —
 * verified against the live API, the subscription *create* response embeds
 * `plan` but the list endpoint does not, so neither can be assumed. The
 * ingestion job resolves it with a plan lookup when it is missing.
 */
export interface SubscriptionSignal {
  id: string;
  planId: string | null;
  quantity: number;
  amountPaise: number | null;
  currency: string;
  paymentMethod: string | null;
  status: string;
  totalCount: number | null;
  paidCount: number | null;
  remainingCount: number | null;
  authAttempts: number | null;
  customerId: string | null;
  customerEmail: string | null;
  customerContact: string | null;
  at: Date;
  /** Which webhook produced this — halted is terminal, pending is a warning. */
  reason: 'subscription_halted' | 'subscription_pending';
}

export interface NormalizedWebhook {
  /** What the webhook told us about a payment outcome, for cohort counters. */
  outcome: 'failed' | 'succeeded' | 'other';
  event: NormalizedEvent | null;
  customer: NormalizedCustomer | null;
  recovery: RecoverySignal | null;
  subscription: SubscriptionSignal | null;
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

  // A recovery link being paid is its own event shape.
  if (eventType === 'payment_link.paid') {
    const linkEntity = body?.payload?.payment_link?.entity;
    const paidPayment = body?.payload?.payment?.entity;
    const referenceId = linkEntity?.reference_id as string | undefined;
    if (referenceId) {
      return {
        outcome: 'other',
        event: null,
        customer: null,
        subscription: null,
        recovery: {
          kind: 'link_paid',
          referenceId,
          amountPaise: Number(paidPayment?.amount ?? linkEntity?.amount_paid ?? linkEntity?.amount ?? 0),
          at: fromUnix(paidPayment?.created_at ?? body?.created_at),
        },
      };
    }
  }

  // ── Subscriptions ─────────────────────────────────────────────────
  const subEntity = body?.payload?.subscription?.entity;
  if (subEntity && (eventType === 'subscription.halted' || eventType === 'subscription.pending')) {
    const quantity = Number(subEntity.quantity ?? 1);
    // The plan is embedded on some payloads and absent on others; take it when
    // it is there and let the caller resolve it when it is not.
    const embeddedAmount = subEntity?.plan?.item?.amount;
    return {
      outcome: 'failed',
      event: null,
      customer: null,
      recovery: null,
      subscription: {
        id: String(subEntity.id),
        planId: subEntity.plan_id ?? null,
        quantity,
        amountPaise:
          typeof embeddedAmount === 'number' ? embeddedAmount * quantity : null,
        currency: subEntity?.plan?.item?.currency ?? 'INR',
        paymentMethod: subEntity.payment_method ?? null,
        status: String(subEntity.status ?? 'unknown'),
        totalCount: subEntity.total_count ?? null,
        paidCount: subEntity.paid_count ?? null,
        remainingCount: subEntity.remaining_count ?? null,
        authAttempts: subEntity.auth_attempts ?? null,
        customerId: subEntity.customer_id ?? null,
        customerEmail: subEntity.customer_email ?? null,
        customerContact: subEntity.customer_contact ?? null,
        at: fromUnix(subEntity.halted_at ?? subEntity.current_end ?? body?.created_at),
        reason: eventType === 'subscription.halted' ? 'subscription_halted' : 'subscription_pending',
      },
    };
  }

  /**
   * A subscription charged successfully. This is how a *halted* subscription
   * recovers organically — the customer fixes their card and Razorpay's own
   * retry succeeds, with no involvement from us. Without it, organic recovery
   * on the subscription surface is invisible and its control arm reads zero,
   * which would inflate incrementality exactly as the missing order-id path
   * would have for payments.
   */
  if (subEntity && eventType === 'subscription.charged') {
    const paid = body?.payload?.payment?.entity;
    return {
      outcome: 'succeeded',
      event: null,
      customer: null,
      subscription: null,
      recovery: {
        kind: 'subscription_charged',
        subscriptionId: String(subEntity.id),
        amountPaise: Number(paid?.amount ?? 0),
        at: fromUnix(paid?.created_at ?? body?.created_at),
      },
    };
  }

  if (!eventType || !payment) {
    return { outcome: 'other', event: null, customer: null, recovery: null, subscription: null };
  }

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
    orderId: (payment?.order_id as string | undefined) ?? null,
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

  const recovery: RecoverySignal | null =
    outcome === 'succeeded'
      ? {
          kind: 'payment_captured',
          orderId: (payment?.order_id as string | undefined) ?? null,
          paymentId: String(payment.id),
          amountPaise,
          at: failedAt,
        }
      : null;

  return { outcome, event, customer, recovery, subscription: null };
}
