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
  /** WhatsApp Cloud API business-initiated utility conversation, India. */
  whatsapp_utility_message: {
    paise: 14,
    source: '🔸 PLACEHOLDER — replace with Meta published utility rate for IN',
  },
  /** Transactional email. */
  email_message: {
    paise: 4,
    source: '🔸 PLACEHOLDER — replace with Resend published per-email pricing',
  },
  sms_message: {
    paise: 20,
    source: '🔸 PLACEHOLDER — replace with the chosen SMS gateway rate',
  },
  /** One composeMessage() call on gemini-2.5-flash, ~600 in / ~120 out. */
  llm_compose: {
    paise: 2,
    source: '🔸 PLACEHOLDER — replace with Gemini published per-token pricing',
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
