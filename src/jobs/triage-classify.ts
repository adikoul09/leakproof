/**
 * `triage.classify` — blueprint 6.6.
 *
 * Reads the cohort's rolling window and runs the pure classifier.
 *
 * It deliberately does NOT advance the EWMA baseline. Nudging the baseline
 * once per classified event means a live outage teaches the baseline that
 * outages are normal: after a handful of events the 3σ threshold has climbed
 * past the very spike it is meant to catch, and detection dies exactly when it
 * matters. Baseline maintenance belongs to the `outage.detect` cron, which can
 * see whether a window is currently flagged and skip it — see
 * `postgresCohortStore.updateBaseline`, called from there and nowhere else.
 */
import { NonRetriableError } from 'inngest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { classifications, paymentEvents } from '@/db/schema';
import { classify, cohortDim, cohortKey } from '@/core/triage/classifier';
import { postgresCohortStore } from '@/core/triage/cohort-store';
import { inngest } from '@/lib/inngest';

export const triageClassify = inngest.createFunction(
  { id: 'triage-classify', name: 'triage.classify', retries: 3 },
  { event: 'event.ready_for_triage' },
  async ({ event, step }) => {
    const { eventId } = event.data;

    const pe = await step.run('load-event', async () => {
      const [row] = await db
        .select()
        .from(paymentEvents)
        .where(eq(paymentEvents.id, eventId))
        .limit(1);
      if (!row) throw new NonRetriableError(`payment event ${eventId} not found`);
      return row;
    });

    // step.run serialises through JSON, so timestamps come back as strings.
    const failedAt = new Date(pe.failedAt);
    const dim = cohortDim({ issuer: pe.issuer, method: pe.method, amountPaise: pe.amountPaise });

    await step.run('mark-classifying', () =>
      db.update(paymentEvents).set({ state: 'classifying' }).where(eq(paymentEvents.id, eventId)),
    );

    const { window, baseline } = await step.run('read-cohort', async () => ({
      window: await postgresCohortStore.window(dim, failedAt),
      baseline: await postgresCohortStore.baseline(dim),
    }));

    const result = classify({
      issuer: pe.issuer,
      method: pe.method,
      amountPaise: pe.amountPaise,
      failedAt,
      error: {
        code: pe.errCode,
        description: pe.errDescription,
        source: pe.errSource,
        step: pe.errStep,
        reason: pe.errReason,
      },
      window,
      baseline,
    });

    await step.run('write-classification', async () => {
      await db
        .insert(classifications)
        .values({
          eventId,
          kind: result.kind,
          failureClass: result.failureClass,
          confidence: result.confidence.toFixed(3),
          cohortKey: cohortKey({
            issuer: pe.issuer,
            method: pe.method,
            amountPaise: pe.amountPaise,
            failedAt,
          }),
          cohortDeclineRate: result.cohortDeclineRate.toFixed(4),
          cohortN: result.cohortN,
          // Recorded by outage.detect against the Payment Downtime API, never
          // used as a classifier input — see blueprint 6.5 step 5.
          downtimeApiAgrees: null,
        })
        .onConflictDoUpdate({
          target: classifications.eventId,
          set: {
            kind: result.kind,
            failureClass: result.failureClass,
            confidence: result.confidence.toFixed(3),
            cohortDeclineRate: result.cohortDeclineRate.toFixed(4),
            cohortN: result.cohortN,
            classifiedAt: new Date(),
          },
        });
    });

    await step.sendEvent('announce', {
      name: 'event.classified',
      data: {
        eventId,
        kind: result.kind,
        failureClass: result.failureClass,
        confidence: result.confidence,
      },
    });

    return {
      eventId,
      kind: result.kind,
      failureClass: result.failureClass,
      confidence: result.confidence,
      verdict: result.trace.verdict,
    };
  },
);
