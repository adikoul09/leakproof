/**
 * Register (or re-point) the Razorpay webhook at the live deployment.
 *
 *   npm run webhook:register -- https://leakproof.vercel.app
 *   npm run webhook:register -- --list
 *
 * Uses RAZORPAY_WEBHOOK_SECRET from .env.local as the signing secret, so the
 * value the deployment verifies against and the value Razorpay signs with are
 * the same one by construction. No secret is printed.
 *
 * Webhook management is not available on every Razorpay account's API keys. If
 * the call is refused, the script says exactly what to enter in the dashboard
 * instead rather than failing silently.
 */
import { config } from 'dotenv';

config({ path: '.env.local' });

/** Everything the ingest route knows how to handle. */
const EVENTS = [
  'payment.failed',
  'payment.captured',
  'payment.authorized',
  'payment_link.paid',
  'subscription.charged',
  'subscription.halted',
  'subscription.pending',
  'refund.created',
] as const;

const API = 'https://api.razorpay.com/v1/webhooks';

async function main() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!keyId || !keySecret) throw new Error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET missing');
  if (!secret) throw new Error('RAZORPAY_WEBHOOK_SECRET missing — the route would reject every delivery');

  const auth = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const listOnly = process.argv.includes('--list');
  const base = process.argv.find((a) => a.startsWith('https://'));

  const existing = await fetch(API, { headers: { authorization: auth } });
  const body = await existing.text();
  if (!existing.ok) {
    console.error(`\ncould not list webhooks (HTTP ${existing.status}).`);
    console.error(body.slice(0, 400));
    console.error(dashboardFallback(base));
    process.exit(2);
  }

  const items = (JSON.parse(body).items ?? []) as Array<{ id: string; url: string; active: boolean }>;
  console.log(`\n${items.length} webhook(s) currently registered:`);
  for (const w of items) console.log(`  ${w.id}  ${w.active ? 'active ' : 'paused '}  ${w.url}`);

  if (listOnly) return;
  if (!base) {
    console.error('\npass the live origin, e.g. https://leakproof.vercel.app');
    process.exit(1);
  }

  const url = `${base.replace(/\/$/, '')}/api/webhooks/razorpay`;
  const already = items.find((w) => w.url === url);
  const target = already ? `${API}/${already.id}` : API;

  const res = await fetch(target, {
    method: already ? 'PATCH' : 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      url,
      secret,
      events: Object.fromEntries(EVENTS.map((e) => [e, true])),
    }),
  });
  const out = await res.text();

  if (!res.ok) {
    console.error(`\n${already ? 'update' : 'create'} failed (HTTP ${res.status}):`);
    console.error(out.slice(0, 400));
    console.error(dashboardFallback(base));
    process.exit(2);
  }

  console.log(`\n${already ? 'updated' : 'created'}: ${url}`);
  console.log(`  events: ${EVENTS.join(', ')}`);
  console.log('  secret: taken from RAZORPAY_WEBHOOK_SECRET (not printed)');
  console.log('\nSend a test event from the Razorpay dashboard, then check the ledger for the receipt.');
}

function dashboardFallback(base: string | undefined): string {
  const url = base ? `${base.replace(/\/$/, '')}/api/webhooks/razorpay` : '<live-url>/api/webhooks/razorpay';
  return [
    '',
    'Webhook management may not be enabled on these API keys. Add it by hand:',
    '  Razorpay Dashboard → Account & Settings → Webhooks → Add New Webhook',
    `  URL     ${url}`,
    '  Secret  the RAZORPAY_WEBHOOK_SECRET value in .env.local (same one, or the route rejects every delivery)',
    `  Events  ${EVENTS.join(', ')}`,
  ].join('\n');
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
