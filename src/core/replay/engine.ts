/**
 * Deterministic replay — blueprint Screen 7, milestone 8.
 *
 * Runs a historical corpus back through the *same* pure functions the live
 * pipeline uses — `classify`, `evaluatePolicy`, `chooseRail`, `computeMetrics`
 * — under a different policy, different detector thresholds, or different
 * feature flags, and reports what would have changed.
 *
 * It calls the production code paths rather than a second implementation. That
 * is the whole reason those functions take every input as an argument and read
 * neither the clock nor the database: a what-if number computed by a parallel
 * implementation is a number about the parallel implementation.
 *
 * ── What replay can and cannot tell you ───────────────────────────────────
 *
 * It replays DECISIONS, not OUTCOMES.
 *
 * If a tighter policy would have blocked a contact that in reality was sent,
 * replay knows that with certainty — the gate is deterministic given its
 * inputs. What it cannot know is whether the customer would still have paid.
 * That is a counterfactual, and no amount of re-running the corpus produces it.
 *
 * So the result separates two kinds of number, and the UI keeps them apart:
 *
 *   MEASURED   decision changes, messages sent, contacts made, spend. These
 *              follow from the decision alone and are exact.
 *   MODELLED   revenue. Requires an assumption about how customers would have
 *              behaved, stated explicitly in `revenue_model` and never
 *              presented as a measurement.
 *
 * A replay screen that reports a confident rupee delta without saying which of
 * the two it is doing is the most persuasive way to be wrong in this whole
 * project.
 */
import {
  type SystemicThresholds,
  classify,
  cohortDim,
  cohortKey,
} from '@/core/triage/classifier';
import { MemoryCohortStore } from '@/core/triage/memory-cohort-store';
import { bucketStart } from '@/core/triage/config';
import { type PolicyContext, evaluatePolicy } from '@/core/policy/evaluate';
import type { Policy } from '@/core/policy/schema';
import type { StopCondition } from '@/core/policy/schema';
import { type Rail, chooseRail, chooseRailNaive } from '@/core/routing/static-table';
import type { FailureClass } from '@/core/triage/taxonomy';
import { type Arm, assignArm } from '@/core/experiment/assign';
import { type CostItem, costOf } from '@/core/cost/meter';

export interface ReplayFlags {
  /** Compose with the deterministic template instead of the LLM. */
  disable_llm: boolean;
  /** Force every arm onto the naive fixed rail, to price the routing table. */
  naive_rails: boolean;
  /** Re-assign arms under a different salt. Invalidates comparability; for what-if only. */
  alt_salt?: string;
}

export interface ReplaySpec {
  policy: Policy;
  policyVersion: string;
  /** Detector thresholds to replay under. Omitted means the deployed ones. */
  thresholds?: SystemicThresholds;
  flags: ReplayFlags;
  seed: number;
  armSalt: string;
  /** Bank-holiday day keys, pre-warmed exactly as the live gate receives them. */
  bankHolidays: ReadonlySet<string>;
}

/** One historical event, with what actually happened to it. */
export interface ReplayEvent {
  id: string;
  amountPaise: number;
  method: string | null;
  issuer: string | null;
  failedAt: Date;
  customerId: string | null;
  customerOptedOut: boolean;
  error: {
    code: string | null;
    description: string | null;
    source: string | null;
    step: string | null;
    reason: string | null;
  };
  actual: {
    kind: string | null;
    failureClass: string | null;
    arm: Arm | null;
    gateResult: string | null;
    rail: string | null;
    state: string;
    recovered: boolean;
    recoveredPaise: number | null;
    messagesSent: number;
    costPaise: number;
  };
}

export interface CohortBucketSeed {
  cohortDim: string;
  bucketStartMs: number;
  nTotal: number;
  nFailed: number;
}

export type ChangeKind =
  | 'classification'
  | 'gate'
  | 'rail'
  | 'arm';

export interface ChangedDecision {
  event_id: string;
  failed_at: string;
  amount_paise: number;
  issuer: string | null;
  method: string | null;
  changes: Array<{ kind: ChangeKind; from: string; to: string; why: string }>;
}

export interface ReplayCounts {
  events: number;
  systemic: number;
  allowed: number;
  deferred: number;
  blocked: number;
  contacted: number;
  messages: number;
  cost_paise: number;
}

export interface ReplayResult {
  /**
   * Events with no recorded gate verdict — never triaged, or still in flight.
   * The replay evaluates them; history has nothing to compare against. They are
   * excluded from `measured_delta` and counted here so a partially-drained
   * corpus cannot masquerade as a policy effect.
   */
  events_without_baseline_decision: number;
  /** Events on both sides of the comparison. The delta is computed over these. */
  comparable_events: number;
  spec: {
    policy_version: string;
    thresholds: SystemicThresholds | null;
    flags: ReplayFlags;
    seed: number;
  };
  baseline: ReplayCounts;
  replayed: ReplayCounts;
  /** Exact: these follow from the decision alone. */
  measured_delta: {
    contacted: number;
    messages: number;
    cost_paise: number;
    blocked: number;
    deferred: number;
    systemic: number;
  };
  /** Modelled, under a stated assumption. Never presented as measured. */
  modelled_revenue: {
    baseline_recovered_paise: number;
    replayed_recovered_paise: number;
    delta_paise: number;
    /** The assumption, in words. Rendered next to the number. */
    model: string;
    /** Rates the model used, so the arithmetic can be checked by hand. */
    inputs: {
      control_recovery_rate: number;
      treated_recovery_rate: number;
      control_n: number;
      treated_n: number;
    };
  };
  changed_decisions: ChangedDecision[];
  changed_count: number;
  /** Things true about this run that the reader needs and would not guess. */
  caveats: string[];
  events_per_second: number;
}

/** How many changed decisions to carry back. The full list can be thousands. */
const MAX_CHANGED = 300;

function railCost(rail: Rail, disableLlm: boolean): { cost: number; messages: number } {
  if (rail === 'do_nothing') return { cost: 0, messages: 0 };
  const channel: CostItem =
    rail === 'whatsapp_nudge'
      ? 'whatsapp_utility_message'
      : rail === 'email_link'
        ? 'email_message'
        : 'sms_message';
  // The LLM is billed per composed message; the template fallback is free.
  const llm = disableLlm ? 0 : costOf('llm_compose');
  return { cost: costOf(channel) + llm, messages: 1 };
}

export function replay(
  corpus: ReplayEvent[],
  seeds: CohortBucketSeed[],
  spec: ReplaySpec,
): ReplayResult {
  const startedAt = Date.now();

  // Hydrate the cohort counters exactly as they stood. Without this the
  // replayed decline rate has no denominator and every classification differs
  // from the live one for a reason that has nothing to do with the what-if.
  const store = new MemoryCohortStore();
  for (const s of seeds) store.seedBucket(s.cohortDim, s.bucketStartMs, s.nTotal, s.nFailed);

  const ordered = [...corpus].sort((a, b) => a.failedAt.getTime() - b.failedAt.getTime());

  const baseline: ReplayCounts = blank();
  const replayed: ReplayCounts = blank();
  /** The like-for-like subset: events that already have a recorded verdict. */
  const baselineCmp: ReplayCounts = blank();
  const replayedCmp: ReplayCounts = blank();
  let noBaselineDecision = 0;
  const changed: ChangedDecision[] = [];
  let changedCount = 0;

  /**
   * Contact counters maintained BY THE REPLAY, not copied from history.
   *
   * A weekly cap is path-dependent: blocking an early contact frees budget for
   * a later one. Reading the historical counts would evaluate a tighter policy
   * against the spending of a looser one and understate how much it frees up.
   */
  const contactsByCustomer = new Map<string, number[]>();
  const attemptsByEvent = new Map<string, number>();
  const WEEK_MS = 7 * 86_400_000;

  const contactsInWeek = (customerId: string | null, now: Date): number => {
    if (!customerId) return 0;
    const times = contactsByCustomer.get(customerId);
    if (!times) return 0;
    const from = now.getTime() - WEEK_MS;
    return times.filter((t) => t >= from).length;
  };

  for (const e of ordered) {
    const dim = cohortDim({ issuer: e.issuer, method: e.method, amountPaise: e.amountPaise });
    const window = store.windowSync(dim, e.failedAt);
    const cohortBaseline = store.baselineSync(dim);

    const result = classify({
      issuer: e.issuer,
      method: e.method,
      amountPaise: e.amountPaise,
      failedAt: e.failedAt,
      error: e.error,
      window,
      baseline: cohortBaseline,
      thresholds: spec.thresholds,
    });

    const arm = spec.flags.alt_salt
      ? assignArm(e.id, spec.flags.alt_salt).arm
      : (e.actual.arm ?? assignArm(e.id, spec.armSalt).arm);

    const changes: ChangedDecision['changes'] = [];

    // ── classification ──
    baseline.events += 1;
    replayed.events += 1;
    if (e.actual.kind === 'systemic') baseline.systemic += 1;
    if (result.kind === 'systemic') replayed.systemic += 1;
    if (e.actual.kind !== null && e.actual.kind !== result.kind) {
      changes.push({
        kind: 'classification',
        from: e.actual.kind,
        to: result.kind,
        why: result.trace.verdict,
      });
    }

    // ── policy gate ──
    // Control is held out by construction and never reaches the gate. Counting
    // it as "blocked" would make every replay look like it suppressed a fifth
    // of the corpus.
    const heldOut = arm === 'control';
    const attemptNo = (attemptsByEvent.get(e.id) ?? 0) + 1;
    const fired: StopCondition[] = e.actual.recovered ? ['payment_success'] : [];

    const ctx: PolicyContext = {
      now: e.failedAt,
      breakerOpen: false,
      customerOptedOut: e.customerOptedOut,
      firedStopConditions: fired,
      attemptsSoFar: attemptNo - 1,
      contactsThisWeek: contactsInWeek(e.customerId, e.failedAt),
      bankHolidays: spec.bankHolidays,
      proposedDiscountPct: 0,
    };

    const decision = heldOut ? null : evaluatePolicy(spec.policy, ctx);

    const actualGate = e.actual.gateResult;
    const comparable = actualGate !== null;
    if (!comparable && !heldOut) noBaselineDecision += 1;

    if (decision?.result === 'allow') replayed.allowed += 1;
    else if (decision?.result === 'defer') replayed.deferred += 1;
    else if (decision?.result === 'block') replayed.blocked += 1;

    if (actualGate?.startsWith('allow')) baseline.allowed += 1;
    else if (actualGate?.startsWith('defer')) baseline.deferred += 1;
    else if (actualGate?.startsWith('block')) baseline.blocked += 1;

    if (comparable) {
      baselineCmp.events += 1;
      replayedCmp.events += 1;
      if (actualGate!.startsWith('allow')) baselineCmp.allowed += 1;
      else if (actualGate!.startsWith('defer')) baselineCmp.deferred += 1;
      else if (actualGate!.startsWith('block')) baselineCmp.blocked += 1;
      if (decision?.result === 'allow') replayedCmp.allowed += 1;
      else if (decision?.result === 'defer') replayedCmp.deferred += 1;
      else if (decision?.result === 'block') replayedCmp.blocked += 1;
      if (e.actual.kind === 'systemic') baselineCmp.systemic += 1;
      if (result.kind === 'systemic') replayedCmp.systemic += 1;
    }

    if (decision && actualGate && decision.gateResult !== actualGate) {
      changes.push({
        kind: 'gate',
        from: actualGate,
        to: decision.gateResult,
        why: decision.reasons[0] ?? decision.gateResult,
      });
    }

    // ── rail ──
    // A deferred event is still contacted, just later. Only 'block' and being
    // held out stop a contact from happening at all.
    const willContact = decision !== null && decision.result !== 'block';
    let rail: Rail = 'do_nothing';
    if (willContact) {
      const choice =
        spec.flags.naive_rails || arm === 'naive'
          ? chooseRailNaive(attemptNo)
          : chooseRail(result.failureClass as FailureClass, attemptNo);
      rail = choice.rail;
      if (e.actual.rail && e.actual.rail !== rail) {
        changes.push({
          kind: 'rail',
          from: e.actual.rail,
          to: rail,
          why: choice.railScores.why,
        });
      }
    }

    if (willContact && rail !== 'do_nothing') {
      const { cost, messages } = railCost(rail, spec.flags.disable_llm);
      replayed.contacted += 1;
      replayed.messages += messages;
      replayed.cost_paise += cost;
      if (comparable) {
        replayedCmp.contacted += 1;
        replayedCmp.messages += messages;
        replayedCmp.cost_paise += cost;
      }
      attemptsByEvent.set(e.id, attemptNo);
      if (e.customerId) {
        const t = contactsByCustomer.get(e.customerId) ?? [];
        t.push(e.failedAt.getTime());
        contactsByCustomer.set(e.customerId, t);
      }
    }

    /**
     * The baseline is derived from the RECORDED DECISION, priced through the
     * same `railCost` the replay uses — not from what has physically been sent.
     *
     * Those are different quantities and comparing them is meaningless. On this
     * very corpus the difference was stark: 4 September is a bank holiday, so
     * the gate correctly deferred every attempt to the next working day and
     * nothing had been sent at all. Counting sent messages gave the baseline
     * zero contacts against the replay's 1,624, and the screen reported a
     * policy effect that was really just "tomorrow has not happened yet".
     */
    const actualAuthorised = actualGate !== null && !actualGate.startsWith('block') && !heldOut;
    if (actualAuthorised && e.actual.rail && e.actual.rail !== 'do_nothing') {
      // The LLM was enabled for the historical run; price it that way.
      const { cost, messages } = railCost(e.actual.rail as Rail, false);
      baseline.contacted += 1;
      baseline.messages += messages;
      baseline.cost_paise += cost;
      if (comparable) {
        baselineCmp.contacted += 1;
        baselineCmp.messages += messages;
        baselineCmp.cost_paise += cost;
      }
    }

    // Observe AFTER classifying, mirroring the live order: the ingest route
    // records the event, then triage reads a window that already contains it.
    store.observeSync(dim, e.failedAt, true);

    if (changes.length > 0) {
      changedCount += 1;
      if (changed.length < MAX_CHANGED) {
        changed.push({
          event_id: e.id,
          failed_at: e.failedAt.toISOString(),
          amount_paise: e.amountPaise,
          issuer: e.issuer,
          method: e.method,
          changes,
        });
      }
    }
  }

  // ── the modelled part ──
  const treated = corpus.filter((e) => e.actual.arm && e.actual.arm !== 'control');
  const control = corpus.filter((e) => e.actual.arm === 'control');
  const controlRate =
    control.length === 0 ? 0 : control.filter((e) => e.actual.recovered).length / control.length;
  const treatedRate =
    treated.length === 0 ? 0 : treated.filter((e) => e.actual.recovered).length / treated.length;
  const meanTicket =
    corpus.length === 0 ? 0 : corpus.reduce((a, e) => a + e.amountPaise, 0) / corpus.length;

  const baselineRecovered = corpus.reduce((a, e) => a + (e.actual.recoveredPaise ?? 0), 0);
  // Events the replay would no longer contact recover at the CONTROL rate;
  // events it would newly contact recover at the treated rate. Both are the
  // observed rates from this very corpus, so at least the inputs are real even
  // though the counterfactual is not.
  const contactDelta = replayedCmp.contacted - baselineCmp.contacted;
  const modelledDelta = Math.round(contactDelta * (treatedRate - controlRate) * meanTicket);

  const caveats: string[] = [
    'Replay recomputes decisions, not outcomes. Whether a customer would still have paid under a different policy is a counterfactual the corpus cannot answer.',
    'The revenue figure is MODELLED, not measured. Only the decision, message, contact and cost deltas are exact.',
  ];
  /**
   * The baseline classification came out of whatever code was live when the
   * event was ingested; the replay uses today's. A large classification delta
   * can therefore be measuring a CODE change rather than the what-if being
   * tested — which is exactly what happened the first time this ran, when the
   * cohort-window fix (FAILURES.md #20) showed up as +33 systemic against a
   * policy that had not changed at all.
   */
  const systemicDelta = Math.abs(replayedCmp.systemic - baselineCmp.systemic);
  if (systemicDelta > Math.max(5, baselineCmp.systemic * 0.2)) {
    caveats.push(
      `Classification moved by ${systemicDelta} events. The stored classifications were produced by the code that was live when each event was ingested, so a swing this size may be measuring a change to the classifier itself rather than the policy under test. Re-run triage over the corpus before reading this as a policy effect.`,
    );
  }
  if (noBaselineDecision > 0) {
    caveats.push(
      `${noBaselineDecision.toLocaleString('en-IN')} of ${corpus.length.toLocaleString('en-IN')} events have no recorded gate verdict — never triaged, or still in flight. They are replayed but excluded from every delta, because history has nothing to compare them against.`,
    );
  }
  if (control.length < 300) {
    caveats.push(
      `The control arm in this corpus has ${control.length} events; the observed rates feeding the revenue model are themselves noisy.`,
    );
  }
  if (spec.flags.alt_salt) {
    caveats.push(
      'Arms were re-assigned under a different salt. The replayed experiment is not comparable to the live one and must never be published as a result.',
    );
  }

  const elapsed = Math.max(1, Date.now() - startedAt);

  return {
    spec: {
      policy_version: spec.policyVersion,
      thresholds: spec.thresholds ?? null,
      flags: spec.flags,
      seed: spec.seed,
    },
    baseline: baselineCmp,
    replayed: replayedCmp,
    // Over the comparable subset only. Including events history never decided
    // would report the pipeline's backlog as a policy effect.
    measured_delta: {
      contacted: replayedCmp.contacted - baselineCmp.contacted,
      messages: replayedCmp.messages - baselineCmp.messages,
      cost_paise: replayedCmp.cost_paise - baselineCmp.cost_paise,
      blocked: replayedCmp.blocked - baselineCmp.blocked,
      deferred: replayedCmp.deferred - baselineCmp.deferred,
      systemic: replayedCmp.systemic - baselineCmp.systemic,
    },
    events_without_baseline_decision: noBaselineDecision,
    comparable_events: baselineCmp.events,
    modelled_revenue: {
      baseline_recovered_paise: baselineRecovered,
      replayed_recovered_paise: baselineRecovered + modelledDelta,
      delta_paise: modelledDelta,
      model:
        'Events the replayed policy would no longer contact are assumed to recover at the control arm’s observed organic rate; newly contacted events at the treated arms’ observed rate. Both rates come from this corpus.',
      inputs: {
        control_recovery_rate: controlRate,
        treated_recovery_rate: treatedRate,
        control_n: control.length,
        treated_n: treated.length,
      },
    },
    changed_decisions: changed,
    changed_count: changedCount,
    caveats,
    events_per_second: Math.round((corpus.length / elapsed) * 1000),
  };
}

function blank(): ReplayCounts {
  return {
    events: 0,
    systemic: 0,
    allowed: 0,
    deferred: 0,
    blocked: 0,
    contacted: 0,
    messages: 0,
    cost_paise: 0,
  };
}

/** Re-exported so callers do not need to reach into the triage module. */
export { bucketStart, cohortKey };
