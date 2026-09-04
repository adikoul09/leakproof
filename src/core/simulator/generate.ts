/**
 * The synthetic data generator.
 *
 * Pure and seeded: `generateBatch(spec)` given the same spec returns byte-identical
 * output on any machine, forever. That property is the entire point. A reported
 * lift is only auditable if the corpus it was computed over can be regenerated
 * from the seed stored beside it, so this module reads no clock, no environment
 * and no database.
 *
 * The events it emits are exactly the `/api/events/ingest` payload shape — the
 * same route a real webhook's normalised output would take — so nothing
 * downstream can tell a synthetic event from a live one. If the simulator had
 * its own path into the tables, a green dashboard would be proving nothing.
 *
 * What it deliberately does NOT do: decide whether a failure is systemic. It
 * plants the ground truth and hands the raw payload to the classifier like
 * anybody else. `groundTruth` is for scoring afterwards, never an input.
 */
import { type Arm, assignArm } from '@/core/experiment/assign';
import {
  ADVERSARIAL_SHAPES,
  AMOUNT_LOGNORMAL,
  BASE_DECLINE_RATE,
  CARD_NETWORKS,
  type FailureShape,
  FAILURE_MIX,
  HOURLY_VOLUME,
  ISSUER_MIX,
  type Method,
  METHOD_MIX,
  OPT_OUT_RATE,
  OUTAGE_SHAPES,
  REPEAT_CUSTOMER_RATE,
  SUBSCRIPTION_SHARE,
  paydayInsufficientFundsMultiplier,
  paydayVolumeMultiplier,
} from './profile';
import { type Rng, intBetween, lognormal, sampleFromCurve, shuffle, stream, weightedPick } from './rng';

const HOUR_MS = 3_600_000;
const IST_OFFSET_MS = 330 * 60_000;

// ── Spec ────────────────────────────────────────────────────────────

export interface OutageSpec {
  issuer: string;
  method: Method;
  durationMin: number;
  /**
   * Decline rate inside the window, as a percentage. The blueprint calls this
   * `spike_pct`. 40 means "40% of attempts on this issuer+method fail", not
   * "40 percentage points above baseline" — an absolute rate is what an
   * operator reads off a dashboard during an incident.
   */
  spikePct: number;
  /** Minutes from window start. Defaults to ending 15 minutes before the window does. */
  startOffsetMin?: number;
}

/**
 * Simulated response to treatment.
 *
 * ⚠️ Read this before believing any lift measured on a synthetic batch.
 *
 * A synthetic customer cannot pay a real Razorpay payment link, so on synthetic
 * data the treated arms have no mechanism by which to actually recover more
 * money. If this field is null the generator plants NO effect: every arm
 * recovers at `organicRecoveryRate` and the honest measured lift is zero. That
 * is the A/A null test, and it is the more valuable of the two modes — an
 * estimator that reports a lift on data containing none is broken.
 *
 * When set, the uplift is planted by construction. It validates that the
 * estimator recovers an effect it is known to contain. It is NOT evidence that
 * LEAKPROOF recovers revenue on real traffic, and the README says so.
 */
export interface TreatmentResponse {
  naiveUpliftPp: number;
  leakproofUpliftPp: number;
  /** Needed to reproduce the live arm split. Never persisted with the batch. */
  armSalt: string;
}

export interface BatchSpec {
  /**
   * Target number of at-risk (failed) events at baseline. An injected outage
   * adds failures on top of this, which is what an outage does.
   */
  count: number;
  seed: number;
  /** Simulated span. The blueprint's "time compression" knob: 24 here replays a day. */
  windowHours: number;
  /** Simulated window end, usually "now". */
  endsAt: Date;
  injectOutage?: OutageSpec | null;
  /** Baseline probability a failed payment recovers with no intervention. */
  organicRecoveryRate: number;
  /** Share of failures given deliberately hostile shapes. */
  adversarialPct: number;
  /** 0 = flat month, 1 = strong payday cycle. */
  paydayStrength: number;
  treatmentResponse?: TreatmentResponse | null;
  subscriptionShare?: number;
}

export interface NormalizedSpec extends Required<Omit<BatchSpec, 'treatmentResponse' | 'injectOutage' | 'endsAt'>> {
  endsAt: string;
  injectOutage: OutageSpec | null;
  /** Salt-free echo — the salt is a secret and never leaves the process. */
  treatmentResponse: { naiveUpliftPp: number; leakproofUpliftPp: number } | null;
}

// ── Output ──────────────────────────────────────────────────────────

/** Exactly the `/api/events/ingest` event shape. */
export interface SyntheticEvent {
  id: string;
  surface: 'payment' | 'subscription';
  customer_id?: string;
  amount_paise: number;
  currency: string;
  method: string | null;
  issuer: string | null;
  card_network?: string | null;
  order_id: string | null;
  err_code?: string | null;
  err_description?: string | null;
  err_source?: string | null;
  err_step?: string | null;
  err_reason?: string | null;
  failed_at: string;
  outcome: 'failed' | 'succeeded';
}

export type AdversarialKind =
  | 'unlabelled_error'
  | 'duplicate_delivery'
  | 'out_of_order_recovery'
  | 'opted_out_customer'
  | 'late_webhook';

export interface GroundTruth {
  outage: {
    issuer: string;
    method: string;
    startedAt: string;
    endedAt: string;
    /** Failures inside the window that are genuinely infrastructure-caused. */
    systemicEventIds: string[];
    /** Failures inside the window that are ordinary customer problems. */
    coincidentIdiosyncraticIds: string[];
  } | null;
  /**
   * Every event the generator considers genuinely systemic, window or not.
   * This is the label the detector is scored against.
   */
  systemicEventIds: string[];
  /** Recovery actually emitted, per arm — realised, not nominal. See `censoring`. */
  armOutcomes: Record<Arm, ArmOutcome>;
  /**
   * The effect the generator actually planted, measured off the emitted corpus
   * rather than copied from the spec. Censoring makes the realised uplift
   * smaller than the nominal one, and validating against the nominal figure
   * would report a false miss.
   */
  realisedLiftPp: { naive: number; leakproof: number } | null;
  /**
   * The *counterfactual* truth, not a sample statistic.
   *
   * Recovery is drawn as a single uniform u per event: it recovers when
   * u < organic + uplift, and it would have recovered anyway when u < organic.
   * The events with organic <= u < organic + uplift are therefore exactly the
   * ones the treatment caused, and their rupees are exactly the incremental
   * revenue. This is the number to validate the estimator against — computing
   * ground truth as (treated mean − control mean) would just be the estimator
   * scoring its own homework.
   */
  trueIncrementalPaise: number | null;
  trueIncrementalRecoveries: number | null;
}

export interface ArmOutcome {
  n: number;
  recovered: number;
  rate: number;
  atRiskPaise: number;
  recoveredPaise: number;
  /** Recoveries that happened only because this arm was treated. */
  causedByTreatment: number;
  causedByTreatmentPaise: number;
}

export interface BatchSummary {
  attempts: number;
  failed: number;
  succeeded: number;
  baselineFailed: number;
  outageFailed: number;
  rebalancedBy: number;
  /** Recoveries that would have landed after the window end, so were not emitted. */
  censoredRecoveries: number;
  emittedRecoveries: number;
  adversarial: Record<AdversarialKind, number>;
  optedOutCustomers: number;
  subscriptions: number;
  declineRate: number;
  windowStart: string;
  windowEnd: string;
  amountPercentilesPaise: { p50: number; p90: number; p99: number; max: number };
  atRiskPaise: number;
}

export interface GeneratedBatch {
  spec: NormalizedSpec;
  /** Emission order. Deliberately NOT always time order — see `out_of_order_recovery`. */
  events: SyntheticEvent[];
  optedOutCustomers: Array<{ id: string; reason: string }>;
  groundTruth: GroundTruth;
  summary: BatchSummary;
}

// ── Internals ───────────────────────────────────────────────────────

interface Attempt {
  index: number;
  at: number;
  method: Method;
  issuer: string;
  cardNetwork: string | null;
  amountPaise: number;
  customerId: string;
  surface: 'payment' | 'subscription';
  failed: boolean;
  /** Set only on failures. */
  shape: FailureShape | null;
  inOutage: boolean;
  adversarial: AdversarialKind | null;
}

const base36 = (n: number, width: number) =>
  Math.abs(Math.trunc(n)).toString(36).padStart(width, '0').slice(-width);

/** Hour of day in IST. Local copy so the simulator core stays dependency-light. */
const istHourOf = (ms: number) => new Date(ms + IST_OFFSET_MS).getUTCHours();
const istDayOf = (ms: number) => new Date(ms + IST_OFFSET_MS).getUTCDate();

/**
 * Expected decline rate over the method mix. Used only to size the attempt
 * pool; the realised rate comes out of the simulation.
 */
function expectedDeclineRate(): number {
  let total = 0;
  let weight = 0;
  for (const m of METHOD_MIX) {
    total += m.weight * BASE_DECLINE_RATE[m.value];
    weight += m.weight;
  }
  return total / weight;
}

/**
 * Per-hour arrival weights across the window, so attempts follow the diurnal
 * curve and the payday cycle instead of arriving uniformly.
 */
function volumeCurve(windowStart: number, hours: number, paydayStrength: number): number[] {
  const weights: number[] = [];
  for (let h = 0; h < hours; h += 1) {
    const at = windowStart + h * HOUR_MS;
    weights.push(HOURLY_VOLUME[istHourOf(at)] * paydayVolumeMultiplier(istDayOf(at), paydayStrength));
  }
  return weights;
}

/**
 * Draw a failure shape for an ordinary (non-outage) failure, tilting the
 * insufficient-funds share by where we are in the salary month.
 */
function drawOrdinaryShape(rng: Rng, method: Method, at: number, paydayStrength: number): FailureShape {
  const mult = paydayInsufficientFundsMultiplier(istDayOf(at), paydayStrength);
  const table = FAILURE_MIX[method].map((w) =>
    w.value.reason === 'insufficient_funds' ? { value: w.value, weight: w.weight * mult } : w,
  );
  return weightedPick(rng, table);
}

const SUBSCRIPTION_SHAPES: FailureShape[] = [
  { code: 'BAD_REQUEST_ERROR', reason: 'subscription_halted', description: 'Subscription halted after repeated charge failures.', source: 'customer', step: 'payment_authorization', truth: 'customer' },
  { code: 'BAD_REQUEST_ERROR', reason: 'mandate_revoked', description: 'The mandate was revoked by the customer.', source: 'customer', step: 'payment_authorization', truth: 'customer' },
  { code: 'BAD_REQUEST_ERROR', reason: 'mandate_expired', description: 'The mandate has expired.', source: 'customer', step: 'payment_authorization', truth: 'customer' },
  { code: 'BAD_REQUEST_ERROR', reason: 'insufficient_funds', description: 'Account balance too low for the scheduled charge.', source: 'customer', step: 'payment_authorization', truth: 'customer' },
];

// ── The generator ───────────────────────────────────────────────────

export function generateBatch(spec: BatchSpec): GeneratedBatch {
  const paydayStrength = spec.paydayStrength;
  const subscriptionShare = spec.subscriptionShare ?? SUBSCRIPTION_SHARE;
  const windowEnd = spec.endsAt.getTime();
  const hours = Math.max(1, Math.round(spec.windowHours));
  const windowStart = windowEnd - hours * HOUR_MS;
  const tag = base36(spec.seed, 5);
  /** Stable id for an attempt. Needed before emission so the arm is knowable early. */
  const idOf = (a: Attempt) =>
    `${a.surface === 'subscription' ? 'sub' : 'pay'}_S${tag}${base36(a.index, 8)}`;

  // Independent streams: adding a draw in one dimension must not reshuffle the
  // others. See `stream` for why that matters.
  const rTime = stream(spec.seed, 'time');
  const rMethod = stream(spec.seed, 'method');
  const rIssuer = stream(spec.seed, 'issuer');
  const rAmount = stream(spec.seed, 'amount');
  const rFail = stream(spec.seed, 'fail');
  const rShape = stream(spec.seed, 'shape');
  const rCustomer = stream(spec.seed, 'customer');
  const rRecover = stream(spec.seed, 'recover');
  const rAdversarial = stream(spec.seed, 'adversarial');
  const rRebalance = stream(spec.seed, 'rebalance');

  const outage = spec.injectOutage ?? null;
  let outageStart = 0;
  let outageEnd = 0;
  if (outage) {
    const defaultStart = hours * 60 - 15 - outage.durationMin;
    const startMin = outage.startOffsetMin ?? Math.max(0, defaultStart);
    outageStart = windowStart + startMin * 60_000;
    outageEnd = outageStart + outage.durationMin * 60_000;
  }

  // 1. Size the attempt pool so baseline failures land near the target.
  const nAttempts = Math.max(spec.count, Math.round(spec.count / expectedDeclineRate()));
  const curve = volumeCurve(windowStart, hours, paydayStrength);

  // 2. Lay attempts on the timeline, then sort — the diurnal curve is sampled
  //    independently per attempt, so ordering has to be restored explicitly.
  const attempts: Attempt[] = [];
  const times: number[] = [];
  for (let i = 0; i < nAttempts; i += 1) {
    const h = sampleFromCurve(rTime, curve);
    times.push(windowStart + h * HOUR_MS);
  }
  times.sort((a, b) => a - b);

  // A customer pool sized so roughly REPEAT_CUSTOMER_RATE of failures come from
  // someone who has failed before — which is what makes the weekly contact cap
  // and the opt-out rule do any work at all.
  const poolSize = Math.max(1, Math.round(spec.count * (1 - REPEAT_CUSTOMER_RATE)));

  for (let i = 0; i < nAttempts; i += 1) {
    const at = times[i];
    const isSubscription = rMethod() < subscriptionShare;
    const method: Method = isSubscription
      ? rMethod() < 0.55
        ? 'card'
        : 'netbanking'
      : weightedPick(rMethod, METHOD_MIX);
    const issuer = weightedPick(rIssuer, ISSUER_MIX[method]);
    const ln = AMOUNT_LOGNORMAL[method];
    const amountPaise = Math.max(
      100,
      Math.min(ln.maxPaise, Math.round(lognormal(rAmount, ln.mu, ln.sigma) / 100) * 100),
    );

    const inOutage =
      outage !== null && at >= outageStart && at < outageEnd && issuer === outage.issuer && method === outage.method;

    const failProbability = inOutage ? outage!.spikePct / 100 : BASE_DECLINE_RATE[method];
    const failed = rFail() < failProbability;

    attempts.push({
      index: i,
      at,
      method,
      issuer,
      cardNetwork: method === 'card' ? weightedPick(rIssuer, CARD_NETWORKS) : null,
      amountPaise,
      customerId: `cust_S${tag}${base36(Math.floor(rCustomer() * poolSize), 6)}`,
      surface: isSubscription ? 'subscription' : 'payment',
      failed,
      shape: null,
      inOutage,
      adversarial: null,
    });
  }

  // 3. Land exactly `count` baseline failures.
  //
  //    The failure draw is a Bernoulli per attempt, so the realised count lands
  //    within a percent or two of the target and never on it. Rather than
  //    resample the whole corpus, flip the difference on attempts drawn
  //    uniformly from OUTSIDE the outage window. Uniform selection introduces
  //    no cohort bias, the correction is well under half a percentage point of
  //    the overall decline rate, and excluding the outage window means the
  //    planted signal is never touched by the bookkeeping. `rebalancedBy` in
  //    the summary reports how many were moved, so it is visible, not hidden.
  const outsideOutage = attempts.filter((a) => !a.inOutage);
  const baselineFailedIdx = outsideOutage.filter((a) => a.failed);
  let rebalancedBy = 0;
  const excess = baselineFailedIdx.length - spec.count;
  if (excess > 0) {
    for (const a of shuffle(rRebalance, [...baselineFailedIdx]).slice(0, excess)) a.failed = false;
    rebalancedBy = -excess;
  } else if (excess < 0) {
    const successes = outsideOutage.filter((a) => !a.failed);
    for (const a of shuffle(rRebalance, successes).slice(0, -excess)) a.failed = true;
    rebalancedBy = -excess;
  }

  // 4. Give every failure a payload.
  const adversarialCounts: Record<AdversarialKind, number> = {
    unlabelled_error: 0,
    duplicate_delivery: 0,
    out_of_order_recovery: 0,
    opted_out_customer: 0,
    late_webhook: 0,
  };
  const failures = attempts.filter((a) => a.failed);
  for (const a of failures) {
    if (a.surface === 'subscription') {
      a.shape = SUBSCRIPTION_SHAPES[intBetween(rShape, 0, SUBSCRIPTION_SHAPES.length - 1)];
      continue;
    }
    if (a.inOutage) {
      a.shape = weightedPick(rShape, OUTAGE_SHAPES);
      continue;
    }
    a.shape = drawOrdinaryShape(rShape, a.method, a.at, paydayStrength);
  }

  // 4b. Decide recovery BEFORE hostile traits are assigned.
  //
  //     An out-of-order delivery needs two events to reorder, so it is only
  //     meaningful for a failure that actually recovers. Marking one on an
  //     event that never recovers produces nothing and reports a number that
  //     did not happen — the summary said 73 out-of-order deliveries when 8
  //     had been emitted. Knowing the outcome first makes the trait assignable
  //     only where it can be realised.
  const tr = spec.treatmentResponse ?? null;
  const organic = Math.min(0.98, Math.max(0, spec.organicRecoveryRate));

  interface RecoveryPlan {
    arm: Arm;
    willRecover: boolean;
    causedByTreatment: boolean;
    recoveredAt: number;
    censored: boolean;
  }
  const plans = new Map<number, RecoveryPlan>();
  for (const a of failures) {
    const { arm } = tr ? assignArm(idOf(a), tr.armSalt) : { arm: 'control' as Arm };
    const uplift = tr
      ? arm === 'naive'
        ? tr.naiveUpliftPp
        : arm === 'leakproof'
          ? tr.leakproofUpliftPp
          : 0
      : 0;
    const recoveryRate = Math.min(0.98, Math.max(0, spec.organicRecoveryRate + uplift));
    // One uniform draw decides both worlds. u < organic means this event would
    // have recovered on its own; organic <= u < recoveryRate means the
    // treatment is what recovered it. Two independent draws would have made
    // the counterfactual unknowable and the ground truth a guess.
    const u = rRecover();
    const willRecover = u < recoveryRate;
    let recoveredAt = 0;
    if (willRecover) {
      // Time to self-recovery, heavy-tailed: most people who retry do it
      // within the hour, a few come back the next day.
      const delayMin = Math.round(5 + lognormal(rRecover, Math.log(38), 1.1));
      recoveredAt = a.at + delayMin * 60_000;
    }
    plans.set(a.index, {
      arm,
      willRecover,
      causedByTreatment: willRecover && u >= organic,
      recoveredAt,
      // Censored: the recovery would land after the window closes, so it has
      // not happened yet. Real corpora are censored exactly like this, and
      // pretending otherwise would inflate every arm's recovery rate.
      censored: willRecover && recoveredAt > windowEnd,
    });
  }

  // 5. Adversarial share, drawn across failures. Each failure gets at most one
  //    hostile trait, so the shares are exclusive and the counts add up.
  const adversarialN = Math.round(failures.length * spec.adversarialPct);
  const ADVERSARIAL_KINDS: AdversarialKind[] = [
    'unlabelled_error',
    'duplicate_delivery',
    'out_of_order_recovery',
    'opted_out_customer',
    'late_webhook',
  ];
  /** Everything that can be applied to a failure with no emitted recovery. */
  const ORDER_FREE_KINDS: AdversarialKind[] = ADVERSARIAL_KINDS.filter(
    (k) => k !== 'out_of_order_recovery',
  );
  for (const a of shuffle(rAdversarial, [...failures]).slice(0, adversarialN)) {
    let kind = ADVERSARIAL_KINDS[intBetween(rAdversarial, 0, ADVERSARIAL_KINDS.length - 1)];
    const plan = plans.get(a.index)!;
    // Nothing to reorder unless a recovery is actually emitted for this event.
    if (kind === 'out_of_order_recovery' && !(plan.willRecover && !plan.censored)) {
      kind = ORDER_FREE_KINDS[intBetween(rAdversarial, 0, ORDER_FREE_KINDS.length - 1)];
    }
    a.adversarial = kind;
    adversarialCounts[kind] += 1;
    if (kind === 'unlabelled_error') a.shape = weightedPick(rAdversarial, ADVERSARIAL_SHAPES);
    // A webhook delivered hours late still carries its original failure time.
    // The pipeline must place it by `failed_at`, not by arrival — getting this
    // wrong silently poisons the cohort window with backdated volume.
    if (kind === 'late_webhook') a.at -= intBetween(rAdversarial, 45, 240) * 60_000;
  }

  // 6. Opt-outs. Independent of the adversarial share: some fraction of the
  //    customer base has simply asked not to be contacted.
  const optedOut = new Map<string, string>();
  for (const a of failures) {
    if (a.adversarial === 'opted_out_customer') {
      optedOut.set(a.customerId, 'complaint');
    } else if (rAdversarial() < OPT_OUT_RATE) {
      optedOut.set(a.customerId, 'stop_reply');
    }
  }

  // 7. Emit. Failures become at-risk rows; successes feed the cohort
  //    denominator; organic recoveries are successes carrying the failure's
  //    order id, which is the only thread the control arm ever recovers on.
  const events: SyntheticEvent[] = [];
  const systemicEventIds: string[] = [];
  const outageSystemic: string[] = [];
  const outageIdiosyncratic: string[] = [];
  const blankArm = (): ArmOutcome => ({
    n: 0,
    recovered: 0,
    rate: 0,
    atRiskPaise: 0,
    recoveredPaise: 0,
    causedByTreatment: 0,
    causedByTreatmentPaise: 0,
  });
  const armOutcomes: Record<Arm, ArmOutcome> = {
    control: blankArm(),
    naive: blankArm(),
    leakproof: blankArm(),
  };
  const amounts: number[] = [];
  let censored = 0;
  let emittedRecoveries = 0;
  let failedCount = 0;
  let baselineFailed = 0;
  let outageFailed = 0;
  let subscriptions = 0;
  let atRiskPaise = 0;

  for (const a of attempts) {
    const prefix = a.surface === 'subscription' ? 'sub' : 'pay';
    const id = idOf(a);
    const orderId = `order_S${tag}${base36(a.index, 8)}`;

    if (!a.failed) {
      // A plain success. No at-risk row, no order thread — it only moves the
      // cohort denominator, without which every cohort reads 100% declined and
      // the systemic test means nothing.
      events.push({
        id,
        surface: a.surface,
        amount_paise: a.amountPaise,
        currency: 'INR',
        method: a.method,
        issuer: a.issuer,
        card_network: a.cardNetwork,
        order_id: null,
        failed_at: new Date(a.at).toISOString(),
        outcome: 'succeeded',
      });
      continue;
    }

    failedCount += 1;
    atRiskPaise += a.amountPaise;
    amounts.push(a.amountPaise);
    if (a.inOutage) outageFailed += 1;
    else baselineFailed += 1;
    if (a.surface === 'subscription') subscriptions += 1;

    const shape = a.shape!;
    // Ground truth is the shape's own `truth`, not membership of the window.
    // An insufficient-funds failure that happens to land mid-outage is still
    // an idiosyncratic failure, and counting it as systemic would hand the
    // detector free precision it has not earned.
    if (shape.truth === 'infra' && a.inOutage) {
      systemicEventIds.push(id);
      outageSystemic.push(id);
    } else if (a.inOutage) {
      outageIdiosyncratic.push(id);
    }

    const failEvent: SyntheticEvent = {
      id,
      surface: a.surface,
      customer_id: a.customerId,
      amount_paise: a.amountPaise,
      currency: 'INR',
      method: a.method,
      issuer: a.issuer,
      card_network: a.cardNetwork,
      order_id: orderId,
      err_code: shape.code || null,
      err_description: shape.description || null,
      err_source: shape.source || null,
      err_step: shape.step || null,
      err_reason: shape.reason || null,
      failed_at: new Date(a.at).toISOString(),
      outcome: 'failed',
    };

    // Decided in step 4b. With no treatmentResponse this is the A/A null test:
    // identical rates in all three arms, and a correct estimator must report a
    // lift indistinguishable from zero.
    const plan = plans.get(a.index)!;
    const arm = plan.arm;

    if (tr) {
      armOutcomes[arm].n += 1;
      armOutcomes[arm].atRiskPaise += a.amountPaise;
    }

    let recoveryEvent: SyntheticEvent | null = null;
    if (plan.willRecover) {
      if (plan.censored) {
        censored += 1;
      } else {
        emittedRecoveries += 1;
        if (tr) {
          armOutcomes[arm].recovered += 1;
          armOutcomes[arm].recoveredPaise += a.amountPaise;
          if (plan.causedByTreatment) {
            armOutcomes[arm].causedByTreatment += 1;
            armOutcomes[arm].causedByTreatmentPaise += a.amountPaise;
          }
        }
        recoveryEvent = {
          // Razorpay issues a NEW payment id for a retry against the same order.
          // Reusing the id here would let the pipeline match on the id and never
          // exercise the order-id path the control arm actually depends on.
          id: `${prefix}_R${tag}${base36(a.index, 8)}`,
          surface: a.surface,
          amount_paise: a.amountPaise,
          currency: 'INR',
          method: a.method,
          issuer: a.issuer,
          card_network: a.cardNetwork,
          order_id: orderId,
          failed_at: new Date(plan.recoveredAt).toISOString(),
          outcome: 'succeeded',
        };
      }
    }

    if (a.adversarial === 'out_of_order_recovery' && recoveryEvent) {
      // The success arrives before the failure it resolves. A pipeline that
      // matches strictly forward in time silently drops this recovery, and the
      // control arm quietly loses rupees it genuinely earned.
      events.push(recoveryEvent, failEvent);
    } else {
      events.push(failEvent);
      if (recoveryEvent) events.push(recoveryEvent);
    }

    if (a.adversarial === 'duplicate_delivery') {
      // Byte-identical redelivery. Razorpay does this; the ingest path must
      // absorb it without a second at-risk row or a second cohort observation.
      events.push({ ...failEvent });
    }
  }

  for (const arm of Object.keys(armOutcomes) as Arm[]) {
    const o = armOutcomes[arm];
    o.rate = o.n === 0 ? 0 : o.recovered / o.n;
  }

  // Realised, not nominal. Censoring pulls every arm's recovery rate down, so
  // the planted lift the estimator should recover is the one measured off what
  // was actually emitted.
  let realisedLiftPp: GroundTruth['realisedLiftPp'] = null;
  let trueIncrementalPaise: number | null = null;
  let trueIncrementalRecoveries: number | null = null;
  if (tr) {
    realisedLiftPp = {
      naive: armOutcomes.naive.rate - armOutcomes.control.rate,
      leakproof: armOutcomes.leakproof.rate - armOutcomes.control.rate,
    };
    trueIncrementalPaise = armOutcomes.leakproof.causedByTreatmentPaise;
    trueIncrementalRecoveries = armOutcomes.leakproof.causedByTreatment;
  }

  amounts.sort((x, y) => x - y);
  const pct = (q: number) => (amounts.length === 0 ? 0 : amounts[Math.min(amounts.length - 1, Math.floor(q * amounts.length))]);

  const normalized: NormalizedSpec = {
    count: spec.count,
    seed: spec.seed,
    windowHours: hours,
    endsAt: new Date(windowEnd).toISOString(),
    injectOutage: outage,
    organicRecoveryRate: spec.organicRecoveryRate,
    adversarialPct: spec.adversarialPct,
    paydayStrength,
    subscriptionShare,
    treatmentResponse: tr
      ? { naiveUpliftPp: tr.naiveUpliftPp, leakproofUpliftPp: tr.leakproofUpliftPp }
      : null,
  };

  return {
    spec: normalized,
    events,
    optedOutCustomers: [...optedOut].map(([id, reason]) => ({ id, reason })),
    groundTruth: {
      outage: outage
        ? {
            issuer: outage.issuer,
            method: outage.method,
            startedAt: new Date(outageStart).toISOString(),
            endedAt: new Date(outageEnd).toISOString(),
            systemicEventIds: outageSystemic,
            coincidentIdiosyncraticIds: outageIdiosyncratic,
          }
        : null,
      systemicEventIds,
      armOutcomes,
      realisedLiftPp,
      trueIncrementalPaise,
      trueIncrementalRecoveries,
    },
    summary: {
      attempts: attempts.length,
      failed: failedCount,
      succeeded: attempts.length - failedCount,
      baselineFailed,
      outageFailed,
      rebalancedBy,
      censoredRecoveries: censored,
      emittedRecoveries,
      adversarial: adversarialCounts,
      optedOutCustomers: optedOut.size,
      subscriptions,
      declineRate: attempts.length === 0 ? 0 : failedCount / attempts.length,
      windowStart: new Date(windowStart).toISOString(),
      windowEnd: new Date(windowEnd).toISOString(),
      amountPercentilesPaise: {
        p50: pct(0.5),
        p90: pct(0.9),
        p99: pct(0.99),
        max: amounts.length === 0 ? 0 : amounts[amounts.length - 1],
      },
      atRiskPaise,
    },
  };
}
