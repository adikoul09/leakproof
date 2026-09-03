/**
 * Deterministic arm assignment — blueprint 6.5.
 *
 *   arm = bucket(sha256(event_id + SALT)) % 100
 *     0–17  → control    (18%)
 *    18–37  → naive      (20%)
 *    38–99  → leakproof  (62%)
 *
 * No stored randomness. Given the event id and the salt, the arm is
 * reproducible forever — which is what lets the replay engine reconstruct the
 * exact experiment from a historical corpus, and what lets an auditor verify
 * that an event was not moved between arms after the fact.
 *
 * ARM_ASSIGNMENT_SALT must never change once events exist. Changing it
 * silently reshuffles every historical assignment and invalidates the entire
 * incrementality result.
 */
import { sha256 } from '@/lib/hash';

export type Arm = 'control' | 'naive' | 'leakproof';

/** Upper bound (exclusive) of each arm's bucket range. Must sum to 100. */
export const ARM_SPLIT: ReadonlyArray<{ arm: Arm; upto: number }> = [
  { arm: 'control', upto: 18 },
  { arm: 'naive', upto: 38 },
  { arm: 'leakproof', upto: 100 },
];

export interface Assignment {
  arm: Arm;
  bucket: number;
  hashInput: string;
  saltVersion: string;
}

/**
 * Pure. The salt is passed in rather than read from the environment so that
 * replay can reproduce a historical assignment under the salt that was live
 * at the time.
 */
export function assignArm(eventId: string, salt: string, saltVersion = 'v1'): Assignment {
  const hashInput = `${eventId}${salt}`;
  const digest = sha256(hashInput);
  // First 8 hex chars is ample entropy for a 0–99 bucket and keeps the
  // arithmetic inside a safe integer.
  const bucket = parseInt(digest.slice(0, 8), 16) % 100;

  for (const { arm, upto } of ARM_SPLIT) {
    if (bucket < upto) return { arm, bucket, hashInput, saltVersion };
  }
  // Unreachable while ARM_SPLIT ends at 100, but never silently mis-assign.
  throw new Error(`bucket ${bucket} fell outside every arm range`);
}
