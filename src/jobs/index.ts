import { ingestWebhook } from './ingest-webhook';
import { triageClassify } from './triage-classify';

/** Every Inngest function the app serves. Register new jobs here. */
export const functions = [ingestWebhook, triageClassify];
