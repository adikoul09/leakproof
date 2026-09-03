import { EventSchemas, Inngest } from 'inngest';

type Events = {
  /** A signature-verified Razorpay webhook has been persisted as a receipt. */
  'webhook.received': {
    data: { receiptId: string; eventType: string };
  };
  /** A payment_events row exists and is waiting to be classified. */
  'event.ready_for_triage': {
    data: { eventId: string; source: 'webhook' | 'simulator' };
  };
  /** Classification written. Downstream: experiment.assign. */
  'event.classified': {
    data: { eventId: string; kind: string; failureClass: string; confidence: number };
  };
  /** Arm assigned. Downstream: recovery.plan (unless the arm is control). */
  'event.assigned': {
    data: { eventId: string; arm: 'control' | 'naive' | 'leakproof'; bucket: number };
  };
  /** An attempt is scheduled. The job sleeps until scheduledFor, then acts. */
  'recovery.execute': {
    data: { eventId: string; attemptId: string; scheduledFor: string };
  };
};

export const inngest = new Inngest({
  id: 'leakproof',
  schemas: new EventSchemas().fromRecord<Events>(),
});

export type LeakproofEvents = Events;
