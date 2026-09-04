/**
 * The Decision Trace — blueprint Screen 3, "the trust screen".
 *
 * Seven cards, each showing the raw input and the rule output that acted on it.
 * The point is that a judge can click any row and follow the decision all the
 * way from the Razorpay error payload to the ledger hash without being asked to
 * take anything on faith. So every card carries the *numbers that were
 * compared*, not a summary of them.
 */
import { asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  armAssignments,
  auditLedger,
  classifications,
  customers,
  messages,
  paymentEvents,
  policyEvaluations,
  recoveryAttempts,
} from '@/db/schema';

export async function loadTrace(eventId: string) {
  const [event] = await db
    .select()
    .from(paymentEvents)
    .where(eq(paymentEvents.id, eventId))
    .limit(1);
  if (!event) return null;

  const [customer] = event.customerId
    ? await db.select().from(customers).where(eq(customers.id, event.customerId)).limit(1)
    : [];

  const [classification] = await db
    .select()
    .from(classifications)
    .where(eq(classifications.eventId, eventId))
    .limit(1);

  const [arm] = await db
    .select()
    .from(armAssignments)
    .where(eq(armAssignments.eventId, eventId))
    .limit(1);

  const evaluations = await db
    .select()
    .from(policyEvaluations)
    .where(eq(policyEvaluations.eventId, eventId))
    .orderBy(asc(policyEvaluations.evaluatedAt));

  const attempts = await db
    .select()
    .from(recoveryAttempts)
    .where(eq(recoveryAttempts.eventId, eventId))
    .orderBy(asc(recoveryAttempts.attemptNo));

  const msgs = attempts.length
    ? await db
        .select()
        .from(messages)
        .where(eq(messages.attemptId, attempts[attempts.length - 1].id))
    : [];

  // Every ledger record touching this event, in chain order — the receipts.
  const ledger = await db
    .select({
      seq: auditLedger.seq,
      ts: auditLedger.ts,
      action: auditLedger.action,
      failureClass: auditLedger.failureClass,
      detail: auditLedger.detail,
      hash: auditLedger.hash,
      prevHash: auditLedger.prevHash,
    })
    .from(auditLedger)
    .where(eq(auditLedger.eventId, eventId))
    .orderBy(asc(auditLedger.seq));

  return {
    event: {
      id: event.id,
      surface: event.surface,
      state: event.state,
      amount_paise: event.amountPaise,
      currency: event.currency,
      method: event.method,
      issuer: event.issuer,
      card_network: event.cardNetwork,
      order_id: event.orderId,
      amount_band: event.amountBand,
      time_bucket: event.timeBucket,
      is_synthetic: event.isSynthetic,
      batch_id: event.batchId,
      failed_at: event.failedAt.toISOString(),
      recovered_at: event.recoveredAt?.toISOString() ?? null,
      recovered_paise: event.recoveredPaise,
      // Razorpay's structured taxonomy, shown raw — the drawer renders it in
      // mono. A normalised summary here would hide exactly what the classifier
      // had to work with.
      error: {
        code: event.errCode,
        description: event.errDescription,
        source: event.errSource,
        step: event.errStep,
        reason: event.errReason,
      },
      customer: customer
        ? {
            id: customer.id,
            phone_masked: customer.phoneMasked,
            email_masked: customer.emailMasked,
            opted_out_at: customer.optedOutAt?.toISOString() ?? null,
            opt_out_reason: customer.optOutReason,
          }
        : null,
    },
    classification: classification
      ? {
          kind: classification.kind,
          failure_class: classification.failureClass,
          confidence: Number(classification.confidence),
          cohort_key: classification.cohortKey,
          cohort_decline_rate:
            classification.cohortDeclineRate === null
              ? null
              : Number(classification.cohortDeclineRate),
          cohort_n: classification.cohortN,
          downtime_api_agrees: classification.downtimeApiAgrees,
          classified_at: classification.classifiedAt.toISOString(),
        }
      : null,
    arm: arm
      ? {
          arm: arm.arm,
          bucket: arm.bucket,
          // The reproducibility claim, made checkable. The salt itself is
          // never returned — only that a salt of this version was used.
          hash_input_sha256: arm.hashInput,
          salt_version: arm.saltVersion,
          assigned_at: arm.assignedAt.toISOString(),
          note: 'arm = first 8 hex of sha256(event_id + salt) % 100; reproducible forever',
        }
      : null,
    policy_evaluations: evaluations.map((e) => ({
      policy_version: e.policyVersion,
      gate_result: e.gateResult,
      /** Each rule with the values actually compared — the checklist. */
      rules_trace: e.rulesTrace,
      evaluated_at: e.evaluatedAt.toISOString(),
    })),
    attempts: attempts.map((a) => ({
      id: a.id,
      attempt_no: a.attemptNo,
      rail: a.rail,
      chosen_by: a.chosenBy,
      rail_scores: a.railScores,
      scheduled_for: a.scheduledFor?.toISOString() ?? null,
      executed_at: a.executedAt?.toISOString() ?? null,
      razorpay_link_id: a.razorpayLinkId,
      outcome: a.outcome,
      outcome_at: a.outcomeAt?.toISOString() ?? null,
      cost_paise: a.costPaise,
    })),
    messages: msgs.map((m) => ({
      channel: m.channel,
      body: m.body,
      llm_model: m.llmModel,
      llm_prompt_hash: m.llmPromptHash,
      tokens_in: m.llmTokensIn,
      tokens_out: m.llmTokensOut,
      cost_paise: m.costPaise,
      is_fallback: m.usedFallback,
      sent_at: m.sentAt?.toISOString() ?? null,
    })),
    ledger: ledger.map((l) => ({
      seq: Number(l.seq),
      ts: l.ts.toISOString(),
      action: l.action,
      failure_class: l.failureClass,
      detail: l.detail,
      hash: l.hash,
      prev_hash: l.prevHash,
    })),
  };
}

export type DecisionTrace = NonNullable<Awaited<ReturnType<typeof loadTrace>>>;
