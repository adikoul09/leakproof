/**
 * Seed the live policy and warm the bank-holiday cache.
 *
 *   npm run db:seed
 *
 * Idempotent: re-running republishes the same version rather than erroring.
 */
import { readFileSync } from 'node:fs';
import { config } from 'dotenv';

config({ path: '.env.local' });

async function main() {
  // Imported after dotenv so the db client sees DATABASE_URL.
  const { createDraft, getPolicy, publishPolicy } = await import('../src/core/policy/store');
  const { refreshHolidays } = await import('../src/core/policy/holidays');
  const { sql } = await import('../src/db/client');

  const yamlSource = readFileSync('policies/3.2.yaml', 'utf8');

  const existing = await getPolicy('3.2');
  if (!existing) {
    const created = await createDraft(yamlSource, 'seed');
    if (!created.ok) {
      console.error('policy 3.2 failed validation:');
      for (const i of created.issues) console.error(`  ${i.path || '(root)'}: ${i.message}`);
      process.exit(1);
    }
    console.log('created draft 3.2');
  } else {
    console.log(`policy 3.2 already present (status: ${existing.status})`);
  }

  const live = await publishPolicy('3.2');
  console.log(`policy ${live.version} is live (published ${live.publishedAt?.toISOString()})`);

  const year = new Date().getUTCFullYear();
  const holidays = await refreshHolidays([year, year + 1]);
  console.log(
    holidays.source === 'google_ics'
      ? `warmed ${holidays.upserted} holidays for ${holidays.years.join(', ')} — ${holidays.note}`
      : 'holiday source unreachable — cache left as-is (the gate still works, see FAILURES.md #5)',
  );

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
