/**
 * Razorpay client — the one place that talks to Razorpay's REST API.
 *
 * Hand-rolled over fetch rather than the SDK: the surface needed is two
 * endpoints, and a thin client means the timeout, the error envelope and the
 * retry decision are all visible here rather than buried in a wrapper.
 */
import { env } from '@/lib/env';

const BASE = 'https://api.razorpay.com/v1';

export class RazorpayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retriable: boolean,
  ) {
    super(message);
    this.name = 'RazorpayError';
  }
}

function authHeader(): string {
  const token = Buffer.from(`${env.razorpayKeyId}:${env.razorpayKeySecret}`).toString('base64');
  return `Basic ${token}`;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        authorization: authHeader(),
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    // Network failure or timeout: retriable, and never counted as a customer
    // failure — see the degradation ladder in the README.
    throw new RazorpayError(0, 'NETWORK', `Razorpay unreachable: ${(err as Error).message}`, true);
  }

  const text = await res.text();
  if (!res.ok) {
    let code = 'UPSTREAM';
    let description = text.slice(0, 300);
    try {
      const body = JSON.parse(text) as { error?: { code?: string; description?: string } };
      code = body.error?.code ?? code;
      description = body.error?.description ?? description;
    } catch {
      /* non-JSON error body — keep the raw text */
    }
    // 5xx and 429 are worth retrying; a 4xx means we sent something wrong.
    const retriable = res.status >= 500 || res.status === 429;
    throw new RazorpayError(res.status, code, description, retriable);
  }

  return JSON.parse(text) as T;
}

export interface PaymentLinkRequest {
  amountPaise: number;
  currency: string;
  description: string;
  /** Razorpay notifies the customer directly — no separate email provider. */
  notify: { sms: boolean; email: boolean };
  customer?: { name?: string; email?: string; contact?: string };
  referenceId?: string;
  callbackUrl?: string;
  expireBy?: Date;
  notes?: Record<string, string>;
}

export interface PaymentLink {
  id: string;
  short_url: string;
  status: string;
  amount: number;
  reference_id?: string;
}

/** Look up a link by the reference_id we set on it. */
export async function findPaymentLinkByReference(referenceId: string): Promise<PaymentLink | null> {
  const res = await call<{ payment_links: PaymentLink[] }>(
    `/payment_links?reference_id=${encodeURIComponent(referenceId)}`,
  );
  return res.payment_links?.[0] ?? null;
}

/**
 * Create a link, idempotently.
 *
 * `reference_id` is globally unique per Razorpay account, which makes it a
 * free idempotency key: if this attempt already produced a link, Razorpay
 * refuses the duplicate and we fetch the original rather than creating a
 * second one or failing. A customer must never receive two links for the same
 * attempt, and an attempt must never be marked failed because it already
 * succeeded.
 */
export async function createPaymentLink(req: PaymentLinkRequest): Promise<PaymentLink> {
  try {
    return await createPaymentLinkRaw(req);
  } catch (err) {
    const isDuplicate =
      err instanceof RazorpayError && /reference_id.*already exists/i.test(err.message);
    if (isDuplicate && req.referenceId) {
      const existing = await findPaymentLinkByReference(req.referenceId);
      if (existing) return existing;
    }
    throw err;
  }
}

async function createPaymentLinkRaw(req: PaymentLinkRequest): Promise<PaymentLink> {
  return call<PaymentLink>('/payment_links', {
    method: 'POST',
    body: JSON.stringify({
      amount: req.amountPaise,
      currency: req.currency,
      description: req.description,
      // Razorpay's own notification channels. This is why the rail is
      // end-to-end without Resend or WhatsApp provisioned.
      notify: { sms: req.notify.sms, email: req.notify.email },
      reminder_enable: false, // LEAKPROOF owns follow-up cadence, not Razorpay
      ...(req.customer ? { customer: req.customer } : {}),
      ...(req.referenceId ? { reference_id: req.referenceId } : {}),
      ...(req.callbackUrl ? { callback_url: req.callbackUrl, callback_method: 'get' } : {}),
      ...(req.expireBy ? { expire_by: Math.floor(req.expireBy.getTime() / 1000) } : {}),
      ...(req.notes ? { notes: req.notes } : {}),
    }),
  });
}

export interface Plan {
  id: string;
  period: string;
  interval: number;
  item: { amount: number; currency: string; name?: string };
}

/**
 * Fetch a plan to resolve a subscription's amount.
 *
 * Needed because the subscription entity only *sometimes* embeds its plan: the
 * create response does, the list endpoint does not. Verified against the live
 * test-mode API rather than assumed, so the caller tries the embedded plan
 * first and falls back here.
 */
export async function fetchPlan(planId: string): Promise<Plan> {
  return call<Plan>(`/plans/${encodeURIComponent(planId)}`);
}

export interface Downtime {
  id: string;
  method: string;
  begin: number;
  end: number | null;
  status: string;
  severity: string;
  instrument: Record<string, string>;
}

/**
 * `GET /v1/payments/downtimes` — plural. The singular form routes to
 * `/payments/:id` and returns a confusing 400. See FAILURES.md #6.
 */
export async function listDowntimes(): Promise<Downtime[]> {
  const res = await call<{ items: Downtime[] }>('/payments/downtimes');
  return res.items ?? [];
}
