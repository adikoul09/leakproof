/**
 * `replay.run` — execute a what-if against a historical corpus.
 *
 * Runs in Inngest rather than the request because a 20,000-event corpus plus
 * its cohort counters is a lot of rows to pull inside an HTTP timeout, and
 * because a run that dies halfway should be visibly failed rather than a
 * request that hung.
 *
 * The engine itself is pure and fast — thousands of events per second — so the
 * time goes on loading the corpus, not on replaying it.
 */
import { NonRetriableError } from 'inngest';
import { loadCorpus, type CorpusName } from '@/core/replay/corpus';
import { replay, type ReplayFlags } from '@/core/replay/engine';
import { failRun, finishRun, getRun } from '@/core/replay/store';
import { getLivePolicy, getPolicy } from '@/core/policy/store';
import { loadHolidays } from '@/core/policy/holidays';
import { addDays, zonedParts } from '@/core/policy/tz';
import { optional } from '@/lib/env';
import { inngest } from '@/lib/inngest';

export const replayRun = inngest.createFunction(
  { id: 'replay-run', name: 'replay.run', retries: 1 },
  { event: 'replay.run' },
  async ({ event, step }) => {
    const { runId } = event.data;

    const spec = await step.run('load-run', async () => {
      const row = await getRun(runId);
      if (!row) throw new NonRetriableError(`replay run ${runId} not found`);
      return {
        corpus: row.corpus as CorpusName,
        policyVersion: row.policyVersion,
        flags: row.flags as ReplayFlags & { limit?: number; batch_id?: string; thresholds?: unknown },
        seed: row.seed,
      };
    });

    try {
      const result = await step.run('replay', async () => {
        const stored =
          spec.policyVersion === 'live'
            ? await getLivePolicy()
            : await getPolicy(spec.policyVersion);
        if (!stored) throw new NonRetriableError(`policy ${spec.policyVersion} not found`);

        const corpus = await loadCorpus({
          corpus: spec.corpus,
          limit: spec.flags.limit,
          batchId: spec.flags.batch_id,
        });
        if (corpus.events.length === 0) {
          throw new NonRetriableError('corpus is empty — generate a batch first');
        }

        // Warm the holidays the gate needs across the corpus's span, exactly as
        // the live gate receives them. A gate that has to make a network call
        // is not a gate.
        const tz = stored.policy.contact_window.tz;
        const fromKey = zonedParts(corpus.from!, tz).dateKey;
        const toKey = addDays(zonedParts(corpus.to!, tz).dateKey, 21);
        const bankHolidays = await loadHolidays(fromKey, toKey);

        const salt = optional.armSalt();
        if (!salt) throw new NonRetriableError('ARM_ASSIGNMENT_SALT is not configured');

        const r = replay(corpus.events, corpus.seeds, {
          policy: stored.policy,
          policyVersion: stored.version,
          thresholds: (spec.flags.thresholds as never) ?? undefined,
          flags: {
            disable_llm: spec.flags.disable_llm ?? false,
            naive_rails: spec.flags.naive_rails ?? false,
            alt_salt: spec.flags.alt_salt,
          },
          seed: spec.seed,
          armSalt: salt,
          bankHolidays,
        });

        return { result: r, events: corpus.events.length, description: corpus.description };
      });

      await step.run('finish', () => finishRun(runId, result.result, result.events));
      return {
        runId,
        events: result.events,
        changed: result.result.changed_count,
        eventsPerSecond: result.result.events_per_second,
      };
    } catch (err) {
      await step.run('mark-failed', () => failRun(runId, (err as Error).message));
      throw err;
    }
  },
);
