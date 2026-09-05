/**
 * Plant a known effect, then check the system measures it back.
 *
 *   npm run validate:incrementality
 *   npm run validate:incrementality -- --events 6000 --control-rate 0.10 --true-lift 0.12
 *
 * This is the evidence that the headline number means what it claims. It
 * writes events straight to the database rather than through Inngest — it is
 * validating the *estimator*, not the pipeline (milestone 3's end-to-end run
 * covers the pipeline). Arms are assigned with the real `assignArm`, so the
 * split is the same deterministic hash the live system uses.
 *
 * ⚠️ Destructive: truncates the experiment tables. Development only.
 */
import { config } from 'dotenv';

config({ path: '.env.local' });

const num = (name: string, dflt: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : Number(process.argv[i + 1]);
};

/** Ticket sizes spanning 200×, which is what makes the rupee interval hard. */
const BANDS = [20_000, 75_000, 250_000, 900_000, 4_000_000];

async function main() {
  const { db, sql } = await import('../src/db/client');
  const { armAssignments, paymentEvents } = await import('../src/db/schema');
  const { assignArm } = await import('../src/core/experiment/assign');
  const { metricsSummary } = await import('../src/core/experiment/metrics-store');
  const { mulberry32 } = await import('../src/core/experiment/stats');

  const N = num('events', 6000);
  const CONTROL_RATE = num('control-rate', 0.1);
  const NAIVE_LIFT = num('naive-lift', 0.04);
  const TRUE_LIFT = num('true-lift', 0.12);
  const SEED = num('seed', 20260904);

  const salt = process.env.ARM_ASSIGNMENT_SALT;
  if (!salt) throw new Error('ARM_ASSIGNMENT_SALT is not set');

  console.log(`\nplanting an effect over ${N} events`);
  console.log(`  control organic recovery : ${(CONTROL_RATE * 100).toFixed(1)}%`);
  console.log(`  naive arm true lift      : +${(NAIVE_LIFT * 100).toFixed(1)}pp`);
  console.log(`  leakproof arm true lift  : +${(TRUE_LIFT * 100).toFixed(1)}pp`);

  await sql`truncate arm_assignments, classifications, policy_evaluations, messages, recovery_attempts, payment_events cascade`;

  const rng = mulberry32(SEED);
  const events = [];
  const assignments = [];
  const now = Date.now();
  let plantedTreatedRecoveries = 0;
  let nTreated = 0;

  for (let i = 0; i < N; i += 1) {
    const id = `pay_VAL${String(i).padStart(6, '0')}`;
    const amountPaise = BANDS[(rng() * BANDS.length) | 0];
    const { arm, bucket, hashInput, saltVersion } = assignArm(id, salt);

    const rate =
      arm === 'control'
        ? CONTROL_RATE
        : arm === 'naive'
          ? CONTROL_RATE + NAIVE_LIFT
          : CONTROL_RATE + TRUE_LIFT;
    const recovered = rng() < rate;

    if (arm === 'leakproof') {
      nTreated += 1;
      if (recovered) plantedTreatedRecoveries += 1;
    }

    const failedAt = new Date(now - (N - i) * 1000);
    events.push({
      id,
      surface: 'payment' as const,
      amountPaise,
      currency: 'INR',
      method: 'card',
      issuer: 'HDFC',
      amountBand: 'x',
      timeBucket: 12,
      state: (recovered ? 'recovered' : 'lost') as 'recovered' | 'lost',
      isSynthetic: true,
      failedAt,
      recoveredAt: recovered ? new Date(failedAt.getTime() + 3600_000) : null,
      recoveredPaise: recovered ? amountPaise : null,
    });
    assignments.push({ eventId: id, arm, saltVersion, hashInput, bucket });
  }

  for (let i = 0; i < events.length; i += 500) {
    await db.insert(paymentEvents).values(events.slice(i, i + 500));
    await db.insert(armAssignments).values(assignments.slice(i, i + 500));
  }

  const meanTicket = BANDS.reduce((a, b) => a + b, 0) / BANDS.length;
  const truth = Math.round(nTreated * TRUE_LIFT * meanTicket);

  const m = await metricsSummary({});

  const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

  console.log('\n── arms ' + '─'.repeat(58));
  for (const a of ['control', 'naive', 'leakproof'] as const) {
    const s = m.arms[a];
    console.log(
      `  ${a.padEnd(10)} n=${String(s.n).padStart(5)}  recovered=${String(s.recovered).padStart(4)}` +
        `  rate=${pct(s.recovery_rate)}  gross=${rupees(s.gross_paise).padStart(14)}`,
    );
  }

  console.log('\n── the number ' + '─'.repeat(52));
  console.log(`  planted truth        ${rupees(truth)}`);
  console.log(`  measured incremental ${rupees(m.incremental_paise)}`);
  console.log(`  95% interval         [${rupees(m.ci95_paise[0])}, ${rupees(m.ci95_paise[1])}]`);
  const covered = m.ci95_paise[0] <= truth && truth <= m.ci95_paise[1];
  const err = truth === 0 ? 0 : ((m.incremental_paise - truth) / truth) * 100;
  console.log(`  interval covers truth ${covered ? 'YES' : 'NO'}   relative error ${err.toFixed(2)}%`);
  // Sanity check on the harness itself: the recoveries we planted in the
  // treated arm must be the ones the estimator counted. A mismatch would mean
  // the validation is measuring its own bug rather than the system's.
  console.log(
    `  planted treated recoveries ${plantedTreatedRecoveries} of ${nTreated} ` +
      `— estimator counted ${m.arms.leakproof.recovered}` +
      (plantedTreatedRecoveries === m.arms.leakproof.recovered ? ' ✓' : ' ✗ MISMATCH'),
  );
  console.log(`  gross would have claimed ${rupees(m.arms.leakproof.gross_paise)} ` +
    `— ${(m.arms.leakproof.gross_paise / Math.max(1, m.incremental_paise)).toFixed(2)}× the honest figure`);

  console.log('\n── inference ' + '─'.repeat(53));
  console.log(`  lift vs control  ${m.lift_vs_control_pp.toFixed(2)}pp  ` +
    `95% CI [${m.lift_vs_control_ci95_pp[0].toFixed(2)}, ${m.lift_vs_control_ci95_pp[1].toFixed(2)}]  ` +
    `(planted ${(TRUE_LIFT * 100).toFixed(1)}pp)`);
  console.log(`  lift vs naive    ${m.lift_vs_naive_pp.toFixed(2)}pp  (planted ${((TRUE_LIFT - NAIVE_LIFT) * 100).toFixed(1)}pp)`);
  console.log(`  p-value          ${m.p_value.toExponential(2)}`);
  console.log(`  powered          ${m.powered}${m.power_blockers.length ? ` (${m.power_blockers.join('; ')})` : ''}`);
  console.log(
    `  balance          ticket spread ${m.balance.mean_ticket_spread_pct.toFixed(2)}% — ${m.balance.balanced ? 'ok' : 'SUSPECT'}` +
      `  (chance gives ${m.balance.null_median_pct.toFixed(2)}%, p95 ${m.balance.null_p95_pct.toFixed(2)}%, p=${m.balance.p_value.toFixed(3)})`,
  );
  for (const c of m.caveats) console.log(`  caveat           ${c}`);

  console.log(`\n  provenance       seed=${m.provenance.bootstrap_seed} iterations=${m.provenance.bootstrap_iterations}\n`);

  await sql.end();
  if (!covered) {
    console.error('FAILED: the interval did not cover the planted effect');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
