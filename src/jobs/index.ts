import { experimentAssign } from './experiment-assign';
import { ingestWebhook } from './ingest-webhook';
import { ledgerVerify } from './ledger-verify';
import { metricsRollup } from './metrics-rollup';
import { recoveryExecute } from './recovery-execute';
import { recoveryPlan } from './recovery-plan';
import { simulatorGenerate, simulatorGenerateFailed } from './simulator-generate';
import { triageClassify } from './triage-classify';

/**
 * Every Inngest function the app serves.
 *   pipeline:  webhook → classify → assign → plan → execute
 *   simulator: simulator.generate → the same pipeline, from the top
 *   crons:     metrics.rollup, ledger.verify
 */
export const functions = [
  ingestWebhook,
  triageClassify,
  experimentAssign,
  recoveryPlan,
  recoveryExecute,
  metricsRollup,
  ledgerVerify,
  simulatorGenerate,
  simulatorGenerateFailed,
];
