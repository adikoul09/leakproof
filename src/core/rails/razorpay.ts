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
    /** What Razorpay's own `Retry-After` header asked for, in ms. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'RazorpayError';
  }
}

function authHeader(): string {
  const token = Buffer.from(`${env.razorpayKeyId}:${env.razorpayKeySecret}`).toString('base64');
  return `Basic ${token}`;
}

/**
 * Adaptive pacing for Razorpay writes.
 *
 * Razorpay rate-limits link creation on a short token bucket: the 429 comes
 * back in ~95ms carrying `Retry-After: 2`. Two seconds. The queue's retry
 * ladder answered that with 8 minutes, then 25, then 2 hours, then gave up —
 * so a two-second cooldown killed the run at `create-payment-link` before it
 * ever reached `compose`, and 4,400 attempts executed 5 of themselves in six
 * hours. A backoff sized for an outage is the wrong instrument for a token
 * bucket. FAILURES.md #32.
 *
 * The fix has two halves. This half stops us provoking the limit at all:
 * writes are spaced by a shared interval that doubles on a 429 and decays on
 * success, so the process converges on Razorpay's real ceiling instead of
 * guessing one. `call()` below is the other half — it waits the Retry-After
 * out in-process rather than surfacing it to the queue.
 *
 * Process-local, which is the honest scope: one dev server, one worker. A
 * multi-instance deploy would need this in Redis beside the policy counters.
 */
const PACE_FLOOR_MS = 120;
const PACE_CEILING_MS = 4_000;
let paceMs = 250;
let nextWriteSlot = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reserves this caller's slot in the write stream and waits for it. */
async function pacedWriteSlot(): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextWriteSlot);
  nextWriteSlot = slot + paceMs;
  if (slot > now) await sleep(slot - now);
}

/**
 * How long we will absorb rate limiting inside the step before handing the
 * failure back to the queue. Bounded so a step cannot sit open indefinitely —
 * past this the durable retry is the right escalation, it just should not be
 * the *first* one.
 */
const RETRY_BUDGET_MS = 20_000;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const isWrite = (init?.method ?? 'GET').toUpperCase() !== 'GET';
  const deadline = Date.now() + RETRY_BUDGET_MS;

  for (let attempt = 0; ; attempt += 1) {
    if (isWrite) await pacedWriteSlot();
    try {
      const out = await callOnce<T>(path, init);
      // Decay slowly: a single success does not prove the limit has lifted.
      if (isWrite) paceMs = Math.max(PACE_FLOOR_MS, Math.round(paceMs * 0.9));
      return out;
    } catch (err) {
      if (!(err instanceof RazorpayError) || !err.retriable) throw err;
      if (err.status === 429 && isWrite) paceMs = Math.min(PACE_CEILING_MS, paceMs * 2);

      // Razorpay's own number when it gave one, otherwise a short exponential.
      // The jitter is load-bearing: without it every run 429'd in the same
      // second wakes in the same second and collides again.
      const base = err.retryAfterMs ?? Math.min(4_000, 250 * 2 ** attempt);
      const wait = base + Math.random() * 250;
      if (Date.now() + wait > deadline) throw err;
      await sleep(wait);
    }
  }
}

async function callOnce<T>(path: string, init?: RequestInit): Promise<T> {
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
    // Razorpay tells us how long to wait. Believing it is the whole fix.
    const header = Number(res.headers.get('retry-after'));
    const retryAfterMs =
      Number.isFinite(header) && header > 0 ? Math.min(30_000, header * 1000) : null;
    throw new RazorpayError(res.status, code, description, retriable, retryAfterMs);
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

export interface Order {
  id: string;
  amount: number;
  currency: string;
  receipt: string | null;
  status: string;
  attempts: number;
  created_at: number;
  notes?: Record<string, string>;
}

/**
 * Create a real test-mode order.
 *
 * Used by `POST /api/simulator/push-to-razorpay` to ground a subset of the
 * synthetic corpus in genuine Razorpay ids that resolve in the dashboard.
 *
 * What this does NOT do is manufacture a real decline. A payment is created by
 * the checkout flow, not by this API — server-to-server payment creation needs
 * separate account activation — so the failure payloads in a synthetic batch
 * are modelled on Razorpay's documented error taxonomy rather than harvested
 * from live declines. The README says so plainly; the alternative is a demo
 * that implies more than it did.
 */
export async function createOrder(req: {
  amountPaise: number;
  currency: string;
  receipt: string;
  notes?: Record<string, string>;
}): Promise<Order> {
  return call<Order>('/orders', {
    method: 'POST',
    body: JSON.stringify({
      amount: req.amountPaise,
      currency: req.currency,
      receipt: req.receipt.slice(0, 40), // Razorpay caps receipt at 40 chars
      ...(req.notes ? { notes: req.notes } : {}),
    }),
  });
}
