/**
 * `experiment.assign` — blueprint 6.6.
 *
 * Deterministic, so it is safe to re-run: the same event id and salt always
 * produce the same arm. The row is still written idempotently, because an
 * assignment that changed after the fact would invalidate the incrementality
 * result and there must be no code path that can do it.
 */
import { NonRetriableError } from 'inngest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { armAssignments } from '@/db/schema';
import { assignArm } from '@/core/experiment/assign';
import { env } from '@/lib/env';
import { inngest } from '@/lib/inngest';

export const experimentAssign = inngest.createFunction(
  { id: 'experiment-assign', name: 'experiment.assign', retries: 3 },
  { event: 'event.classified' },
  async ({ event, step }) => {
    const { eventId } = event.data;

    const assignment = await step.run('assign', async () => {
      const salt = env.armSalt;
      if (!salt) throw new NonRetriableError('ARM_ASSIGNMENT_SALT is not set');
      const a = assignArm(eventId, salt);

      await db
        .insert(armAssignments)
        .values({
          eventId,
          arm: a.arm,
          saltVersion: a.saltVersion,
          // The hash input is stored so an auditor can recompute the bucket
          // without needing the salt handed to them separately.
          hashInput: a.hashInput,
          bucket: a.bucket,
        })
        // Never overwrite: an existing assignment is the truth.
        .onConflictDoNothing({ target: armAssignments.eventId });

      const [stored] = await db
        .select()
        .from(armAssignments)
        .where(eq(armAssignments.eventId, eventId))
        .limit(1);
      return { arm: stored.arm, bucket: stored.bucket };
    });

    await step.sendEvent('announce', {
      name: 'event.assigned',
      data: { eventId, arm: assignment.arm, bucket: assignment.bucket },
    });

    return assignment;
  },
);
