import { experimentAssign } from './experiment-assign';
import { ingestWebhook } from './ingest-webhook';
import { recoveryExecute } from './recovery-execute';
import { recoveryPlan } from './recovery-plan';
import { triageClassify } from './triage-classify';

/**
 * Every Inngest function the app serves, in pipeline order:
 *   webhook → classify → assign → plan → execute
 */
export const functions = [
  ingestWebhook,
  triageClassify,
  experimentAssign,
  recoveryPlan,
  recoveryExecute,
];
