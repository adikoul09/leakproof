/**
 * `metrics.rollup` — blueprint 6.6, cron every 5 minutes.
 *
 * Writes `metric_snapshots` so the dashboard reads pre-aggregated rows rather
 * than recomputing a bootstrap on every page load. The snapshot is a cache of
 * counts, never of the confidence interval: an interval is recomputed from the
 * events it describes, so it can never go stale against them.
 */
import { and, eq, gte, lt, sql as raw } from 'drizzle-orm';
import { db } from '@/db/client';
import { armAssignments, metricSnapshots, paymentEvents, recoveryAttempts } from '@/db/schema';
import { inngest } from '@/lib/inngest';

const WINDOW_MINUTES = 5;

export const metricsRollup = inngest.createFunction(
  { id: 'metrics-rollup', name: 'metrics.rollup' },
  { cron: '*/5 * * * *' },
  async ({ step }) => {
    const written = await step.run('rollup', async () => {
      const now = new Date();
      const windowStart = new Date(
        Math.floor(now.getTime() / (WINDOW_MINUTES * 60_000)) * WINDOW_MINUTES * 60_000 -
          WINDOW_MINUTES * 60_000,
      );
      const windowEnd = new Date(windowStart.getTime() + WINDOW_MINUTES * 60_000);

      const rows = await db
        .select({
          arm: armAssignments.arm,
          nEvents: raw<number>`count(*)::int`,
          // The timestamp, not the label — see loadArms and FAILURES.md #19.
          nRecovered: raw<number>`count(*) filter (where ${paymentEvents.recoveredAt} is not null)::int`,
          grossPaise: raw<number>`coalesce(sum(${paymentEvents.recoveredPaise}) filter (where ${paymentEvents.recoveredAt} is not null), 0)::bigint`,
        })
        .from(paymentEvents)
        .innerJoin(armAssignments, eq(armAssignments.eventId, paymentEvents.id))
        .where(and(gte(paymentEvents.failedAt, windowStart), lt(paymentEvents.failedAt, windowEnd)))
        .groupBy(armAssignments.arm);

      if (rows.length === 0) return { windowStart: windowStart.toISOString(), arms: 0 };

      const costs = await db
        .select({
          arm: armAssignments.arm,
          costPaise: raw<number>`coalesce(sum(${recoveryAttempts.costPaise}), 0)::int`,
        })
        .from(recoveryAttempts)
        .innerJoin(paymentEvents, eq(paymentEvents.id, recoveryAttempts.eventId))
        .innerJoin(armAssignments, eq(armAssignments.eventId, recoveryAttempts.eventId))
        .where(and(gte(paymentEvents.failedAt, windowStart), lt(paymentEvents.failedAt, windowEnd)))
        .groupBy(armAssignments.arm);

      const costByArm = new Map(costs.map((c) => [c.arm, c.costPaise]));

      for (const r of rows) {
        await db
          .insert(metricSnapshots)
          .values({
            windowStart,
            arm: r.arm,
            nEvents: r.nEvents,
            nRecovered: r.nRecovered,
            grossPaise: Number(r.grossPaise),
            costPaise: costByArm.get(r.arm) ?? 0,
            falseNudges: 0,
          })
          // Re-running a window must correct it, never duplicate it.
          .onConflictDoUpdate({
            target: [metricSnapshots.windowStart, metricSnapshots.arm],
            set: {
              nEvents: r.nEvents,
              nRecovered: r.nRecovered,
              grossPaise: Number(r.grossPaise),
              costPaise: costByArm.get(r.arm) ?? 0,
            },
          });
      }

      return { windowStart: windowStart.toISOString(), arms: rows.length };
    });

    return written;
  },
);
