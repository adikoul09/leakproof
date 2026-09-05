/**
 * The incrementality result — blueprint 6.5. This is the number the project is
 * judged on, so the arithmetic is spelled out rather than hidden in a helper.
 *
 * Pure: takes per-event rows, returns the whole summary. The replay engine
 * feeds it a historical corpus through the same function, which is what makes
 * a what-if comparable to a live result.
 *
 * ── What "incremental" means here ────────────────────────────────────
 *
 * Gross recovery is not a result. Some failed payments come back on their own:
 * the customer retries, the bank clears, the card gets topped up. Any dunning
 * tool can claim credit for those. The only honest question is how many rupees
 * came back *because of* the system, and the only way to answer it is to hold
 * a slice of traffic out and never touch it.
 *
 *   incremental_paise = n_treated × (mean per-event recovered value in treated
 *                                    − mean per-event recovered value in control)
 *
 * Equivalently: what the treated arm actually recovered, minus what that same
 * population would have recovered at the control arm's per-event rate.
 *
 * 🔸 This generalises the blueprint's formula
 * (`incremental_rate × n × mean_recovered_amount`), which assumes recovered
 * amounts are distributed identically across arms. They are not: a ₹40,000
 * failure and a ₹200 failure do not recover at the same rate. Carrying the
 * amount with each event costs nothing and stops the estimator from quietly
 * assuming away the thing most likely to bias it. Both figures are reported so
 * the simpler decomposition stays visible.
 */
import {
  type BalanceTest,
  type Interval,
  bootstrapIncrementalPaise,
  mean,
  permutationBalanceTest,
  proportionDiffInterval,
  twoProportionZTest,
  wilsonInterval,
} from './stats';
import { MDR_EFFECTIVE_RATE, RAZORPAY_MDR, mdrOnRecoveredPaise } from '@/core/cost/meter';
import type { Arm } from './assign';

export interface MetricEvent {
  amountPaise: number;
  recovered: boolean;
  /** Amount actually recovered. 0 when the event never recovered. */
  recoveredPaise: number;
}

export interface ArmInput {
  events: MetricEvent[];
  /** Messages actually sent to this arm. Control is always 0. */
  messagesSent: number;
  /** Everything spent on this arm, at the point of spend. */
  costPaise: number;
  /** Distinct customers contacted — the denominator for the contact budget. */
  customersContacted: number;
}

export type ArmsInput = Record<Arm, ArmInput>;

export interface ArmSummary {
  n: number;
  recovered: number;
  recovery_rate: number;
  recovery_rate_ci95: [number, number];
  gross_paise: number;
  mean_ticket_paise: number;
  cost_paise: number;
  messages_sent: number;
}

export interface MetricsSummary {
  arms: Record<Arm, ArmSummary>;
  incremental_paise: number;
  ci95_paise: [number, number];
  /** The blueprint's simpler decomposition, kept visible for comparison. */
  incremental_paise_rate_times_mean: number;
  lift_vs_control_pp: number;
  lift_vs_control_ci95_pp: [number, number];
  lift_vs_naive_pp: number;
  p_value: number;
  powered: boolean;
  /** Why `powered` is false, when it is. */
  power_blockers: string[];
  /**
   * Things that are true about this result and would otherwise have to be
   * discovered by whoever is checking it. Shown next to the headline number,
   * not buried in a methodology note.
   */
  caveats: string[];
  /**
   * Paise spent per ₹100 of incremental revenue — the cost of *attempting*
   * recovery. Currently zero, and honestly so: delivery is Razorpay's own
   * notification on the payment link, bundled with the link, and there is no
   * separate SMS gateway or email provider to bill. See `RATES` for the sources.
   */
  cost_per_100_recovered_paise: number;
  /**
   * Razorpay's fee on the money actually recovered, reported SEPARATELY and
   * never folded into the line above.
   *
   * A per-message cost is incurred on every attempt including the failures — it
   * is the price of trying. MDR is charged only on capture, so it scales with
   * success. Summed together, spending more on failed attempts and recovering
   * more money would push the same number the same way, and "cost per ₹100
   * recovered" would stop meaning anything.
   *
   * It is also not a cost this system causes: the merchant pays MDR on any
   * captured payment. This is the fee on money that would otherwise have been
   * lost entirely.
   */
  razorpay_fee: {
    on_incremental_paise: number;
    on_gross_recovered_paise: number;
    effective_rate: number;
    note: string;
  };
  false_nudge_rate: number;
  contact_budget: { used: number; cap: number };
  cost_breakdown_paise: Record<string, number>;
  /**
   * Randomisation check. Arms are assigned by hashing the event id, so mean
   * ticket size should be close across arms — but "close" depends on the arm
   * sizes and on how heavy the ticket distribution's tail is, not on a fixed
   * percentage. `balanced` is decided by a permutation test against the split
   * this corpus would produce by chance; the raw spread is kept alongside it
   * because it is the figure on screen.
   */
  balance: {
    mean_ticket_spread_pct: number;
    balanced: boolean;
    /** P(a clean split produces a spread at least this large). */
    p_value: number;
    /** What a clean split typically produces at these arm sizes. */
    null_median_pct: number;
    /** The spread a clean split exceeds 5% of the time. */
    null_p95_pct: number;
    /** Label reshuffles behind the p-value. Its own count, not the bootstrap's. */
    iterations: number;
  };
  /** Everything needed to recompute this result by hand. */
  provenance: { bootstrap_iterations: number; bootstrap_seed: number; alpha: number };
}

/** n_control below this and the experiment cannot support a claim. */
export const MIN_CONTROL_N = 300;

/**
 * Recovered *events* in the control arm needed before the 95% interval on
 * rupees actually covers at 95%.
 *
 * Measured, not assumed. Simulation over 400 trials, control 10% / treated
 * 20%, ticket sizes spanning 200× (see coverage.test.ts):
 *
 *   recovered in control  ≈20    ≈40    ≈100   ≈249   ≈599
 *   measured coverage     91.5%  92.8%  92.8%  94.8%  95.0%
 *
 * The interval reaches nominal around 250 recovered control events. Below
 * that it is genuinely too narrow, because the control arm's mean recovered
 * value is being estimated from a handful of non-zero, heavily-skewed
 * observations — the *total* control events barely matter, the recovered ones
 * do. This is why `MIN_CONTROL_N` alone is not a sufficient power criterion:
 * the blueprint's n ≥ 300 gives roughly 30 recovered events at a 10% organic
 * rate, where coverage is about 92%, not 95%.
 *
 * A 3,000-event batch at an 18% control split cannot reach this threshold, so
 * it is reported as a caveat rather than enforced as a blocker — refusing to
 * show a number at all would be less useful than showing it with its real
 * precision stated.
 */
export const RECOVERED_CONTROL_FOR_NOMINAL_COVERAGE = 250;
/**
 * Significance level for the randomisation balance test.
 *
 * This replaced a flat `MAX_BALANCE_SPREAD_PCT = 15`. The flat threshold was
 * measuring the ticket distribution's tail rather than the quality of the
 * split: at CV ≈ 3 and n ≈ 6,400 a clean hash split clears 15% about 37% of
 * the time, so the Lab spent most of its life telling a judge the
 * randomisation "may not be clean" about a randomisation that was provably
 * fine. `permutationBalanceTest` asks the question the check was always meant
 * to ask — is this spread larger than chance would produce here? — and this is
 * the level at which the answer counts as "no".
 */
export const BALANCE_ALPHA = 0.05;

const perEventValue = (e: MetricEvent) => (e.recovered ? e.recoveredPaise : 0);

function summariseArm(input: ArmInput): ArmSummary {
  const n = input.events.length;
  const recovered = input.events.filter((e) => e.recovered).length;
  const ci = wilsonInterval(recovered, n);
  return {
    n,
    recovered,
    recovery_rate: n === 0 ? 0 : recovered / n,
    recovery_rate_ci95: [ci.lo, ci.hi],
    gross_paise: input.events.reduce((s, e) => s + perEventValue(e), 0),
    mean_ticket_paise: Math.round(mean(input.events.map((e) => e.amountPaise))),
    cost_paise: input.costPaise,
    messages_sent: input.messagesSent,
  };
}

export interface ComputeOptions {
  bootstrapIterations?: number;
  bootstrapSeed?: number;
  alpha?: number;
  /** Weekly per-customer contact cap from the live policy. */
  weeklyContactCap?: number;
  /** Permutation draws for the balance test. Own knob: it is the slower half. */
  balanceIterations?: number;
  costBreakdownPaise?: Record<string, number>;
}

export function computeMetrics(arms: ArmsInput, opts: ComputeOptions = {}): MetricsSummary {
  const iterations = opts.bootstrapIterations ?? 2000;
  const seed = opts.bootstrapSeed ?? 42;
  const alpha = opts.alpha ?? 0.05;

  const summary = {
    control: summariseArm(arms.control),
    naive: summariseArm(arms.naive),
    leakproof: summariseArm(arms.leakproof),
  };

  const ctrlValues = arms.control.events.map(perEventValue);
  const treatValues = arms.leakproof.events.map(perEventValue);

  const nT = treatValues.length;
  const incremental = nT === 0 || ctrlValues.length === 0
    ? 0
    : Math.round(nT * (mean(treatValues) - mean(ctrlValues)));

  const ci: Interval =
    nT === 0 || ctrlValues.length === 0
      ? { lo: 0, hi: 0 }
      : bootstrapIncrementalPaise(treatValues, ctrlValues, { iterations, seed, alpha });

  // The blueprint's decomposition, for comparison.
  const recoveredAmounts = [...arms.leakproof.events, ...arms.control.events]
    .filter((e) => e.recovered)
    .map((e) => e.recoveredPaise);
  const incrementalSimple = Math.round(
    (summary.leakproof.recovery_rate - summary.control.recovery_rate) * nT * mean(recoveredAmounts),
  );

  const rateDiff = proportionDiffInterval(
    summary.leakproof.recovered,
    summary.leakproof.n,
    summary.control.recovered,
    summary.control.n,
  );
  const test = twoProportionZTest(
    summary.leakproof.recovered,
    summary.leakproof.n,
    summary.control.recovered,
    summary.control.n,
  );

  const powerBlockers: string[] = [];
  if (summary.control.n < MIN_CONTROL_N) {
    powerBlockers.push(
      `control arm has ${summary.control.n} events, needs ${MIN_CONTROL_N}`,
    );
  }
  if (ci.lo <= 0 && ci.hi >= 0) {
    powerBlockers.push('the 95% interval for incremental revenue still contains zero');
  }

  /**
   * Of the messages sent, the share that went to customers who would have paid
   * without them. Expected count is (contacted events × control organic rate);
   * dividing by messages sent — which exceeds contacted events once follow-ups
   * are allowed — gives the per-message waste rate.
   */
  const contactedEvents = arms.leakproof.events.length + arms.naive.events.length;
  const messagesSent = arms.leakproof.messagesSent + arms.naive.messagesSent;
  const falseNudgeRate =
    messagesSent === 0 ? 0 : (contactedEvents * summary.control.recovery_rate) / messagesSent;

  const caveats: string[] = [];
  if (
    summary.control.recovered > 0 &&
    summary.control.recovered < RECOVERED_CONTROL_FOR_NOMINAL_COVERAGE
  ) {
    caveats.push(
      `the control arm has ${summary.control.recovered} recovered events; ` +
        `the 95% rupee interval measures roughly 92-93% coverage below ` +
        `${RECOVERED_CONTROL_FOR_NOMINAL_COVERAGE}, so read it as approximate`,
    );
  }
  if (!summary.control.n) {
    caveats.push('no control arm in this window — incrementality cannot be measured at all');
  }
  const totalCost = summary.control.cost_paise + summary.naive.cost_paise + summary.leakproof.cost_paise;
  const costPer100 = incremental <= 0 ? 0 : totalCost / (incremental / 10_000);

  const grossRecovered =
    summary.control.gross_paise + summary.naive.gross_paise + summary.leakproof.gross_paise;

  const balance: BalanceTest = permutationBalanceTest(
    [arms.control, arms.naive, arms.leakproof].map((a) => a.events.map((e) => e.amountPaise)),
    { iterations: opts.balanceIterations ?? 2000, seed },
  );
  const balanced = balance.p_value >= BALANCE_ALPHA;

  if (!balanced) {
    caveats.push(
      `mean ticket size differs by ${balance.spread_pct.toFixed(1)}% across arms, ` +
        `more than a clean split produces at these arm sizes ` +
        `(p=${balance.p_value.toFixed(3)}, chance typically gives ` +
        `${balance.null_median_pct.toFixed(1)}%); the randomisation may not be clean ` +
        'and the headline number should be treated with suspicion',
    );
  }

  const cap =
    (opts.weeklyContactCap ?? 2) *
    (arms.leakproof.customersContacted + arms.naive.customersContacted);

  return {
    arms: summary,
    incremental_paise: incremental,
    ci95_paise: [Math.round(ci.lo), Math.round(ci.hi)],
    incremental_paise_rate_times_mean: incrementalSimple,
    lift_vs_control_pp: (summary.leakproof.recovery_rate - summary.control.recovery_rate) * 100,
    lift_vs_control_ci95_pp: [rateDiff.lo * 100, rateDiff.hi * 100],
    lift_vs_naive_pp: (summary.leakproof.recovery_rate - summary.naive.recovery_rate) * 100,
    p_value: test.pValue,
    powered: powerBlockers.length === 0,
    power_blockers: powerBlockers,
    caveats,
    cost_per_100_recovered_paise: Math.round(costPer100),
    razorpay_fee: {
      on_incremental_paise: mdrOnRecoveredPaise(Math.max(0, incremental)),
      on_gross_recovered_paise: mdrOnRecoveredPaise(grossRecovered),
      effective_rate: MDR_EFFECTIVE_RATE,
      note: RAZORPAY_MDR.source,
    },
    false_nudge_rate: falseNudgeRate,
    contact_budget: { used: messagesSent, cap },
    cost_breakdown_paise: opts.costBreakdownPaise ?? {},
    balance: {
      mean_ticket_spread_pct: balance.spread_pct,
      balanced,
      p_value: balance.p_value,
      null_median_pct: balance.null_median_pct,
      null_p95_pct: balance.null_p95_pct,
      iterations: balance.iterations,
    },
    provenance: { bootstrap_iterations: iterations, bootstrap_seed: seed, alpha },
  };
}
