/**
 * WhatsApp Cloud API (Meta Graph) — the `whatsapp_nudge` rail's delivery.
 *
 * ── Status ───────────────────────────────────────────────────────────────
 *
 * Written and tested; **not provisioned**. It needs `WHATSAPP_TOKEN` and
 * `WHATSAPP_PHONE_NUMBER_ID` from a Meta Business account with a verified
 * number and an approved message template — none of which can be created from
 * inside this repo. Until those exist, `effectiveChannel()` routes the rail to
 * SMS and says so, rather than reporting a send that never happened
 * (FAILURES.md #23).
 *
 * ── Why a template and not free text ─────────────────────────────────────
 *
 * A business-initiated WhatsApp conversation outside the 24-hour customer
 * service window MUST use a pre-approved template. Meta rejects free-form text
 * with error 131047. Payment recovery is business-initiated by definition — the
 * customer's last action was a failed payment, not a message to us — so every
 * send here is a template send, and the template name and its variables are the
 * only thing that can change per message.
 */


const GRAPH = 'https://graph.facebook.com/v21.0';

export class WhatsAppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retriable: boolean,
  ) {
    super(message);
    this.name = 'WhatsAppError';
  }
}

export interface WhatsAppConfig {
  token: string;
  phoneNumberId: string;
}

/** Null when either credential is missing — the caller degrades rather than throws. */
export function whatsappConfig(): WhatsAppConfig | null {
  // Read process.env directly rather than through lib/env, which is
  // `server-only` and would make this module untestable outside Next.
  const token = process.env.WHATSAPP_TOKEN || null;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || null;
  if (!token || !phoneNumberId) return null;
  return { token, phoneNumberId };
}

export const isWhatsappConfigured = (): boolean => whatsappConfig() !== null;

export interface TemplateSend {
  /** E.164 without the leading '+', which is what Graph expects. */
  to: string;
  templateName: string;
  languageCode?: string;
  /** Positional body variables, in template order. */
  variables: string[];
  /** Appended to the template's URL button, when it has one. */
  urlButtonSuffix?: string;
}

export interface SendResult {
  messageId: string;
  to: string;
}

/**
 * Meta wants the number without '+' or separators. A number we cannot normalise
 * is not sent to — silently mangling it would deliver to the wrong person.
 */
export function normalisePhone(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return null;
  // A bare Indian 10-digit number needs its country code.
  return digits.length === 10 ? `91${digits}` : digits;
}

export async function sendTemplate(req: TemplateSend): Promise<SendResult> {
  const cfg = whatsappConfig();
  if (!cfg) {
    throw new WhatsAppError(0, 'NOT_CONFIGURED', 'WhatsApp credentials are not set', false);
  }

  const to = normalisePhone(req.to);
  if (!to) {
    throw new WhatsAppError(0, 'BAD_PHONE', `unusable phone number: ${req.to}`, false);
  }

  const components: unknown[] = [];
  if (req.variables.length > 0) {
    components.push({
      type: 'body',
      parameters: req.variables.map((text) => ({ type: 'text', text })),
    });
  }
  if (req.urlButtonSuffix) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: req.urlButtonSuffix }],
    });
  }

  let res: Response;
  try {
    res = await fetch(`${GRAPH}/${cfg.phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'template',
        template: {
          name: req.templateName,
          language: { code: req.languageCode ?? 'en' },
          ...(components.length > 0 ? { components } : {}),
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    // A network failure is ours, never the customer's — it must not be recorded
    // as a failed contact, or the incrementality result absorbs our downtime.
    throw new WhatsAppError(0, 'NETWORK', `Graph unreachable: ${(err as Error).message}`, true);
  }

  const text = await res.text();
  if (!res.ok) {
    let code = 'UPSTREAM';
    let message = text.slice(0, 300);
    try {
      const body = JSON.parse(text) as { error?: { code?: number; message?: string; type?: string } };
      code = String(body.error?.code ?? body.error?.type ?? code);
      message = body.error?.message ?? message;
    } catch {
      /* non-JSON error body — keep the raw text */
    }
    // 5xx and 429 are worth retrying. 131047 (re-engagement required) and 132xxx
    // (template problems) are permanent for this message and must not spin.
    const retriable = res.status >= 500 || res.status === 429;
    throw new WhatsAppError(res.status, code, message, retriable);
  }

  const body = JSON.parse(text) as { messages?: Array<{ id: string }> };
  const messageId = body.messages?.[0]?.id;
  if (!messageId) {
    throw new WhatsAppError(res.status, 'NO_MESSAGE_ID', 'Graph accepted but returned no id', false);
  }
  return { messageId, to };
}

/**
 * A one-call health probe for /settings.
 *
 * Reads the phone number's own metadata, which is the cheapest authenticated
 * call that proves the token and the number id agree — and, unlike sending,
 * costs nothing and messages nobody.
 */
export async function checkWhatsappHealth(): Promise<{
  configured: boolean;
  ok: boolean;
  detail: string;
}> {
  const cfg = whatsappConfig();
  if (!cfg) {
    return {
      configured: false,
      ok: false,
      detail: 'WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are not set; the rail degrades to SMS',
    };
  }
  try {
    const res = await fetch(`${GRAPH}/${cfg.phoneNumberId}?fields=display_phone_number,quality_rating`, {
      headers: { authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok) return { configured: true, ok: false, detail: text.slice(0, 200) };
    const body = JSON.parse(text) as { display_phone_number?: string; quality_rating?: string };
    return {
      configured: true,
      ok: true,
      detail: `${body.display_phone_number ?? 'number'} · quality ${body.quality_rating ?? 'unknown'}`,
    };
  } catch (err) {
    return { configured: true, ok: false, detail: (err as Error).message };
  }
}
