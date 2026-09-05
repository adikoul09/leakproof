/**
 * Wipe all pipeline data and start clean.
 *
 *   npm run db:reset -- --yes
 *
 * ⚠️ `--yes` is not the safety control and never was. This project has one Neon
 * database and `.env.local` points at the same one the deployed app reads, so
 * the old `NODE_ENV === 'production'` guard tested the wrong thing entirely: a
 * laptop shell aimed at the live database still has NODE_ENV unset. The real
 * control is the typed confirmation — see `lib/confirm-destructive.ts`.
 *
 * The audit ledger's append-only trigger is disabled for the truncate and
 * re-enabled afterwards — the only place in the codebase allowed to do that,
 * and only for a full reset.
 */
import { config } from 'dotenv';
import postgres from 'postgres';

import { confirmDestructive } from './lib/confirm-destructive';

config({ path: '.env.local' });

const TABLES = [
  'messages',
  'recovery_attempts',
  'policy_evaluations',
  'arm_assignments',
  'classifications',
  'payment_events',
  'customers',
  'webhook_receipts',
  'cohort_counters',
  'cohort_baselines',
  'outage_windows',
  'metric_snapshots',
  'replay_runs',
  'failed_jobs',
  'bandit_arms',
  'breaker_state',
  'audit_ledger',
  'unmatched_recoveries',
  'synthetic_batches',
];

/** Named in the prompt because losing these is losing the demo. */
const HEADLINE = ['payment_events', 'arm_assignments', 'audit_ledger'];

async function main() {
  if (!process.argv.includes('--yes')) {
    console.error('This deletes every row in the pipeline tables. Re-run with --yes.');
    process.exit(1);
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const sql = postgres(url, { max: 1 });

  /**
   * Counted before the prompt, and read-only. "43,955 receipts" is a number
   * someone can decide against; "every row in the pipeline tables" is a phrase
   * they skim. The whole point of the prompt is that it can be reconsidered.
   */
  const counts = await Promise.all(
    HEADLINE.map(async (t) => {
      const [row] = await sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${t}`);
      return `${row.n.toLocaleString('en-IN')} ${t}`;
    }),
  );

  await confirmDestructive({
    action: `delete every row in ${TABLES.length} tables — including ${counts.join(', ')}`,
    url,
    forceFlag: '--force',
  });

  await sql`alter table audit_ledger disable trigger audit_ledger_no_update`;
  await sql.unsafe(`truncate ${TABLES.join(', ')} restart identity cascade`);
  await sql`alter table audit_ledger enable trigger audit_ledger_no_update`;

  console.log(`truncated ${TABLES.length} tables`);
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
