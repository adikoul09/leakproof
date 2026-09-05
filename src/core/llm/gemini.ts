/**
 * Minimal Gemini client — REST, no SDK.
 *
 * One call, one shape, a hard timeout. The SDK would add a dependency and a
 * retry policy of its own; this path already sits inside an Inngest step that
 * owns retries, and a second layer of them underneath would multiply the
 * latency budget without telling anyone.
 *
 * Everything here is failure-tolerant by design: the caller's contract is that
 * a thrown error means "use the template", so the errors are typed rather than
 * swallowed.
 */
export interface GeminiResult {
  text: string;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number;
  finishReason: string | null;
}

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly kind: 'timeout' | 'http' | 'empty' | 'blocked' | 'network',
  ) {
    super(message);
    this.name = 'GeminiError';
  }
}

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface GeminiOptions {
  apiKey: string;
  model: string;
  systemInstruction: string;
  prompt: string;
  /**
   * Hard ceiling on the whole call. A recovery message is worth a couple of
   * seconds and no more: the customer is already waiting, the Inngest step
   * holds a slot while this runs, and the fallback is a perfectly good message.
   */
  timeoutMs?: number;
  maxOutputTokens?: number;
  temperature?: number;
  /**
   * Only 2.5-era models accept this. Gemini 3.x rejects the whole request with
   * INVALID_ARGUMENT if it is present at all, so it is opt-in rather than a
   * default — an unsupported knob that fails closed would silently route every
   * message to the fallback.
   */
  thinkingBudget?: number;
}

export async function generateText(opts: GeminiOptions): Promise<GeminiResult> {
  /**
   * 15s. Gemini 3.x reasons before answering and the budget cannot be set to
   * zero, so a first token can be many seconds away; 4s and then 8s both timed
   * out more often than not.
   * Nothing is waiting on this synchronously — the customer already has the
   * payment link; this is the covering note — so the right trade is to give
   * the model room and keep the fallback for when it still does not answer.
   */
  const timeoutMs = opts.timeoutMs ?? 15000;
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${ENDPOINT}/${opts.model}:generateContent`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': opts.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: opts.systemInstruction }] },
        contents: [{ role: 'user', parts: [{ text: opts.prompt }] }],
        generationConfig: {
          temperature: opts.temperature ?? 0.4,
          /**
           * Counts thinking tokens too on 3.x, and thinking dominates. At 200
           * the model spent the whole budget reasoning and returned 3 tokens.
           * At 1024 it wrote a good message and was cut off mid-word at "Reply
           * STOP to opt" — a truncation the linter caught, but only because the
           * opt-out sentence is a required rule. 4096 leaves room for both.
           */
          maxOutputTokens: opts.maxOutputTokens ?? 4096,
          ...(opts.thinkingBudget === undefined
            ? {}
            : { thinkingConfig: { thinkingBudget: opts.thinkingBudget } }),
        },
      }),
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = (err as Error)?.name === 'AbortError';
    throw new GeminiError(
      aborted ? `timed out after ${timeoutMs}ms` : `network error: ${(err as Error).message}`,
      aborted ? 'timeout' : 'network',
    );
  }
  clearTimeout(timer);

  const raw = await res.text();
  if (!res.ok) {
    // Body truncated: it can carry the prompt back, and this string ends up in
    // a ledger receipt and a log line.
    throw new GeminiError(`HTTP ${res.status}: ${raw.slice(0, 200)}`, 'http');
  }

  let body: {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; thought?: boolean }> };
      finishReason?: string;
    }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    promptFeedback?: { blockReason?: string };
  };
  try {
    body = JSON.parse(raw);
  } catch {
    throw new GeminiError('response was not JSON', 'http');
  }

  if (body.promptFeedback?.blockReason) {
    throw new GeminiError(`blocked: ${body.promptFeedback.blockReason}`, 'blocked');
  }

  const candidate = body.candidates?.[0];
  /**
   * Reasoning parts are marked `thought: true` and are NOT the answer. Joining
   * every part blindly would put the model's internal deliberation into a
   * message addressed to a customer — the linter would very likely reject it,
   * but relying on the linter to catch that is the wrong place to stand.
   */
  const text =
    candidate?.content?.parts
      ?.filter((p) => p.thought !== true)
      .map((p) => p.text ?? '')
      .join('')
      .trim() ?? '';
  if (!text) {
    const reason = candidate?.finishReason ?? 'none';
    throw new GeminiError(
      reason === 'MAX_TOKENS'
        ? 'ran out of output budget before writing an answer (raise maxOutputTokens)'
        : `no text in response (finishReason=${reason})`,
      'empty',
    );
  }

  return {
    text,
    model: opts.model,
    tokensIn: body.usageMetadata?.promptTokenCount ?? null,
    tokensOut: body.usageMetadata?.candidatesTokenCount ?? null,
    latencyMs: Date.now() - started,
    finishReason: candidate?.finishReason ?? null,
  };
}
