/**
 * Circuit-breaker persistence. The decision itself is pure and lives in
 * `breaker.ts`; this is only the part that remembers.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { breakerState } from '@/db/schema';
import { GLOBAL_SCOPE, type BreakerEvaluation, type BreakerStatus } from './breaker';

const CLOSED: Omit<BreakerStatus, 'scope'> = {
  open: false,
  reason: null,
  openedAt: null,
  actor: 'system',
};

export async function readBreaker(scope: string): Promise<BreakerStatus> {
  const [row] = await db.select().from(breakerState).where(eq(breakerState.scope, scope)).limit(1);
  if (!row) return { scope, ...CLOSED };
  return {
    scope,
    open: row.state === 'open',
    // A human's stated reason beats a machine-generated one — that is what an
    // auditor is actually looking for when they open this record.
    reason:
      row.overrideReason ??
      (row.triggerSource ? `${row.triggerSource} (observed ${row.observedValue ?? '?'})` : null),
    openedAt: row.openedAt,
    actor: row.actor,
  };
}

/**
 * An event is gated by its own cohort's breaker *and* the global one — either
 * being open blocks. Read together so the gate makes one round trip.
 */
export async function readEffectiveBreaker(cohortScope: string): Promise<BreakerStatus> {
  const [global, cohort] = await Promise.all([readBreaker(GLOBAL_SCOPE), readBreaker(cohortScope)]);
  if (global.open) return global;
  return cohort;
}

export async function openBreaker(
  scope: string,
  evaluation: BreakerEvaluation,
  actor = 'system',
  reason: string | null = null,
): Promise<void> {
  const now = new Date();
  await db
    .insert(breakerState)
    .values({
      scope,
      state: 'open',
      triggerSource: evaluation.trigger,
      observedValue: evaluation.observed.toFixed(5),
      threshold: evaluation.threshold.toFixed(5),
      openedAt: now,
      closedAt: null,
      actor,
      overrideReason: reason,
    })
    .onConflictDoUpdate({
      target: breakerState.scope,
      set: {
        state: 'open',
        triggerSource: evaluation.trigger,
        observedValue: evaluation.observed.toFixed(5),
        threshold: evaluation.threshold.toFixed(5),
        openedAt: now,
        closedAt: null,
        actor,
        overrideReason: reason,
        updatedAt: now,
      },
    });
}

export async function closeBreaker(
  scope: string,
  actor = 'system',
  reason: string | null = null,
): Promise<void> {
  const now = new Date();
  await db
    .insert(breakerState)
    .values({ scope, state: 'closed', closedAt: now, actor, overrideReason: reason })
    .onConflictDoUpdate({
      target: breakerState.scope,
      set: { state: 'closed', closedAt: now, actor, overrideReason: reason, updatedAt: now },
    });
}
