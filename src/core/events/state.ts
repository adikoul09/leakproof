/**
 * The at-risk event's state machine — the two halves of it, together.
 *
 * Pure: no database, no imports beyond the enum, so anything can read it.
 * `transition.ts` holds the write.
 *
 * These two lists must partition `event_state_t` exactly. They are consumed by
 * different code for different reasons — `OPEN_STATES` is what an organic
 * recovery is allowed to match against, `TERMINAL_STATES` is what no job may
 * move an event out of — and keeping them apart is how a state gets added to
 * one and forgotten in the other. `state.test.ts` asserts the partition.
 */
import { eventStateT } from '@/db/schema';

/**
 * States that close an event. Nothing may move an event out of one of these —
 * a recovered payment does not become at_risk again because a job that started
 * earlier finished later.
 */
export const TERMINAL_STATES = ['recovered', 'lost', 'stopped'] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

/**
 * States that still count as recoverable, and therefore the states an organic
 * recovery is allowed to match against. A state missing from here is a state
 * whose recoveries silently find nothing — and the control arm recovers by no
 * other route.
 */
export const OPEN_STATES = [
  'at_risk',
  'classifying',
  'planned',
  'waiting_out_outage',
  'deferred',
  'blocked_by_policy',
  'action_sent',
] as const;
export type OpenState = (typeof OPEN_STATES)[number];

export type EventState = OpenState | TerminalState;

/** Every value of `event_state_t`, for the partition assertion. */
export const ALL_EVENT_STATES = eventStateT.enumValues;
