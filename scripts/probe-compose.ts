/**
 * Call composeMessage() against the real Gemini API and show what came back.
 *
 *   npm run compose:probe
 *   npm run compose:probe -- --rail mandate_repair
 *   npm run compose:probe -- --no-key      # prove the fallback still fires
 *
 * This is the end-to-end check that `used_fallback` means something: it prints
 * the composer that actually produced the body, the lint verdict, and the
 * token counts, so a claim that the LLM path is live is verifiable rather than
 * asserted.
 */
import { config } from 'dotenv';

config({ path: '.env.local' });

const arg = (n: string): string | null => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? null : process.argv[i + 1];
};

async function main() {
  if (process.argv.includes('--no-key')) delete process.env.GEMINI_API_KEY;

  const { composeMessage } = await import('../src/core/messaging/compose');
  const rail = (arg('rail') ?? 'upi_payment_link') as never;
  const runs = Number(arg('runs') ?? 3);

  console.log(`\nmodel: ${process.env.GEMINI_MODEL || 'gemini-2.5-flash'}`);
  console.log(`key:   ${process.env.GEMINI_API_KEY ? 'present' : 'ABSENT (fallback expected)'}`);
  console.log(`rail:  ${rail}\n`);

  let live = 0;
  for (let n = 1; n <= runs; n += 1) {
    const r = await composeMessage({
      rail,
      merchantName: process.env.MERCHANT_NAME || 'Kiraana Fresh',
      merchantDescriptor: process.env.MERCHANT_DESCRIPTOR || 'online grocery, Bengaluru',
      amountPaise: 129900,
      shortUrl: 'https://rzp.io/rzp/AbCdEf1',
      failureClass: 'n/a',
      channel: 'sms',
    });
    if (!r.usedFallback) live += 1;

    console.log(`── run ${n} ${'─'.repeat(56)}`);
    console.log(`  used_fallback : ${r.usedFallback}`);
    console.log(`  composer      : ${r.usedFallback ? 'static template' : r.model}`);
    if (r.fallbackReason) console.log(`  reason        : ${r.fallbackReason}`);
    if (r.lintFailures.length) console.log(`  lint          : ${r.lintFailures.join('; ')}`);
    if (r.rejectedBody !== null) console.log(`  model wrote   : ${JSON.stringify(r.rejectedBody)}`);
    console.log(`  tokens        : ${r.tokensIn ?? '—'} in / ${r.tokensOut ?? '—'} out`);
    console.log(`  latency       : ${r.latencyMs}ms`);
    console.log(`  prompt hash   : ${r.promptHash?.slice(0, 16) ?? '—'}…`);
    console.log(`  body (${String(r.body.length).padStart(3)} ch) : ${r.body}\n`);
  }

  console.log(`${live}/${runs} composed by the model, ${runs - live} fell back.`);
  process.exit(0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
