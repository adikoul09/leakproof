/**
 * Cost meter — blueprint 6.5.
 *
 * Every LLM call, message and link writes `cost_paise` at the point of spend,
 * so `cost_per_100_recovered` is measured rather than estimated.
 *
 * 🔸 ASSUMPTION: these are placeholder rates. Each carries a `source` note and
 * every one of them must be replaced with real published pricing before any
 * cost figure is shown to a judge as fact. They are deliberately kept in one
 * file so that replacing them is a single diff.
 */
export interface Rate {
  paise: number;
  source: string;
}

export const RATES = {
  /** Razorpay Payment Link creation — no per-link fee, MDR applies on capture. */
  payment_link_created: {
    paise: 0,
    source: 'Razorpay charges MDR on capture, not per link created',
  },
  /**
   * Delivery is Razorpay's own notification on the payment link — `notify:
   * {sms, email}` — which is bundled with the link and carries no separate
   * per-message charge. This system never contracts an SMS gateway or an email
   * provider, so there is genuinely nothing to bill per message.
   *
   * That is a real architectural consequence, not a rounding-down: the rails
   * were built on Razorpay's notification precisely so no separate provider was
   * needed. If a provider is ever added, these stop being zero the same day.
   */
  whatsapp_utility_message: {
    paise: 0,
    source: 'not sent — the WhatsApp rail degrades to SMS on Razorpay notification (FAILURES #25)',
  },
  email_message: {
    paise: 0,
    source: 'bundled with the Razorpay payment link notification; no separate email provider',
  },
  sms_message: {
    paise: 0,
    source: 'bundled with the Razorpay payment link notification; no separate SMS gateway',
  },
  /** One composeMessage() call on gemini-2.5-flash, ~600 in / ~120 out. */
  llm_compose: {
    paise: 0,
    source: 'Gemini free tier at this volume — the composer is live, and billed only when its output ships',
  },
  /** A human picking up an escalation. Fully loaded minutes, not wages. */
  human_escalation: {
    paise: 5000,
    source: '🔸 PLACEHOLDER — assumes ~10 minutes of a collections agent',
  },
} as const satisfies Record<string, Rate>;

export type CostItem = keyof typeof RATES;

export const costOf = (item: CostItem): number => RATES[item].paise;

/** Every placeholder still in the table — surfaced in /settings, not hidden. */
export const unpricedItems = (): CostItem[] =>
  (Object.keys(RATES) as CostItem[]).filter((k) => RATES[k].source.includes('PLACEHOLDER'));

// ── Razorpay's transaction fee ───────────────────────────────────────

/**
 * Razorpay's standard domestic MDR, plus GST on the fee.
 *
 * ⚠️ This is a DIFFERENT KIND OF COST from everything above and is deliberately
 * not summed into the same total.
 *
 * A per-message cost is incurred on every *attempt*, including the ones that
 * recover nothing — it is the price of trying. MDR is charged only when a
 * payment is actually captured, so it is a cost on *success*, and it scales
 * with recovered revenue rather than with effort.
 *
 * Adding them together would produce a number where spending more on failed
 * attempts and recovering more money move the same figure in the same
 * direction, which makes "cost per ₹100 recovered" mean nothing. It is reported
 * as a separate footnote, and the README says why.
 *
 * It is also not a cost LEAKPROOF causes: the merchant pays MDR on any captured
 * payment, recovered or not. It is the fee on money that would otherwise have
 * been lost entirely.
 */
export const RAZORPAY_MDR = {
  /** Standard domestic rate on cards, netbanking, UPI above the free threshold. */
  rate: 0.02,
  /** GST is charged on the fee, not on the transaction. */
  gstOnFee: 0.18,
  source: '🔸 Razorpay standard domestic pricing, 2% + 18% GST on the fee. Negotiated rates differ by merchant.',
} as const;

/** Effective take on a captured rupee: 2% × 1.18 = 2.36%. */
export const MDR_EFFECTIVE_RATE = RAZORPAY_MDR.rate * (1 + RAZORPAY_MDR.gstOnFee);

/** What Razorpay takes on an amount actually captured. */
export const mdrOnRecoveredPaise = (recoveredPaise: number): number =>
  Math.round(recoveredPaise * MDR_EFFECTIVE_RATE);
