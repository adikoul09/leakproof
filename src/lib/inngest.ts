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
};

export const inngest = new Inngest({
  id: 'leakproof',
  schemas: new EventSchemas().fromRecord<Events>(),
});

export type LeakproofEvents = Events;
