/**
 * `recovery.plan` — blueprint 6.6.
 *
 * Picks a rail, runs the policy gate, and either schedules an attempt or
 * records why it did not. Every outcome writes a `policy_evaluations` row,
 * including the blocks — a decision not to contact someone is a decision, and
 * the Decision Trace has to be able to show it.
 *
 * The control arm never reaches here. That is the entire experiment: 18% of
 * events are held out and receive no action, so recovery in the other arms can
 * be measured against what would have happened anyway.
 */
import { NonRetriableError } from 'inngest';
import { count, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { classifications, paymentEvents, policyEvaluations, recoveryAttempts } from '@/db/schema';
import { buildPolicyContext } from '@/core/policy/context';
import { evaluatePolicy } from '@/core/policy/evaluate';
import { parsePolicy } from '@/core/policy/schema';
import { getLivePolicy } from '@/core/policy/store';
import { RAIL_DELAY_HOURS, chooseRail, chooseRailNaive } from '@/core/routing/static-table';
import type { FailureClass } from '@/core/triage/taxonomy';
import { appendLedgerSafe } from '@/core/ledger/append';
import { inngest } from '@/lib/inngest';

export const recoveryPlan = inngest.createFunction(
  { id: 'recovery-plan', name: 'recovery.plan', retries: 3 },
  { event: 'event.assigned' },
  async ({ event, step }) => {
    const { eventId, arm } = event.data;

    // The held-out arm. No rail, no policy evaluation, no contact — it stays
    // 'at_risk' because that is exactly what it is.
    if (arm === 'control') {
      // Doing nothing to a held-out event is a decision, and the experiment's
      // credibility depends on being able to prove we did nothing.
      await step.run('ledger-held-out', () =>
        appendLedgerSafe({
          eventId,
          arm,
          action: 'held_out_control',
          outcome: 'no_action',
          detail: { reason: 'control arm — never contacted, by design' },
        }),
      );
      return { eventId, arm, action: 'held_out' };
    }

    const plan = await step.run('choose-rail', async () => {
      const [row] = await db
        .select({
          failureClass: classifications.failureClass,
          kind: classifications.kind,
          state: paymentEvents.state,
        })
        .from(paymentEvents)
        .leftJoin(classifications, eq(classifications.eventId, paymentEvents.id))
        .where(eq(paymentEvents.id, eventId))
        .limit(1);
      if (!row) throw new NonRetriableError(`payment event ${eventId} not found`);

      const [attempts] = await db
        .select({ n: count() })
        .from(recoveryAttempts)
        .where(eq(recoveryAttempts.eventId, eventId));
      const attemptNo = (attempts?.n ?? 0) + 1;

      const choice =
        arm === 'naive'
          ? chooseRailNaive(attemptNo)
          : chooseRail((row.failureClass ?? 'unknown') as FailureClass, attemptNo);

      return { ...choice, attemptNo, failureClass: row.failureClass ?? 'unknown', kind: row.kind };
    });

    const live = await step.run('load-policy', async () => {
      const p = await getLivePolicy();
      if (!p) throw new NonRetriableError('no live policy — seed one before planning recovery');
      return { version: p.version, yamlSource: p.yamlSource };
    });

    // 🔒 The gate runs INSIDE a step. Inngest replays the whole function body
    // on every step boundary, so anything non-deterministic left outside a
    // step re-executes with fresh inputs each pass — and the policy context
    // reads counters this very job is about to change. Memoising the decision
    // is what makes "the gate ran once" true. See FAILURES.md #7.
    const gate = await step.run('evaluate-gate', async () => {
      const parsed = parsePolicy(live.yamlSource);
      if (!parsed.ok) throw new NonRetriableError(`live policy ${live.version} does not parse`);

      const at = new Date();
      const { context } = await buildPolicyContext(eventId, parsed.policy, at);
      const decision = evaluatePolicy(parsed.policy, context);

      await db.insert(policyEvaluations).values({
        eventId,
        policyVersion: live.version,
        gateResult: decision.gateResult,
        rulesTrace: decision.rulesTrace,
      });

      return { decision, at: at.toISOString() };
    });

    const decision = gate.decision;
    const now = new Date(gate.at);

    // A rail of do_nothing is a real decision, not an absence of one, and is
    // recorded as an attempt so the trace shows we looked and chose to stop.
    if (plan.rail === 'do_nothing') {
      await step.run('record-do-nothing', async () => {
        await db.insert(recoveryAttempts).values({
          eventId,
          attemptNo: plan.attemptNo,
          rail: 'do_nothing',
          chosenBy: plan.chosenBy,
          railScores: plan.railScores,
          outcome: 'stopped',
          outcomeAt: new Date(),
        });
        await db.update(paymentEvents).set({ state: 'lost' }).where(eq(paymentEvents.id, eventId));
      });
      await step.run('ledger-do-nothing', () =>
        appendLedgerSafe({
          eventId,
          arm,
          failureClass: plan.failureClass,
          policyVersion: live.version,
          gateResult: decision.gateResult,
          action: 'rail_do_nothing',
          outcome: 'stopped',
          detail: { attempt_no: plan.attemptNo, why: plan.railScores.why },
        }),
      );
      return { eventId, arm, rail: 'do_nothing', gate: decision.gateResult };
    }

    if (decision.result === 'block') {
      await step.run('mark-blocked', () =>
        db
          .update(paymentEvents)
          .set({ state: 'blocked_by_policy' })
          .where(eq(paymentEvents.id, eventId)),
      );
      await step.run('ledger-blocked', () =>
        appendLedgerSafe({
          eventId,
          arm,
          failureClass: plan.failureClass,
          policyVersion: live.version,
          gateResult: decision.gateResult,
          action: 'blocked_by_policy',
          outcome: 'no_action',
          detail: { rail: plan.rail, reasons: decision.reasons, rules_trace: decision.rulesTrace },
        }),
      );
      return { eventId, arm, rail: plan.rail, gate: decision.gateResult, reasons: decision.reasons };
    }

    // Two things can move an attempt into the future: the policy deferring it
    // out of a closed contact window, and the rail's own delay (waiting for
    // payday before retrying an insufficient-funds card). Take the later.
    const gateTime = decision.deferUntil ? new Date(decision.deferUntil) : now;
    const railDelayHours = RAIL_DELAY_HOURS[plan.rail] ?? 0;
    const railTime = new Date(now.getTime() + railDelayHours * 3600_000);
    const scheduledFor = gateTime > railTime ? gateTime : railTime;

    const attemptId = await step.run('schedule-attempt', async () => {
      const [row] = await db
        .insert(recoveryAttempts)
        .values({
          eventId,
          attemptNo: plan.attemptNo,
          rail: plan.rail,
          chosenBy: plan.chosenBy,
          railScores: plan.railScores,
          scheduledFor,
        })
        .returning({ id: recoveryAttempts.id });

      await db
        .update(paymentEvents)
        .set({ state: decision.result === 'defer' ? 'deferred' : 'planned' })
        .where(eq(paymentEvents.id, eventId));

      return row.id;
    });

    await step.run('ledger-planned', () =>
      appendLedgerSafe({
        eventId,
        arm,
        failureClass: plan.failureClass,
        policyVersion: live.version,
        gateResult: decision.gateResult,
        action: decision.result === 'defer' ? 'deferred' : 'planned',
        detail: {
          rail: plan.rail,
          chosen_by: plan.chosenBy,
          rail_alternatives: plan.railScores.considered,
          why: plan.railScores.why,
          attempt_no: plan.attemptNo,
          scheduled_for: scheduledFor.toISOString(),
          rules_trace: decision.rulesTrace,
        },
      }),
    );

    await step.sendEvent('queue-execution', {
      name: 'recovery.execute',
      data: { eventId, attemptId, scheduledFor: scheduledFor.toISOString() },
    });

    return {
      eventId,
      arm,
      rail: plan.rail,
      attemptNo: plan.attemptNo,
      gate: decision.gateResult,
      scheduledFor: scheduledFor.toISOString(),
    };
  },
);
