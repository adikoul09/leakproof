import { experimentAssign } from './experiment-assign';
import { ingestWebhook } from './ingest-webhook';
import { metricsRollup } from './metrics-rollup';
import { recoveryExecute } from './recovery-execute';
import { recoveryPlan } from './recovery-plan';
import { triageClassify } from './triage-classify';

/**
 * Every Inngest function the app serves.
 *   pipeline: webhook → classify → assign → plan → execute
 *   crons:    metrics.rollup
 */
export const functions = [
  ingestWebhook,
  triageClassify,
  experimentAssign,
  recoveryPlan,
  recoveryExecute,
  metricsRollup,
];
