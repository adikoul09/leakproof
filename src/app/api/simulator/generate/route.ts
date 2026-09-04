/**
 * POST /api/simulator/generate — blueprint 6.4.
 *
 * Body is either a named preset or an explicit spec:
 *   { "preset": "demo" }
 *   { "count": 3000, "seed": 20260904, "inject_outage": {...}, ... }
 *
 * Returns 202 `{ batch_id }` immediately and does the work in Inngest. A
 * three-thousand-failure batch is thirty thousand events through the real
 * pipeline; running that inside the request would time out on any serverless
 * platform, and holding the connection open would be lying about what is done.
 *
 * Operator-guarded. The demo URL is public, and an open endpoint that writes
 * tens of thousands of rows to the judged database is a hole.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { BatchSpec, NormalizedSpec } from '@/core/simulator/generate';
import { generateBatch } from '@/core/simulator/generate';
import { PRESETS, type PresetName } from '@/core/simulator/presets';
import { createBatch } from '@/core/simulator/store';
import { requireOperator } from '@/lib/auth';
import { optional } from '@/lib/env';
import { errorResponse, requestId } from '@/lib/errors';
import { inngest } from '@/lib/inngest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const outageSchema = z.object({
  issuer: z.string().min(1),
  method: z.enum(['upi', 'card', 'netbanking', 'wallet']),
  duration_min: z.number().int().min(1).max(1440),
  /** Decline rate inside the window as a percentage, not a delta on baseline. */
  spike_pct: z.number().min(1).max(100),
  start_offset_min: z.number().int().min(0).optional(),
});

const specSchema = z.object({
  count: z.number().int().min(1).max(20_000),
  seed: z.number().int(),
  window_hours: z.number().int().min(1).max(168).default(24),
  inject_outage: outageSchema.nullable().default(null),
  organic_recovery_rate: z.number().min(0).max(0.95).default(0.11),
  adversarial_pct: z.number().min(0).max(1).default(0.05),
  payday_strength: z.number().min(0).max(1).default(0.8),
  subscription_share: z.number().min(0).max(0.5).default(0.06),
  /**
   * Simulated response to treatment. Null plants NO effect — the A/A null test,
   * where a correct estimator must report a lift indistinguishable from zero.
   */
  treatment_response: z
    .object({ naive_uplift_pp: z.number().min(0).max(0.9), leakproof_uplift_pp: z.number().min(0).max(0.9) })
    .nullable()
    .default(null),
  label: z.string().max(120).optional(),
});

const bodySchema = z.union([
  z.object({ preset: z.enum(['demo', 'null_test', 'outage_stress', 'adversarial', 'panel']) }),
  specSchema,
]);

/** Build the generator's spec. `endsAt` is always now — a batch is history. */
function toSpec(body: z.infer<typeof specSchema>, armSalt: string | null): BatchSpec {
  return {
    count: body.count,
    seed: body.seed,
    windowHours: body.window_hours,
    endsAt: new Date(),
    injectOutage: body.inject_outage
      ? {
          issuer: body.inject_outage.issuer,
          method: body.inject_outage.method,
          durationMin: body.inject_outage.duration_min,
          spikePct: body.inject_outage.spike_pct,
          startOffsetMin: body.inject_outage.start_offset_min,
        }
      : null,
    organicRecoveryRate: body.organic_recovery_rate,
    adversarialPct: body.adversarial_pct,
    paydayStrength: body.payday_strength,
    subscriptionShare: body.subscription_share,
    treatmentResponse:
      body.treatment_response && armSalt
        ? {
            naiveUpliftPp: body.treatment_response.naive_uplift_pp,
            leakproofUpliftPp: body.treatment_response.leakproof_uplift_pp,
            armSalt,
          }
        : null,
  };
}

function fromPreset(name: PresetName, armSalt: string | null): { spec: BatchSpec; label: string } {
  const p = PRESETS[name];
  return {
    spec: {
      ...p.spec,
      endsAt: new Date(),
      treatmentResponse:
        p.spec.treatmentResponse && armSalt ? { ...p.spec.treatmentResponse, armSalt } : null,
    },
    label: p.label,
  };
}

export async function GET() {
  // The presets are the documented menu; expose them so the UI and any curious
  // reader see the same list the API accepts.
  return NextResponse.json({
    presets: Object.entries(PRESETS).map(([name, p]) => ({
      name,
      label: p.label,
      description: p.description,
      spec: p.spec,
    })),
  });
}

export async function POST(req: Request) {
  const reqId = requestId();

  const auth = requireOperator(req);
  if (!auth.ok) return errorResponse(401, 'UNAUTHORIZED', auth.reason, undefined, reqId);

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return errorResponse(400, 'BAD_REQUEST', 'Body is not valid JSON', undefined, reqId);
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return errorResponse(
      422,
      'BAD_REQUEST',
      'Simulator spec failed validation',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      reqId,
    );
  }

  const armSalt = optional.armSalt();
  const { spec, label } =
    'preset' in parsed.data
      ? fromPreset(parsed.data.preset, armSalt)
      : { spec: toSpec(parsed.data, armSalt), label: parsed.data.label ?? null };

  if (spec.treatmentResponse === null && !armSalt) {
    // Silently degrading to the null test would be the worst of both: the
    // caller asked for a planted effect and would get a flat result they might
    // read as a real finding.
    const wantedEffect =
      'preset' in parsed.data
        ? PRESETS[parsed.data.preset].spec.treatmentResponse !== null
        : parsed.data.treatment_response !== null;
    if (wantedEffect) {
      return errorResponse(
        503,
        'STORAGE_UNAVAILABLE',
        'ARM_ASSIGNMENT_SALT is not configured, so a treatment response cannot be planted. ' +
          'Set the salt, or request treatment_response: null for the A/A null test.',
        undefined,
        reqId,
      );
    }
  }

  // Generate once here purely to echo the plan back — it is cheap, pure, and
  // means the caller learns the corpus size and the planted ground truth
  // immediately rather than polling to find out what they asked for.
  const preview = generateBatch(spec);
  const batchId = await createBatch(preview.spec as NormalizedSpec, label);

  await inngest.send({ name: 'simulator.generate', data: { batchId } });

  return NextResponse.json(
    {
      batch_id: batchId,
      status: 'generating',
      spec: preview.spec,
      summary: preview.summary,
      ground_truth: {
        outage: preview.groundTruth.outage
          ? {
              issuer: preview.groundTruth.outage.issuer,
              method: preview.groundTruth.outage.method,
              started_at: preview.groundTruth.outage.startedAt,
              ended_at: preview.groundTruth.outage.endedAt,
              systemic_events: preview.groundTruth.outage.systemicEventIds.length,
              coincident_idiosyncratic: preview.groundTruth.outage.coincidentIdiosyncraticIds.length,
            }
          : null,
        true_incremental_paise: preview.groundTruth.trueIncrementalPaise,
        true_incremental_recoveries: preview.groundTruth.trueIncrementalRecoveries,
        realised_lift_pp: preview.groundTruth.realisedLiftPp,
      },
    },
    { status: 202, headers: { 'x-request-id': reqId } },
  );
}
