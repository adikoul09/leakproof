/**
 * `composeMessage()` — Gemini first, static template as the safety net.
 *
 * Blueprint 6.5's LLM boundary, and it is deliberately narrow: this function
 * receives an action the policy engine has already approved and returns copy.
 * It never decides whether to contact, what to offer, or when to send. Nothing
 * it returns can change a decision — the worst a bad generation can do is fail
 * the linter and be replaced by the template.
 *
 * Three ways to end up on the fallback, all recorded distinctly because they
 * mean different things to whoever is reading the trace:
 *
 *   not_configured  no GEMINI_API_KEY — the composer never ran
 *   llm_error       timeout, HTTP error, safety block, empty candidate
 *   lint_failed     the model answered and the answer was not shippable
 *
 * The third is the interesting one, and it is why `used_fallback` is worth
 * having on every message row: it is the measurable rate at which the model
 * writes something we will not send.
 */
/*
 * No `server-only` here, and none in `llm/gemini.ts` either. Both are
 * server-side modules, but "server" includes `node --test` and the CLI probe
 * that proves this path actually reaches Gemini — marking them would make the
 * composer unverifiable outside a running Next server, which is how the
 * simulator store and the ledger canonicaliser each had to be unpicked before.
 */
import { GeminiError, generateText } from '@/core/llm/gemini';
import { lintMessage } from './lint';
import { OPT_OUT, railStatesAmount, renderTemplate } from './templates';
import { sha256 } from '@/lib/hash';
import type { Rail } from '@/core/routing/static-table';

export interface ComposeInput {
  rail: Rail;
  merchantName: string;
  merchantDescriptor: string;
  amountPaise: number;
  shortUrl: string;
  failureClass: string;
  /** Channel actually carrying it — SMS wants shorter copy than email. */
  channel: 'sms' | 'email' | 'whatsapp' | 'none';
}

export interface ComposedMessage {
  body: string;
  usedFallback: boolean;
  /** `null` when the model's own output was shipped. */
  fallbackReason: string | null;
  model: string | null;
  promptHash: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number;
  /** Lint failures, when there were any. Kept for the trace even on success. */
  lintFailures: string[];
  /**
   * What the model actually wrote, when the linter refused it.
   *
   * Without this a rejection is unreadable: the trace shows the template body
   * and a list of rules, with no way to see the copy that broke them. "The
   * model wrote this and we declined to send it" is the whole point of having
   * a linter, so it should be inspectable.
   */
  rejectedBody: string | null;
}

const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

const SYSTEM = `You write short payment-reminder messages for an Indian merchant.

You are given a payment that failed and a link the customer can use to complete it. Write the message the customer receives.

Rules, all of them hard:
- Never state or guess WHY the payment failed. You do not know. Do not mention banks, cards, issuers, balances, declines, expiry or fraud. "did not go through" is the strongest phrasing available to you.
- Never offer a discount, refund, coupon, cashback or any inducement. You do not have authority to offer anything.
- Never claim the payment succeeded.
- Include the payment link exactly as given, once. Never invent or add any other URL.
- Include the amount exactly as given, and the merchant name exactly as given.
- End with the opt-out sentence exactly as given, as the final sentence.
- Plain text. No markdown, no placeholders, no square brackets, no subject line.
- Under 400 characters, warm and plain. Indian English. Do not be pushy.

Return only the message text.`;

function buildPrompt(i: ComposeInput): string {
  const statesAmount = railStatesAmount(i.rail);
  return [
    `Merchant: ${i.merchantName} (${i.merchantDescriptor})`,
    statesAmount
      ? `Amount: ${rupees(i.amountPaise)}`
      : 'Amount: do not quote any amount — this is a mandate re-authorisation, not a charge.',
    statesAmount
      ? 'Intent: ask the customer to complete a one-off payment that did not go through.'
      : 'Intent: ask the customer to set up their recurring auto-payment mandate again.',
    `Payment link: ${i.shortUrl}`,
    `Channel: ${i.channel}`,
    `Opt-out sentence to end with, verbatim: ${OPT_OUT}`,
    '',
    'Write the message.',
  ].join('\n');
}

export async function composeMessage(input: ComposeInput): Promise<ComposedMessage> {
  const fallback = (reason: string, extra: Partial<ComposedMessage> = {}): ComposedMessage => ({
    body: renderTemplate(input.rail, {
      merchantName: input.merchantName,
      amountPaise: input.amountPaise,
      shortUrl: input.shortUrl,
      failureClass: input.failureClass,
    }),
    usedFallback: true,
    fallbackReason: reason,
    model: null,
    promptHash: null,
    tokensIn: null,
    tokensOut: null,
    latencyMs: 0,
    lintFailures: [],
    rejectedBody: null,
    ...extra,
  });

  const apiKey = process.env.GEMINI_API_KEY || null;
  if (!apiKey) return fallback('not_configured: GEMINI_API_KEY is not set');

  const prompt = buildPrompt(input);
  // Hashed, never stored raw: the prompt carries the payment link and the
  // amount. The hash is what makes a generation reproducible-by-comparison in
  // the Decision Trace without putting customer data in the ledger.
  const promptHash = sha256(`${SYSTEM}\n---\n${prompt}`);
  const model = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

  let result;
  try {
    result = await generateText({
      apiKey,
      model,
      systemInstruction: SYSTEM,
      prompt,
      timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 15000),
      maxOutputTokens: 4096,
      temperature: 0.4,
    });
  } catch (err) {
    const e = err as GeminiError;
    return fallback(`llm_error: ${e.kind ?? 'unknown'} — ${e.message}`, { promptHash, model });
  }

  // Models like to wrap prose in quotes or a code fence when asked for "only
  // the text". Strip that before linting rather than failing a message that is
  // otherwise perfect.
  const body = result.text
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/\n?```$/, '')
    .replace(/^["']|["']$/g, '')
    .trim();

  const lint = lintMessage({
    body,
    shortUrl: input.shortUrl,
    merchantName: input.merchantName,
    optOut: OPT_OUT,
    amountLabel: railStatesAmount(input.rail) ? rupees(input.amountPaise) : undefined,
    maxChars: input.channel === 'sms' ? 480 : 700,
  });

  if (!lint.ok) {
    return fallback(`lint_failed: ${lint.failures.join('; ')}`, {
      promptHash,
      model,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      latencyMs: result.latencyMs,
      lintFailures: lint.failures,
      rejectedBody: body.slice(0, 600),
    });
  }

  return {
    body,
    usedFallback: false,
    fallbackReason: null,
    model: result.model,
    promptHash,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    latencyMs: result.latencyMs,
    lintFailures: [],
    rejectedBody: null,
  };
}
