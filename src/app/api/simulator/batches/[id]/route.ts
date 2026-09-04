/**
 * GET /api/simulator/batches/:id — the batch, plus how the system scored on it.
 *
 * This is the endpoint that makes the generator worth having. It puts what was
 * planted next to what was measured:
 *
 *  - detection: precision and recall of the systemic classifier against the
 *    per-event ground truth, so "we detect outages" is a number rather than a
 *    claim.
 *  - incrementality: the estimator's interval against the *counterfactual*
 *    truth — the rupees that recovered only because the arm was treated. Not a
 *    difference in sample means, which is what the estimator itself computes;
 *    scoring an estimator against its own formula would prove nothing.
 */
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { classifications, paymentEvents } from '@/db/schema';
import { getBatch } from '@/core/simulator/store';
import { metricsSummary } from '@/core/experiment/metrics-store';
import type { GroundTruth } from '@/core/simulator/generate';
import { errorResponse, requestId } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const reqId = requestId();
  const { id } = await ctx.params;

  const batch = await getBatch(id);
  if (!batch) return errorResponse(404, 'BAD_REQUEST', `no batch ${id}`, undefined, reqId);

  const truth = (batch.groundTruth ?? null) as GroundTruth | null;

  // ── detection scorecard ──
  let detection: Record<string, unknown> | null = null;
  if (truth) {
    const rows = await db
      .select({ eventId: classifications.eventId, kind: classifications.kind })
      .from(classifications)
      .innerJoin(paymentEvents, eq(paymentEvents.id, classifications.eventId))
      .where(eq(paymentEvents.batchId, id));

    const systemicTruth = new Set(truth.systemicEventIds);
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const r of rows) {
      const predicted = r.kind === 'systemic';
      if (predicted && systemicTruth.has(r.eventId)) tp += 1;
      else if (predicted) fp += 1;
      else if (systemicTruth.has(r.eventId)) fn += 1;
    }

    const precision = tp + fp === 0 ? null : tp / (tp + fp);
    const recall = tp + fn === 0 ? null : tp / (tp + fn);
    detection = {
      classified: rows.length,
      // Ground-truth positives whose events have not been classified yet show
      // up as neither TP nor FN, so report coverage rather than implying the
      // run is complete when it is still draining through Inngest.
      ground_truth_systemic: systemicTruth.size,
      true_positives: tp,
      false_positives: fp,
      false_negatives: fn,
      precision,
      recall,
      f1:
        precision === null || recall === null || precision + recall === 0
          ? null
          : (2 * precision * recall) / (precision + recall),
      /**
       * A batch still draining through Inngest has ground-truth positives whose
       * events are not classified yet. Those are neither a true positive nor a
       * false negative, so recall computed mid-run reads better than it is.
       * Report how much of the truth has actually been scored rather than
       * letting a partial number look final.
       */
      ground_truth_scored_pct:
        systemicTruth.size === 0 ? null : Number(((100 * (tp + fn)) / systemicTruth.size).toFixed(1)),
    };
  }

  // ── incrementality scorecard ──
  let incrementality: Record<string, unknown> | null = null;
  if (truth?.trueIncrementalPaise !== null && truth?.trueIncrementalPaise !== undefined) {
    const measured = await metricsSummary({ batchId: id });
    const [lo, hi] = measured.ci95_paise;
    const planted = truth.trueIncrementalPaise;
    incrementality = {
      planted_incremental_paise: planted,
      planted_incremental_recoveries: truth.trueIncrementalRecoveries,
      measured_incremental_paise: measured.incremental_paise,
      ci95_paise: measured.ci95_paise,
      interval_covers_truth: planted >= lo && planted <= hi,
      point_error_pct:
        planted === 0 ? null : ((measured.incremental_paise - planted) / planted) * 100,
      planted_lift_pp: truth.realisedLiftPp
        ? Number((truth.realisedLiftPp.leakproof * 100).toFixed(2))
        : null,
      measured_lift_pp: measured.lift_vs_control_pp,
      measured_lift_ci95_pp: measured.lift_vs_control_ci95_pp,
      powered: measured.powered,
      power_blockers: measured.power_blockers,
      caveats: measured.caveats,
      note:
        'The planted figure is counterfactual: the rupees that recovered only because the ' +
        'arm was treated, known per event because a single uniform draw decides both worlds. ' +
        'On a heavy-tailed corpus the point estimate is noisy even when the rate lift is clean, ' +
        'which is exactly what the interval is for — read the interval, not the point.',
    };
  }

  return NextResponse.json(
    {
      batch: {
        id: batch.id,
        label: batch.label,
        status: batch.status,
        error: batch.error,
        spec: batch.spec,
        summary: batch.summary,
        n_events: batch.nEvents,
        n_accepted: batch.nAccepted,
        n_rejected: batch.nRejected,
        created_at: batch.createdAt,
        completed_at: batch.completedAt,
      },
      ground_truth: truth
        ? {
            outage: truth.outage
              ? {
                  issuer: truth.outage.issuer,
                  method: truth.outage.method,
                  started_at: truth.outage.startedAt,
                  ended_at: truth.outage.endedAt,
                  systemic_events: truth.outage.systemicEventIds.length,
                  coincident_idiosyncratic: truth.outage.coincidentIdiosyncraticIds.length,
                }
              : null,
            systemic_events: truth.systemicEventIds.length,
            arm_outcomes: truth.armOutcomes,
          }
        : null,
      detection,
      incrementality,
    },
    { status: 200, headers: { 'x-request-id': reqId } },
  );
}
