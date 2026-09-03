/**
 * Evaluate the live policy against a real event and print the trace.
 *
 *   npm run gate                 # picks the most recent at-risk event
 *   npm run gate -- pay_TEST0001 # a specific one
 *   npm run gate -- pay_X --at 2026-09-04T22:00:00+05:30 --discount 5
 *
 * The same code path recovery.plan will use. Useful for eyeballing why a given
 * event was allowed, blocked or deferred without going through the UI.
 */
import { config } from 'dotenv';

config({ path: '.env.local' });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const { desc } = await import('drizzle-orm');
  const { db, sql } = await import('../src/db/client');
  const { paymentEvents } = await import('../src/db/schema');
  const { getLivePolicy } = await import('../src/core/policy/store');
  const { buildPolicyContext } = await import('../src/core/policy/context');
  const { evaluatePolicy } = await import('../src/core/policy/evaluate');

  const live = await getLivePolicy();
  if (!live) throw new Error('no live policy — run `npm run db:seed` first');

  let eventId = process.argv[2]?.startsWith('--') ? undefined : process.argv[2];
  if (!eventId) {
    const [row] = await db
      .select({ id: paymentEvents.id })
      .from(paymentEvents)
      .orderBy(desc(paymentEvents.failedAt))
      .limit(1);
    if (!row) throw new Error('no payment events in the database');
    eventId = row.id;
  }

  const at = arg('at') ? new Date(arg('at')!) : new Date();
  const discount = Number(arg('discount') ?? 0);

  const { context, breakerScope } = await buildPolicyContext(eventId, live.policy, at, discount);
  const decision = evaluatePolicy(live.policy, context);

  console.log(`\nevent      ${eventId}`);
  console.log(`policy     v${live.version} (${live.status})`);
  console.log(`breaker    ${breakerScope} → ${context.breakerOpen ? 'OPEN' : 'closed'}`);
  console.log(`evaluated  ${at.toISOString()}\n`);

  const mark = (p: boolean) => (p ? '✓' : '✗');
  for (const r of decision.rulesTrace) {
    console.log(`  ${mark(r.pass)} ${r.rule.padEnd(36)} expected ${String(r.expected).padEnd(34)} actual ${r.actual}`);
  }

  console.log(`\n  → ${decision.result.toUpperCase()}  ${decision.gateResult}`);
  for (const reason of decision.reasons) console.log(`    ${reason}`);
  console.log();

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
