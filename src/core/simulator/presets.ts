/**
 * Named batch specs — blueprint Screen 9's `PresetButtons`.
 *
 * Presets are here rather than in the UI so the API, the CLI and the panel demo
 * all press the same button. A demo that runs a subtly different spec from the
 * one documented is a demo of nothing.
 */
import type { BatchSpec } from './generate';

export type PresetName = 'demo' | 'outage_stress' | 'adversarial' | 'null_test' | 'panel';

export interface Preset {
  label: string;
  description: string;
  /** Everything but `endsAt`, which is always "now" at call time. */
  spec: Omit<BatchSpec, 'endsAt' | 'treatmentResponse'> & {
    treatmentResponse: { naiveUpliftPp: number; leakproofUpliftPp: number } | null;
  };
}

export const PRESETS: Record<PresetName, Preset> = {
  demo: {
    label: 'Demo batch (3,000)',
    description:
      'A day of traffic with a 45-minute HDFC card issuer outage. Treatment response is simulated, so the lift is planted by construction — it validates the estimator, it is not evidence the product works on real traffic.',
    spec: {
      count: 3000,
      seed: 20260904,
      windowHours: 24,
      injectOutage: { issuer: 'HDFC', method: 'card', durationMin: 45, spikePct: 62 },
      organicRecoveryRate: 0.11,
      adversarialPct: 0.05,
      paydayStrength: 0.8,
      treatmentResponse: { naiveUpliftPp: 0.04, leakproofUpliftPp: 0.14 },
    },
  },
  null_test: {
    label: 'A/A null test',
    description:
      'Identical to the demo batch with the treatment response removed: all three arms recover at the same rate, so the true lift is exactly zero. The point is to check the estimator reports nothing. An A/A test that shows a lift means the measurement is broken, and no amount of A/B result can be trusted after that.',
    spec: {
      count: 3000,
      seed: 20260905,
      windowHours: 24,
      injectOutage: { issuer: 'HDFC', method: 'card', durationMin: 45, spikePct: 62 },
      organicRecoveryRate: 0.11,
      adversarialPct: 0.05,
      paydayStrength: 0.8,
      treatmentResponse: null,
    },
  },
  outage_stress: {
    label: 'Outage stress',
    description:
      'A three-hour issuer degradation at 78% decline, on a compressed six-hour window so the cohort is dense. Exercises the circuit breaker and the outage radar rather than the recovery rails.',
    spec: {
      count: 4000,
      seed: 20260906,
      windowHours: 6,
      injectOutage: { issuer: 'ICICI', method: 'card', durationMin: 180, spikePct: 78 },
      organicRecoveryRate: 0.09,
      adversarialPct: 0.04,
      paydayStrength: 0.3,
      treatmentResponse: { naiveUpliftPp: 0.03, leakproofUpliftPp: 0.12 },
    },
  },
  adversarial: {
    label: 'Adversarial only',
    description:
      'A third of events carry hostile shapes: unlabelled errors, duplicate deliveries, recoveries that arrive before their failure, opted-out customers and webhooks hours late. No outage — this is about whether the pipeline stays honest, not whether it detects anything.',
    spec: {
      count: 1200,
      seed: 20260907,
      windowHours: 12,
      injectOutage: null,
      organicRecoveryRate: 0.12,
      adversarialPct: 0.33,
      paydayStrength: 0.5,
      treatmentResponse: { naiveUpliftPp: 0.04, leakproofUpliftPp: 0.14 },
    },
  },
  panel: {
    label: 'Panel demo (90 seconds)',
    description:
      'Small and fast: four hours of dense traffic with a 40-minute outage that ends just before the window does, so the tower shows a fresh incident. Sized to land in the tables while a judge is still watching.',
    spec: {
      count: 600,
      seed: 20260908,
      windowHours: 4,
      injectOutage: { issuer: 'HDFC', method: 'card', durationMin: 40, spikePct: 68 },
      organicRecoveryRate: 0.11,
      adversarialPct: 0.06,
      paydayStrength: 0.6,
      treatmentResponse: { naiveUpliftPp: 0.04, leakproofUpliftPp: 0.14 },
    },
  },
};

/**
 * The label that goes on the batch record.
 *
 * A preset's label carries its default size — "Demo batch (3,000)" — so a run
 * with `--count 9000` would be filed under a name stating the wrong number.
 * That name is not internal: the Incrementality Lab prints it beside the corpus
 * it is measuring, so a mislabelled batch reads as a corpus three times smaller
 * than the one the headline was computed over. Rewrite the parenthetical when
 * the count was overridden rather than let a record disagree with its own
 * contents.
 */
export function batchLabel(preset: Preset, count: number): string {
  if (count === preset.spec.count) return preset.label;
  const base = preset.label.replace(/\s*\([^)]*\)\s*$/, '');
  return `${base} (${count.toLocaleString('en-IN')})`;
}
