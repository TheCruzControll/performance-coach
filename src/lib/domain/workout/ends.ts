/**
 * When a workout may end: the from-states of WORKOUT's `finish` and `abandon` edges
 * (owner decision D1). Completion beats an earlier abandon from another device, and nothing
 * leaves `completed`.
 *
 * This is the only lifecycle module the device reducer loads: WORKOUT itself
 * (./lifecycles.ts) carries the documentation strings, which stay out of /workout's bundle.
 */
import type { WorkoutStatus } from './types.ts';

/** From which states a workout may finish or be abandoned (owner decision D1). WORKOUT's edges use these lists. */
export const END_FROM = {
	finish: ['in_progress', 'abandoned'],
	abandon: ['in_progress']
} as const satisfies Record<'finish' | 'abandon', readonly WorkoutStatus[]>;

export type WorkoutEvent = keyof typeof END_FROM;

/** Whether a workout in `status` may take `event`, as WORKOUT's table says. */
export function canEnd(status: WorkoutStatus, event: WorkoutEvent): boolean {
	return (END_FROM[event] as readonly WorkoutStatus[]).includes(status);
}
