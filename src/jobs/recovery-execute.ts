/**
 * `recovery.execute` — blueprint 6.6.
 *
 * Sleeps until the attempt is due, then acts. The sleep is the reason a durable
 * queue is load-bearing rather than decoration: recovery is inherently
 * time-shifted — wait for payday, wait out an outage, wait for the contact
 * window to open — and `setTimeout` does not survive a deploy.
 *
 * 🔒 The critical bit, and the blueprint calls it out explicitly: **re-check
 * the payment state and the policy at execution time.** Between planning and
 * execution the customer may have paid, opted out, complained, or the breaker
 * may have tripped. Acting on a decision made 48 hours ago is how a recovery
 * system messages someone who already paid.
 */
import { NonRetriableError } from 'inngest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { armAssignments, customers, messages, paymentEvents, policyEvaluations, recoveryAttempts } from '@/db/schema';
import { setEventState } from '@/core/events/transition';
import { buildPolicyContext } from '@/core/policy/context';
import { evaluatePolicy } from '@/core/policy/evaluate';
import { parsePolicy } from '@/core/policy/schema';
import { getLivePolicy } from '@/core/policy/store';
import { effectiveChannel, renderTemplate, whatsappBlockers } from '@/core/messaging/templates';
import { WhatsAppError, isWhatsappConfigured, sendTemplate } from '@/core/rails/whatsapp';
import { RazorpayError, createPaymentLink } from '@/core/rails/razorpay';
import { costOf, type CostItem } from '@/core/cost/meter';
import type { Rail } from '@/core/routing/static-table';
import { appendLedgerSafe } from '@/core/ledger/append';
import { env } from '@/lib/env';
import { inngest } from '@/lib/inngest';

const MERCHANT_NAME = 'Kirana Cloud';
/**
 * A business-initiated WhatsApp conversation must use a pre-approved template;
 * Meta rejects free text with error 131047. This name has to exist and be
 * approved in the Business account before the rail can send.
 */
const WHATSAPP_TEMPLATE = process.env.WHATSAPP_TEMPLATE_NAME || 'payment_retry_link';
/** Links outlive the contact window but not the customer's memory. */
const LINK_TTL_HOURS = 72;

export const recoveryExecute = inngest.createFunction(
  {
    id: 'recovery-execute',
    name: 'recovery.execute',
    retries: 3,
    /**
     * Razorpay rate-limits payment link creation, and this is the only job that
     * calls it. Found the hard way: a 600-event synthetic batch put a few
     * hundred link creations into flight at once and the API started returning
     * `Too many requests`. The errors are retriable so nothing was lost, but a
     * recovery rail that DDoSes its own provider under load is a rail that will
     * fail during an outage — which is precisely when every failed payment
     * arrives at once and every one of them wants a link.
     *
     * Throttling here rather than at the call site because Inngest's queue can
     * hold the work durably; a sleep inside the function would just occupy a
     * worker. `concurrency` caps how many run at once, `throttle` caps the rate.
     */
    concurrency: { limit: 5 },
    throttle: { limit: 40, period: '1m', burst: 5 },
  },
  { event: 'recovery.execute' },
  async ({ event, step }) => {
    const { eventId, attemptId, scheduledFor } = event.data;

    // Durable sleep. Survives redeploys, restarts and the laptop lid closing.
    await step.sleepUntil('wait-for-window', new Date(scheduledFor));

    const snapshot = await step.run('reload', async () => {
      const [attempt] = await db
        .select()
        .from(recoveryAttempts)
        .where(eq(recoveryAttempts.id, attemptId))
        .limit(1);
      if (!attempt) throw new NonRetriableError(`attempt ${attemptId} not found`);

      const [pe] = await db
        .select()
        .from(paymentEvents)
        .where(eq(paymentEvents.id, eventId))
        .limit(1);
      if (!pe) throw new NonRetriableError(`payment event ${eventId} not found`);

      const [customer] = pe.customerId
        ? await db.select().from(customers).where(eq(customers.id, pe.customerId)).limit(1)
        : [undefined];

      // Carried into the ledger so audit rows can be filtered by arm — without
      // it the ledger cannot answer "show me everything we did to the naive
      // arm", which is the question an experiment audit starts with.
      const [assignment] = await db
        .select({ arm: armAssignments.arm })
        .from(armAssignments)
        .where(eq(armAssignments.eventId, eventId))
        .limit(1);

      return { attempt, pe, customer: customer ?? null, arm: assignment?.arm ?? null };
    });

    // Already executed — a retry of this step must not send twice.
    if (snapshot.attempt.executedAt) {
      return { eventId, attemptId, skipped: 'already_executed' };
    }

    // The customer paid while we were waiting. This is a success, not a miss.
    if (snapshot.pe.state === 'recovered') {
      await step.run('mark-superseded', () =>
        db
          .update(recoveryAttempts)
          .set({ outcome: 'cancelled_payment_succeeded', outcomeAt: new Date() })
          .where(eq(recoveryAttempts.id, attemptId)),
      );
      return { eventId, attemptId, skipped: 'payment_already_succeeded' };
    }

    // ── Re-evaluate the policy against the world as it is now ──────────
    // 🔒 Inside a step, and it has to be. Inngest replays this function body
    // from the top at every step boundary; a gate left outside a step
    // re-evaluates each pass against counters the job itself has since moved.
    // That is not hypothetical — it marked a successfully sent attempt as
    // 'stopped'. See FAILURES.md #7.
    const decision = await step.run('recheck-policy', async () => {
      const live = await getLivePolicy();
      if (!live) throw new NonRetriableError('no live policy at execution time');
      const parsed = parsePolicy(live.yamlSource);
      if (!parsed.ok) throw new NonRetriableError(`live policy ${live.version} does not parse`);

      const at = new Date();
      const { context } = await buildPolicyContext(eventId, parsed.policy, at);
      const d = evaluatePolicy(parsed.policy, context);

      await db.insert(policyEvaluations).values({
        eventId,
        policyVersion: live.version,
        gateResult: d.gateResult,
        rulesTrace: d.rulesTrace,
      });

      return d;
    });

    if (decision.result !== 'allow') {
      await step.run('abandon', async () => {
        // Re-read rather than trusting the memoised snapshot: an attempt that
        // has already gone out cannot be un-sent, and marking it 'stopped'
        // would be a lie in the ledger.
        const [fresh] = await db
          .select({ executedAt: recoveryAttempts.executedAt })
          .from(recoveryAttempts)
          .where(eq(recoveryAttempts.id, attemptId))
          .limit(1);
        if (fresh?.executedAt) return;

        await db
          .update(recoveryAttempts)
          .set({ outcome: 'stopped', outcomeAt: new Date() })
          .where(eq(recoveryAttempts.id, attemptId));
        await setEventState(eventId, 'blocked_by_policy');
      });
      await step.run('ledger-blocked-at-execution', () =>
        appendLedgerSafe({
          eventId,
          arm: snapshot.arm,
          gateResult: decision.gateResult,
          action: 'blocked_at_execution',
          outcome: 'stopped',
          detail: {
            attempt_id: attemptId,
            reasons: decision.reasons,
            note: 'policy re-checked at execution time and no longer allowed the action',
          },
        }),
      );
      return { eventId, attemptId, blockedAtExecution: decision.gateResult };
    }

    // ── Create the link ────────────────────────────────────────────────
    const rail = snapshot.attempt.rail as Rail;
    // WhatsApp has no delivery path until Meta Cloud API credentials exist, and
    // a rail that notifies nobody while reporting `action_sent` is worse than
    // one that picks a channel it can actually reach. FAILURES.md #23.
    /**
     * A raw phone number is not stored anywhere in this system — `customers`
     * holds a sha256 and a display mask. Razorpay notifies on our behalf for
     * sms and email, which is precisely why those rails need no PII. WhatsApp
     * has no such arrangement, so DEMO_RECIPIENT_PHONE is the only number this
     * process can legitimately send to.
     */
    const demoPhone = process.env.DEMO_RECIPIENT_PHONE || null;
    const { channel, degradedFrom, why } = effectiveChannel(
      rail,
      isWhatsappConfigured(),
      demoPhone !== null,
    );

    const link = await step.run('create-payment-link', async () => {
      try {
        return await createPaymentLink({
          amountPaise: snapshot.pe.amountPaise,
          currency: snapshot.pe.currency,
          description: `Retry for ${snapshot.pe.id}`,
          // Razorpay notifies the customer directly, which is what makes this
          // rail end to end without a separate email or WhatsApp provider.
          notify: { sms: channel === 'sms', email: channel === 'email' },
          // The attempt's own UUID. Razorpay enforces reference_id uniqueness
          // per account, so this doubles as the idempotency key — and unlike
          // `${eventId}:${attemptNo}` it is fresh after a database reset, so
          // re-running the demo does not collide with last run's links.
          referenceId: attemptId,
          expireBy: new Date(Date.now() + LINK_TTL_HOURS * 3600_000),
          notes: {
            leakproof_event: eventId,
            rail,
            attempt: String(snapshot.attempt.attemptNo),
          },
        });
      } catch (err) {
        if (err instanceof RazorpayError && !err.retriable) {
          // A technical failure on our side is never counted as a customer
          // failure — that would poison the incrementality result.
          throw new NonRetriableError(`Razorpay rejected the link: ${err.code} ${err.message}`);
        }
        throw err;
      }
    });

    // ── Record the spend and the message ───────────────────────────────
    await step.run('record-send', async () => {
      // Priced on the channel that actually carried it, not the one the rail
      // asked for. Billing a WhatsApp rate for an SMS send would quietly
      // corrupt cost-per-₹100-recovered, which is a judged number.
      const costItem: CostItem =
        channel === 'whatsapp'
          ? 'whatsapp_utility_message'
          : channel === 'email'
            ? 'email_message'
            : 'sms_message';
      const cost = costOf(costItem) + costOf('payment_link_created');

      const body = renderTemplate(rail, {
        merchantName: MERCHANT_NAME,
        amountPaise: snapshot.pe.amountPaise,
        shortUrl: link.short_url,
        failureClass: 'n/a',
      });

      await db
        .update(recoveryAttempts)
        .set({ executedAt: new Date(), razorpayLinkId: link.id, costPaise: cost })
        .where(eq(recoveryAttempts.id, attemptId));

      /**
       * Every other rail is delivered by Razorpay's own notification on the
       * payment link. WhatsApp is not one of Razorpay's channels, so this is
       * the only rail that sends anything itself.
       */
      let whatsappMessageId: string | null = null;
      if (channel === 'whatsapp' && demoPhone) {
        try {
          const sent = await sendTemplate({
            to: demoPhone,
            templateName: WHATSAPP_TEMPLATE,
            variables: [MERCHANT_NAME, `₹${(snapshot.pe.amountPaise / 100).toFixed(0)}`],
            urlButtonSuffix: link.short_url.replace(/^https?:\/\//, ''),
          });
          whatsappMessageId = sent.messageId;
        } catch (err) {
          const e = err as WhatsAppError;
          // A send we could not make is not a contact. Recording it as one
          // would convert a treated event into an untreated one and bias the
          // incrementality result — the same trap as FAILURES.md #23.
          if (e.retriable) throw err;
          throw new NonRetriableError(`WhatsApp refused the send: ${e.code} ${e.message}`);
        }
      }

      await db.insert(messages).values({
        attemptId,
        channel,
        language: 'en',
        body,
        // Static template for now. composeMessage() over Gemini slots in behind
        // the same interface; until it does, every message is a fallback and
        // is honestly recorded as one.
        usedFallback: true,
        sentAt: new Date(),
        costPaise: costOf(costItem),
        providerMessageId: whatsappMessageId,
      });

      await setEventState(eventId, 'action_sent');
    });

    if (degradedFrom) {
      // A channel downgrade changes who the customer hears from, so it is a
      // decision and gets a receipt rather than a log line.
      await step.run('ledger-channel-degraded', () =>
        appendLedgerSafe({
          eventId,
          failureClass: 'unknown',
          action: 'channel_degraded',
          detail: {
            rail,
            intended_channel: degradedFrom,
            actual_channel: channel,
            why: why ?? 'unknown',
            blockers: whatsappBlockers(isWhatsappConfigured(), demoPhone !== null),
          },
        }),
      );
    }

    await step.run('ledger-sent', () =>
      appendLedgerSafe({
        eventId,
        arm: snapshot.arm,
        gateResult: decision.gateResult,
        action: 'action_sent',
        outcome: 'awaiting_response',
        costPaise: costOf(
          channel === 'whatsapp' ? 'whatsapp_utility_message' : channel === 'email' ? 'email_message' : 'sms_message',
        ) + costOf('payment_link_created'),
        detail: {
          attempt_id: attemptId,
          rail,
          channel,
          razorpay_link_id: link.id,
          short_url: link.short_url,
          used_fallback: true,
        },
      }),
    );

    return {
      eventId,
      attemptId,
      rail,
      channel,
      linkId: link.id,
      shortUrl: link.short_url,
      appUrl: env.appUrl,
    };
  },
);
