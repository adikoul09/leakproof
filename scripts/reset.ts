/**
 * Wipe all pipeline data and start clean. Development only.
 *
 *   npm run db:reset -- --yes
 *
 * Refuses to run against NODE_ENV=production. The audit ledger's append-only
 * trigger is disabled for the truncate and re-enabled afterwards — the only
 * place in the codebase allowed to do that, and only for a full reset.
 */
import { config } from 'dotenv';
import postgres from 'postgres';

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

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('refusing to reset a production database');
  }
  if (!process.argv.includes('--yes')) {
    console.error('This deletes every row in the pipeline tables. Re-run with --yes.');
    process.exit(1);
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const sql = postgres(url, { max: 1 });

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
