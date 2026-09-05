/**
 * Re-queue triage for at-risk events the pipeline never processed.
 *
 *   npm run requeue:triage -- --dry-run
 *   npm run requeue:triage -- --limit 2000
 *   npm run requeue:triage -- --chunk 200 --pause 2000
 *
 * The Inngest dev server holds its queue in memory. Restart it — or let it
 * wedge — and every event still in flight is gone, while the rows those events
 * would have written are simply never written. The corpus then reads as
 * thousands of at-risk payments that no arm ever saw, which quietly shrinks the
 * denominator of the only number this project is judged on.
 *
 * This walks the events that have no arm assignment and re-emits the same
 * `event.ready_for_triage` that `ingestBatch` emits. It is not a second
 * pipeline: it re-enters the real one at the top, so classify → assign → plan
 * all run, with their ledger receipts, exactly as they would have.
 *
 * ── Why "no arm assignment" is the safe filter ───────────────────────
 *
 * `recovery.plan` is triggered by `event.assigned`, so an event with no
 * assignment has never been planned and holds no recovery attempt. Re-queueing
 * it cannot mint a duplicate. Events that *do* have an assignment are skipped
 * for exactly that reason — re-running them would create a second attempt for
 * every one, which is the trap `reclassify.ts` documents. Classification
 * itself is idempotent (`onConflictDoUpdate`), so the small number of events
 * that were classified but never assigned re-classify harmlessly.
 */
import { config } from 'dotenv';

config({ path: '.env.local' });

const flag = (n: string) => process.argv.includes(`--${n}`);
const num = (n: string, dflt: number): number => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? dflt : Number(process.argv[i + 1]);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { sql } = await import('../src/db/client');
  const { inngest } = await import('../src/lib/inngest');

  const limit = num('limit', Number.MAX_SAFE_INTEGER);
  /** Events per `inngest.send`. The SDK caps a single call, so this stays small. */
  const chunk = num('chunk', 500);
  /** Breather between chunks, so a dev server is fed rather than flooded. */
  const pause = num('pause', 1000);
  const dryRun = flag('dry-run');

  /**
   * Every at-risk event, whatever state it settled in — emphatically including
   * the recovered ones. The arm is the grouping key for the incrementality
   * result, so assigning only the events that never recovered would hand the
   * estimator a population selected on the outcome and drive every arm's
   * recovery rate toward zero. `payment_events` holds failures only, so there
   * is nothing here to exclude.
   *
   * Re-queueing an already-recovered event is safe: `setEventState` refuses to
   * leave a terminal state, the metrics read `recovered_at` rather than the
   * label, and `recovery.execute` cancels an attempt whose payment has since
   * succeeded instead of sending to someone who already paid.
   */
  const rows = await sql<{ id: string }[]>`
    select e.id
    from payment_events e
    left join arm_assignments a on a.event_id = e.id
    where a.event_id is null
    order by e.failed_at`;

  const ids = rows.map((r) => r.id).slice(0, limit);

  console.log(`\n${rows.length} at-risk events have no arm assignment`);
  if (ids.length < rows.length) console.log(`  --limit ${limit} → re-queueing ${ids.length}`);

  if (dryRun) {
    console.log('\n--dry-run: nothing sent.');
    console.log(`  first 5: ${ids.slice(0, 5).join(', ')}`);
    await sql.end();
    return;
  }

  if (ids.length === 0) {
    console.log('  nothing to do.');
    await sql.end();
    return;
  }

  let sent = 0;
  const t0 = Date.now();
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = ids.slice(i, i + chunk);
    await inngest.send(
      slice.map((eventId) => ({
        name: 'event.ready_for_triage' as const,
        // Same shape `ingestBatch` sends. `source` is what the trace shows an
        // auditor, so it says where the re-entry came from rather than
        // claiming to be a fresh simulator ingest.
        data: { eventId, source: 'requeue' as const },
      })),
    );
    sent += slice.length;
    process.stdout.write(`  queued ${sent}/${ids.length}\r`);
    if (i + chunk < ids.length) await sleep(pause);
  }

  console.log(`\n\nqueued ${sent} events in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('Watch them drain with the Inngest dev UI, or:');
  console.log('  select count(*) from arm_assignments;');

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
