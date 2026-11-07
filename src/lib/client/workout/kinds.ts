/**
 * Each workout kind's page (the M4 plan's decision 5): one prerendered route per kind, so every
 * kind's whole path is budgeted on every build and no route ships another kind's reducers. The
 * resume bar, the start flow, History and a page holding another kind's workout all link through
 * here. Owner decision: one route per kind, rather than lazy views on one route (about 1.0 KB
 * more on the strength path); changing it means changing this map and the routes together.
 */
import type { SessionKind } from '#lib/domain/training/types.ts';

export const WORKOUT_PATHS = {
	strength: '/workout',
	run: '/workout/run',
	other: '/workout/session'
} as const satisfies Record<SessionKind, string>;

export type WorkoutPath = (typeof WORKOUT_PATHS)[SessionKind];

/** The page a workout of this kind is shown on. */
export const workoutPath = (kind: SessionKind): WorkoutPath => WORKOUT_PATHS[kind];
