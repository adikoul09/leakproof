/**
 * Run the synthetic generator straight into the database.
 *
 *   npm run simulate                          # the demo preset
 *   npm run simulate -- --preset panel
 *   npm run simulate -- --preset null_test
 *   npm run simulate -- --count 500 --hours 6 --seed 7 --outage-min 40
 *   npm run simulate -- --dry-run             # generate and describe, write nothing
 *
 * The API route is the same thing behind operator auth and Inngest. This is the
 * local path: same generator, same `ingestBatch`, same batch record — useful
 * when the dev server is not running, and the honest way to check the pipeline
 * before pointing a judge at it.
 */
import { config } from 'dotenv';

config({ path: '.env.local' });

const arg = (name: string): string | null => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
};
const num = (name: string, dflt: number): number => {
  const v = arg(name);
  return v === null ? dflt : Number(v);
};
const flag = (name: string) => process.argv.includes(`--${name}`);

const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

async function main() {
  const { generateBatch } = await import('../src/core/simulator/generate');
  const { PRESETS, batchLabel } = await import('../src/core/simulator/presets');
  const { ingestBatch } = await import('../src/core/ingest/ingest-batch');
  const { applyOptOuts, completeBatch, createBatch, recordPlan, recordProgress } = await import(
    '../src/core/simulator/store'
  );
  const { sql } = await import('../src/db/client');

  const presetName = (arg('preset') ?? 'demo') as keyof typeof PRESETS;
  const preset = PRESETS[presetName];
  if (!preset) {
    console.error(`unknown preset '${presetName}'. one of: ${Object.keys(PRESETS).join(', ')}`);
    process.exit(1);
  }

  const armSalt = process.env.ARM_ASSIGNMENT_SALT ?? null;
  if (!armSalt && preset.spec.treatmentResponse) {
    console.error('ARM_ASSIGNMENT_SALT is not set — cannot plant a treatment response.');
    process.exit(1);
  }

  const outageMin = arg('outage-min');
  const spec = {
    ...preset.spec,
    count: num('count', preset.spec.count),
    seed: num('seed', preset.spec.seed),
    windowHours: num('hours', preset.spec.windowHours),
    endsAt: new Date(),
    injectOutage:
      preset.spec.injectOutage && outageMin !== null
        ? { ...preset.spec.injectOutage, durationMin: Number(outageMin) }
        : preset.spec.injectOutage,
    treatmentResponse:
      preset.spec.treatmentResponse && armSalt
        ? { ...preset.spec.treatmentResponse, armSalt }
        : null,
  };

  console.log(`\npreset: ${preset.label}`);
  console.log(`  ${preset.description}\n`);

  const t0 = Date.now();
  const batch = generateBatch(spec);
  const s = batch.summary;

  console.log(`generated ${batch.events.length} events in ${Date.now() - t0}ms`);
  console.log(`  window            ${s.windowStart} → ${s.windowEnd}`);
  console.log(`  attempts          ${s.attempts}  (decline rate ${(s.declineRate * 100).toFixed(2)}%)`);
  console.log(`  at-risk events    ${s.failed}  (${s.baselineFailed} baseline + ${s.outageFailed} outage)`);
  console.log(`  at-risk value     ${rupees(s.atRiskPaise)}`);
  console.log(`  ticket p50/p99    ${rupees(s.amountPercentilesPaise.p50)} / ${rupees(s.amountPercentilesPaise.p99)}  max ${rupees(s.amountPercentilesPaise.max)}`);
  console.log(`  recoveries        ${s.emittedRecoveries} emitted, ${s.censoredRecoveries} censored past the window`);
  console.log(`  subscriptions     ${s.subscriptions}`);
  console.log(`  opted out         ${s.optedOutCustomers} customers`);
  console.log(`  adversarial       ${Object.entries(s.adversarial).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log(`  rebalanced        ${s.rebalancedBy} attempts flipped to land on the target`);

  const gt = batch.groundTruth;
  if (gt.outage) {
    console.log(`\nground truth — injected outage`);
    console.log(`  ${gt.outage.issuer}/${gt.outage.method}  ${gt.outage.startedAt} → ${gt.outage.endedAt}`);
    console.log(`  ${gt.outage.systemicEventIds.length} genuinely systemic, ${gt.outage.coincidentIdiosyncraticIds.length} ordinary failures inside the same window`);
  }
  if (gt.trueIncrementalPaise !== null) {
    console.log(`\nground truth — planted effect (counterfactual, not a sample difference)`);
    console.log(`  ${gt.trueIncrementalRecoveries} recoveries caused by treatment, worth ${rupees(gt.trueIncrementalPaise)}`);
    console.log(`  realised lift  naive ${((gt.realisedLiftPp?.naive ?? 0) * 100).toFixed(2)}pp   leakproof ${((gt.realisedLiftPp?.leakproof ?? 0) * 100).toFixed(2)}pp`);
  } else {
    console.log(`\nground truth — A/A null test: no effect planted. A correct estimator must find none.`);
  }

  if (flag('dry-run')) {
    console.log('\n--dry-run: nothing written.');
    await sql.end();
    return;
  }

  const batchId = await createBatch(batch.spec, batchLabel(preset, spec.count));
  console.log(`\nbatch ${batchId}`);
  await recordPlan(batchId, batch);
  await applyOptOuts(batch.optedOutCustomers, new Date(s.windowStart));

  const CHUNK = 2000;
  let accepted = 0;
  let rejected = 0;
  let atRisk = 0;
  let matched = 0;
  let parked = 0;
  const t1 = Date.now();

  for (let i = 0; i < batch.events.length; i += CHUNK) {
    const r = await ingestBatch(batch.events.slice(i, i + CHUNK), batchId, `simulate ${batchId}`);
    accepted += r.accepted;
    rejected += r.rejected;
    atRisk += r.at_risk_created;
    matched += r.recoveries_matched;
    parked += r.recoveries_parked;
    await recordProgress(batchId, accepted, rejected);
    process.stdout.write(
      `  ingested ${Math.min(i + CHUNK, batch.events.length)}/${batch.events.length}` +
        `  at-risk ${atRisk}  recoveries ${matched}\r`,
    );
  }
  await completeBatch(batchId);

  console.log(`\n\ningested in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  console.log(`  accepted ${accepted}, rejected ${rejected}`);
  console.log(`  at-risk rows created  ${atRisk}`);
  console.log(`  recoveries matched    ${matched}`);
  console.log(
    `  recoveries parked out-of-order  ${parked}  ` +
      `(arrived before their failure; re-matched when it landed)`,
  );
  console.log(
    `\nTriage is queued through Inngest. With the dev server and \`npm run inngest:dev\` running,` +
      `\nwatch it drain, then: GET /api/simulator/batches/${batchId}`,
  );

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
