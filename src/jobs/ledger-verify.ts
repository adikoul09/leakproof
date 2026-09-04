/**
 * `ledger.verify` — blueprint 6.6, cron hourly.
 *
 * A hash chain nobody checks is decoration. This runs the same verification
 * the public endpoint exposes, and throws on a break so the failure surfaces
 * as a failed job rather than a log line nobody reads.
 */
import { NonRetriableError } from 'inngest';
import { verifyChain } from '@/core/ledger/verify';
import { inngest } from '@/lib/inngest';

export const ledgerVerify = inngest.createFunction(
  { id: 'ledger-verify', name: 'ledger.verify' },
  { cron: '0 * * * *' },
  async ({ step }) => {
    const result = await step.run('verify', () => verifyChain());

    if (!result.intact) {
      // Non-retriable: a broken chain will not fix itself on a second attempt,
      // and retrying would bury the alert under three identical failures.
      throw new NonRetriableError(
        `LEDGER_CHAIN_BROKEN at seq ${result.brokenAtSeq}: ${result.break?.explanation}`,
      );
    }

    return {
      intact: true,
      records: result.records,
      headHash: result.headHash,
      verifiedInMs: result.verifiedInMs,
    };
  },
);
