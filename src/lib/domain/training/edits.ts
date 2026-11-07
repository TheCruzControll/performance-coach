/**
 * Validation for the owner's program edits (PRD §5), on zod/mini: what an edit sheet posts, which
 * services/programs/edits.ts parses again and stays the authority over. Import this file by path
 * (servers always, browsers on demand), never through ./index.ts, so no page carries zod in its
 * initial JavaScript.
 *
 * An edit names its session by lineage, which every version keeps. The version it was made on
 * and the owner's today travel beside it, not in it: the service checks them.
 *
 * An adjustment sends only the values it changes, each as absolute as its prescription field
 * (an omitted field keeps its value, null clears it), and names its row by its parent and its
 * position from 1. Each field has its prescription schema's rule; the service checks the row it
 * gives as a whole (reps low to high, what a load kind needs) with that same schema.
 */
import * as z from 'zod/mini';
import { TIMES_OF_DAY } from '../profile/catalog.ts';
import { otherDetailsSchema, runSegmentSchema, setPrescriptionSchema } from './schemas.ts';

/** The longest reason an edit keeps: it is written into its decision's 'why'. */
export const REASON_MAX = 200;

const sessionLineage = z.uuid('Unknown session');

/** Optional; blank counts as no reason. */
const reason = z.optional(
	z
		.string('Write a reason, or leave it blank')
		.check(z.trim(), z.maxLength(REASON_MAX, `Up to ${REASON_MAX} characters`))
);

/** Move a session to another day of its week, at a time of day or at its own. */
export const moveSessionSchema = z.object({
	sessionLineage,
	toDate: z.iso.date('Pick a day'),
	/** Left out, the session keeps its time of day; null leaves the time open. */
	timeOfDay: z.optional(z.nullable(z.enum(TIMES_OF_DAY, 'Pick a time'))),
	reason
});
export type MoveSessionInput = z.output<typeof moveSessionSchema>;

export const skipSessionSchema = z.object({ sessionLineage, reason });
export type SkipSessionInput = z.output<typeof skipSessionSchema>;

const plannedExerciseLineage = z.uuid('Unknown exercise');

/** A row's place among its parent's, from 1. */
const position = (max: number, message: string) =>
	z.int(message).check(z.minimum(1, message), z.maximum(max, message));

/**
 * 'once' swaps the exercise in this session only; 'never_again' also saves a dislike and swaps
 * it in every session from today.
 */
export const SWAP_SCOPES = ['once', 'never_again'] as const;
export type SwapScope = (typeof SWAP_SCOPES)[number];

/** Swap a planned exercise for one of its alternatives (services/programs/alternatives.ts). */
export const swapSchema = z.object({
	sessionLineage,
	plannedExerciseLineage,
	toExerciseId: z.uuid('Pick an alternative'),
	scope: z.enum(SWAP_SCOPES, 'This session only, or never again?'),
	reason
});
export type SwapInput = z.output<typeof swapSchema>;

const set = setPrescriptionSchema.shape;

/** A strength set prescription's sets, reps, RPE, load value and rest. */
export const adjustSetSchema = z.object({
	sessionLineage,
	plannedExerciseLineage,
	position: position(10, 'Unknown set'),
	sets: z.optional(set.sets),
	repsMin: z.optional(set.repsMin),
	repsMax: z.optional(set.repsMax),
	targetRpe: z.optional(set.targetRpe),
	loadValue: z.optional(set.loadValue),
	restSeconds: z.optional(set.restSeconds),
	reason
});
export type AdjustSetInput = z.output<typeof adjustSetSchema>;

const segment = runSegmentSchema.shape;

/** A run segment's distance, duration, pace range, RPE, heart-rate zone and its group's repeats. */
export const adjustRunSegmentSchema = z.object({
	sessionLineage,
	position: position(40, 'Unknown segment'),
	distanceMetres: z.optional(segment.distanceMetres),
	durationSeconds: z.optional(segment.durationSeconds),
	paceMinSecondsPerKm: z.optional(segment.paceMinSecondsPerKm),
	paceMaxSecondsPerKm: z.optional(segment.paceMaxSecondsPerKm),
	targetRpe: z.optional(segment.targetRpe),
	hrZone: z.optional(segment.hrZone),
	repeats: z.optional(segment.repeats),
	reason
});
export type AdjustRunSegmentInput = z.output<typeof adjustRunSegmentSchema>;

const details = otherDetailsSchema.shape;

/** Another session's (Muay Thai, mobility, a class) length and RPE. */
export const adjustDetailsSchema = z.object({
	sessionLineage,
	durationMinutes: z.optional(details.durationMinutes),
	targetRpe: z.optional(details.targetRpe),
	reason
});
export type AdjustDetailsInput = z.output<typeof adjustDetailsSchema>;
