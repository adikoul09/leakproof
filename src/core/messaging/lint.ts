/**
 * The gate between a language model and a customer being asked for money.
 *
 * The static templates were written to avoid a specific class of harm: copy
 * that states a reason we cannot stand behind. "Your bank declined this" is a
 * claim about a third party we may simply be wrong about, and a payment failure
 * has many causes the webhook does not distinguish. A model asked to write
 * warmly about a failed payment will reach for exactly that kind of
 * explanation, because it reads as helpful.
 *
 * So the model's output is not trusted. It is linted against the same rules the
 * templates were built to satisfy, and anything that fails falls back to the
 * template. The fallback is not an error path — it is the design. What the LLM
 * buys is better copy when it behaves, at no risk when it does not.
 *
 * Pure and dependency-free so every rule is testable without a network.
 */

export interface LintInput {
  body: string;
  shortUrl: string;
  merchantName: string;
  /** The exact opt-out sentence the policy engine relies on. */
  optOut: string;
  /**
   * Rendered amount as it must appear, e.g. "₹1,299.00". Omitted for rails
   * that do not ask for a sum — see `railStatesAmount`.
   */
  amountLabel?: string;
  maxChars?: number;
}

export interface LintResult {
  ok: boolean;
  /** Every rule that failed, not just the first — cheaper to diagnose. */
  failures: string[];
}

/**
 * Claims about *why* a payment failed. We do not know, and saying so
 * confidently is both wrong and the kind of thing a customer repeats to their
 * bank.
 */
const REASON_CLAIMS =
  /\b(declin\w*|insufficient\s+(funds|balance)|low\s+balance|expired\s+card|blocked|fraud\w*|bounced|rejected\s+by|your\s+bank|the\s+bank\s+(said|reported)|issuer)\b/i;

/**
 * Anything that sounds like an inducement. The policy engine owns discounts —
 * `max_discount_offered_pct` is a rule with a cap, and a model inventing "10%
 * off" would be writing policy from inside the copy layer.
 */
const OFFER_LANGUAGE = /\b(discount|coupon|cashback|voucher|waive[dr]?|waiver|refund|free\s+delivery)\b|\d+\s*%\s*off\b/i;

/** Unfilled scaffolding. A model that emits these has not been given enough. */
const PLACEHOLDERS = /\{\{|\}\}|\[[A-Za-z_ ]{2,}\]|<[a-z_]{2,}>|\bXXX+\b/;

/** Claims the payment already worked. It did not; that is why we are writing. */
const FALSE_SUCCESS = /\b(payment\s+(successful|received|confirmed|complete)|thank\s+you\s+for\s+your\s+payment)\b/i;

const URL_RE = /https?:\/\/[^\s,)]+/gi;

export function lintMessage(input: LintInput): LintResult {
  const { body, shortUrl, merchantName, optOut, amountLabel } = input;
  const maxChars = input.maxChars ?? 480;
  const failures: string[] = [];

  if (body.trim().length === 0) {
    return { ok: false, failures: ['empty message'] };
  }
  if (body.length > maxChars) {
    failures.push(`too long: ${body.length} chars, limit ${maxChars}`);
  }
  if (!body.includes(shortUrl)) {
    failures.push('does not contain the payment link');
  }
  if (!body.includes(optOut)) {
    failures.push('missing the exact opt-out sentence');
  }
  if (!body.includes(merchantName)) {
    failures.push('does not name the merchant');
  }
  if (amountLabel !== undefined && !body.includes(amountLabel)) {
    failures.push(`does not state the amount as ${amountLabel}`);
  }

  /**
   * Every URL must be the one we created. A model that helpfully adds a support
   * page, or mangles the link into a lookalike, has produced a phishing-shaped
   * message no matter how good the intent.
   */
  const urls = body.match(URL_RE) ?? [];
  const foreign = urls.filter((u) => u.replace(/[.,)]+$/, '') !== shortUrl);
  if (foreign.length > 0) {
    failures.push(`contains a URL that is not the payment link: ${foreign[0]}`);
  }

  if (REASON_CLAIMS.test(body)) {
    failures.push(`states a reason for the failure we cannot stand behind: ${match(REASON_CLAIMS, body)}`);
  }
  if (OFFER_LANGUAGE.test(body)) {
    failures.push(`offers an inducement the policy engine did not authorise: ${match(OFFER_LANGUAGE, body)}`);
  }
  if (PLACEHOLDERS.test(body)) {
    failures.push(`contains an unfilled placeholder: ${match(PLACEHOLDERS, body)}`);
  }
  if (FALSE_SUCCESS.test(body)) {
    failures.push(`claims the payment succeeded: ${match(FALSE_SUCCESS, body)}`);
  }

  return { ok: failures.length === 0, failures };
}

const match = (re: RegExp, s: string): string => s.match(re)?.[0] ?? '?';
