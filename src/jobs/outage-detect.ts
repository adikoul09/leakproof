/**
 * `outage.detect` — blueprint 6.6, cron every 5 minutes.
 *
 * Opens, extends and closes outage windows from the classifier's own verdicts,
 * then cross-checks each one against Razorpay's Payment Downtime API.
 *
 * The classifier never sees the API's answer. That is the whole point: an
 * agreement number computed by a detector that was told the answer is a
 * statement about a copy, not a detector.
 *
 * It deliberately does NOT advance the EWMA baseline, which is the job the
 * blueprint assigns here. Measured, then not built: advancing it from closed
 * 5-minute buckets drops recall from 97% to 0.8%, because a bucket holds ~6
 * attempts and an EWMA cannot tell that sampling noise from real volatility.
 * See FAILURES.md #11 and the comment on `seedBaselineRate`.
 */
import { detectOutages } from '@/core/outage/detect';
import { appendLedgerSafe } from '@/core/ledger/append';
import { inngest } from '@/lib/inngest';

export const outageDetect = inngest.createFunction(
  { id: 'outage-detect', name: 'outage.detect', retries: 2 },
  [{ cron: '*/5 * * * *' }, { event: 'outage.detect' }],
  async ({ step }) => {
    const result = await step.run('detect', () => detectOutages({ now: new Date() }));

    // Opening or closing an outage window changes what the tower tells an
    // operator and, through the breaker, what the system is willing to do. That
    // is a decision, so it gets a receipt.
    if (result.opened > 0 || result.closed > 0) {
      await step.run('ledger', () =>
        appendLedgerSafe({
          eventId: null,
          failureClass: 'unknown',
          action: 'outage_windows_updated',
          detail: {
            opened: result.opened,
            closed: result.closed,
            extended: result.extended,
            downtime_api_rows: result.downtimeRows,
            agreement_backfilled: result.agreementSet,
            windows: result.windows,
            notes: result.notes,
          },
        }),
      );
    }

    return result;
  },
);
