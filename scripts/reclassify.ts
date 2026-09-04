/**
 * Re-classify a historical corpus in place.
 *
 *   npm run reclassify -- --dry-run
 *   npm run reclassify -- --batch <uuid>
 *
 * Classifications already in the table were produced by whatever code was live
 * when each event was ingested. After a change to the classifier — the cohort
 * window fix in FAILURES.md #20, say — they are stale, and every number
 * computed from them understates or overstates the current detector.
 *
 * Re-queueing `event.ready_for_triage` would fix that but also re-trigger
 * assign → plan → execute, minting a second recovery attempt for every event.
 * This walks the corpus in memory instead and writes only `classifications`.
 *
 * It is not a second implementation of anything: it hydrates a
 * `MemoryCohortStore` from the counter rows the live system wrote, and calls
 * the same `classify()` the pipeline calls. `cohort-window.test.ts` asserts the
 * memory store's window matches the SQL one on both bounds.
 */
import { config } from 'dotenv';

config({ path: '.env.local' });

const flag = (n: string) => process.argv.includes(`--${n}`);
const arg = (n: string): string | null => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? null : process.argv[i + 1];
};

async function main() {
  const { and, eq, sql } = await import('drizzle-orm');
  const { db, sql: raw } = await import('../src/db/client');
  const { classifications, cohortCounters, paymentEvents } = await import('../src/db/schema');
  const { classify, cohortDim, cohortKey } = await import('../src/core/triage/classifier');
  const { MemoryCohortStore } = await import('../src/core/triage/memory-cohort-store');

  const batchId = arg('batch');
  const dryRun = flag('dry-run');

  const events = await db
    .select({
      id: paymentEvents.id,
      amountPaise: paymentEvents.amountPaise,
      method: paymentEvents.method,
      issuer: paymentEvents.issuer,
      failedAt: paymentEvents.failedAt,
      errCode: paymentEvents.errCode,
      errDescription: paymentEvents.errDescription,
      errSource: paymentEvents.errSource,
      errStep: paymentEvents.errStep,
      errReason: paymentEvents.errReason,
      currentKind: classifications.kind,
      currentClass: classifications.failureClass,
      currentN: classifications.cohortN,
    })
    .from(paymentEvents)
    .leftJoin(classifications, eq(classifications.eventId, paymentEvents.id))
    .where(batchId ? eq(paymentEvents.batchId, batchId) : undefined)
    .orderBy(paymentEvents.failedAt);

  if (events.length === 0) {
    console.log('no events to re-classify');
    await raw.end();
    return;
  }

  const counters = await db.select().from(cohortCounters);
  const store = new MemoryCohortStore();
  for (const c of counters) {
    store.seedBucket(c.cohortDim, c.bucketStart.getTime(), c.nTotal, c.nFailed);
  }

  console.log(`\nre-classifying ${events.length} events against ${counters.length} counter buckets`);
  console.log(`  ${dryRun ? 'DRY RUN — nothing will be written' : 'writing classifications'}\n`);

  let changedKind = 0;
  let changedClass = 0;
  let nShrank = 0;
  const rows: Array<{
    eventId: string;
    kind: 'systemic' | 'idiosyncratic' | 'unknown';
    failureClass: string;
    confidence: string;
    cohortKey: string;
    cohortDeclineRate: string;
    cohortN: number;
  }> = [];

  for (const e of events) {
    const dim = cohortDim({ issuer: e.issuer, method: e.method, amountPaise: e.amountPaise });
    const input = {
      issuer: e.issuer,
      method: e.method,
      amountPaise: e.amountPaise,
      failedAt: e.failedAt,
    };
    const r = classify({
      ...input,
      error: {
        code: e.errCode,
        description: e.errDescription,
        source: e.errSource,
        step: e.errStep,
        reason: e.errReason,
      },
      window: store.windowSync(dim, e.failedAt),
      baseline: store.baselineSync(dim),
    });

    if (e.currentKind && e.currentKind !== r.kind) changedKind += 1;
    if (e.currentClass && e.currentClass !== r.failureClass) changedClass += 1;
    if (e.currentN !== null && r.cohortN < e.currentN) nShrank += 1;

    rows.push({
      eventId: e.id,
      kind: r.kind,
      failureClass: r.failureClass,
      confidence: r.confidence.toFixed(3),
      cohortKey: cohortKey(input),
      cohortDeclineRate: r.cohortDeclineRate.toFixed(4),
      cohortN: r.cohortN,
    });
  }

  const nowSystemic = rows.filter((r) => r.kind === 'systemic').length;
  const wasSystemic = events.filter((e) => e.currentKind === 'systemic').length;
  const medianN = [...rows].sort((a, b) => a.cohortN - b.cohortN)[Math.floor(rows.length / 2)];

  console.log(`  kind changed        ${changedKind}`);
  console.log(`  failure class moved ${changedClass}`);
  console.log(`  cohort_n shrank on  ${nShrank} events (the window fix biting)`);
  console.log(`  median cohort_n     ${medianN?.cohortN}`);
  console.log(`  systemic            ${wasSystemic} → ${nowSystemic}`);

  if (dryRun) {
    console.log('\n--dry-run: nothing written.');
    await raw.end();
    return;
  }

  for (let i = 0; i < rows.length; i += 500) {
    await db
      .insert(classifications)
      .values(rows.slice(i, i + 500))
      .onConflictDoUpdate({
        target: classifications.eventId,
        set: {
          kind: sql`excluded.kind`,
          failureClass: sql`excluded.failure_class`,
          confidence: sql`excluded.confidence`,
          cohortKey: sql`excluded.cohort_key`,
          cohortDeclineRate: sql`excluded.cohort_decline_rate`,
          cohortN: sql`excluded.cohort_n`,
          classifiedAt: new Date(),
        },
      });
    process.stdout.write(`  written ${Math.min(i + 500, rows.length)}/${rows.length}\r`);
  }

  console.log(`\n\nre-classified ${rows.length} events.`);
  console.log('Note: this rewrites classifications only. Arms, attempts and the');
  console.log('ledger are untouched — a classification is a reading, not a decision');
  console.log('that was acted on, and rewriting history downstream would be a lie.');
  void and;
  await raw.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
