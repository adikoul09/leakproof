/**
 * Static message templates.
 *
 * These are the fallback the degradation ladder lands on when the LLM is
 * unavailable or its output fails the linter — and, for now, the only
 * composer. `composeMessage()` over Gemini slots in behind the same interface
 * next; the LLM boundary is deliberately narrow (blueprint 6.5): it receives an
 * already-approved action and returns copy, and it never decides whether to
 * contact, how much to offer, or when to send.
 *
 * Every template ends with an opt-out line. That is not decoration — it is the
 * mechanism behind the `customer_opt_out` stop condition, and a message without
 * it is a message the policy engine cannot honour.
 */
import type { Rail } from '@/core/routing/static-table';

export interface TemplateInput {
  merchantName: string;
  amountPaise: number;
  shortUrl: string;
  failureClass: string;
}

const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

const OPT_OUT = 'Reply STOP to opt out.';

/**
 * Keyed by rail, because what to say follows from what we are asking the
 * customer to do, not from what went wrong. Copy never states a reason we
 * cannot stand behind — "your bank declined this" is a claim about a third
 * party we may be wrong about.
 */
const BY_RAIL: Partial<Record<Rail, (i: TemplateInput) => string>> = {
  upi_payment_link: (i) =>
    `Your ${rupees(i.amountPaise)} payment to ${i.merchantName} did not go through. ` +
    `You can complete it by UPI here: ${i.shortUrl} — it takes a few seconds. ${OPT_OUT}`,

  netbanking_link: (i) =>
    `Your ${rupees(i.amountPaise)} payment to ${i.merchantName} did not go through. ` +
    `You can complete it by net banking here: ${i.shortUrl} ${OPT_OUT}`,

  card_retry_delayed_payday: (i) =>
    `A reminder from ${i.merchantName}: your ${rupees(i.amountPaise)} payment is still pending. ` +
    `You can complete it whenever suits you here: ${i.shortUrl} ${OPT_OUT}`,

  email_link: (i) =>
    `Your ${rupees(i.amountPaise)} payment to ${i.merchantName} is still outstanding. ` +
    `Complete it here: ${i.shortUrl} ${OPT_OUT}`,

  whatsapp_nudge: (i) =>
    `Hi — your ${rupees(i.amountPaise)} payment to ${i.merchantName} was not completed. ` +
    `Here is the link if you would still like to: ${i.shortUrl} ${OPT_OUT}`,

  mandate_repair: (i) =>
    `The auto-payment mandate for ${i.merchantName} needs to be set up again. ` +
    `You can fix it here: ${i.shortUrl} ${OPT_OUT}`,
};

export function renderTemplate(rail: Rail, input: TemplateInput): string {
  const fn = BY_RAIL[rail];
  if (fn) return fn(input);
  return (
    `Your ${rupees(input.amountPaise)} payment to ${input.merchantName} did not go through. ` +
    `You can complete it here: ${input.shortUrl} ${OPT_OUT}`
  );
}

export type Channel = 'email' | 'sms' | 'whatsapp' | 'none';

/** Which channel a rail delivers over. Drives the cost meter and the message row. */
export const RAIL_CHANNEL: Record<string, Channel> = {
  upi_payment_link: 'sms',
  netbanking_link: 'sms',
  card_retry_delayed_payday: 'sms',
  email_link: 'email',
  whatsapp_nudge: 'whatsapp',
  mandate_repair: 'email',
  human_escalation: 'none',
  do_nothing: 'none',
};

/**
 * The channel a rail can ACTUALLY deliver over right now.
 *
 * Delivery is Razorpay's own notification on the payment link — `notify: {sms,
 * email}` — which is what makes the recovery rail end to end without
 * provisioning a separate email or WhatsApp provider. Razorpay has no WhatsApp
 * notification, and Meta Cloud API credentials are not configured, so a rail
 * asking for WhatsApp has no delivery mechanism at all.
 *
 * That used to fail silently and expensively: `notify` was `{sms: false, email:
 * false}`, so the link was created, nobody was told about it, and the attempt
 * was still marked `action_sent` and billed for a WhatsApp message. On the demo
 * corpus that was 312 of 1,672 attempts — 19% of everything the system claimed
 * to have done. See FAILURES.md #23.
 *
 * Until a WhatsApp provider exists, those fall back to SMS: the same phone
 * number, a channel that actually delivers, recorded honestly as `sms` so the
 * cost meter and the Decision Trace both say what really happened.
 */
export function effectiveChannel(
  rail: string,
  whatsappConfigured: boolean,
): { channel: Channel; degradedFrom: Channel | null } {
  const intended = RAIL_CHANNEL[rail] ?? 'email';
  if (intended === 'whatsapp' && !whatsappConfigured) {
    return { channel: 'sms', degradedFrom: 'whatsapp' };
  }
  return { channel: intended, degradedFrom: null };
}
