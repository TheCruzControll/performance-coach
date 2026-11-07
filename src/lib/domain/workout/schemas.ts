/**
 * Validation for wire format v1 (./mutations.ts, ./protocol.ts), on zod/mini. The sync endpoint
 * always validates with it; a browser loads it only on demand, for the Fix flow. Import it by
 * path, never through ./index.ts, so no page carries zod in its initial JavaScript.
 *
 * - Logged values are M3's: each field comes from the training log's schemas
 *   (../training/schemas.ts), so each bound has one definition. M4 adds only its own fields:
 *   client ids, positions, the envelope, substitution choices and pain fields.
 * - Each schema's output is exactly its contract type (schemas.test.ts checks it in pnpm check).
 * - Errors carry dotted paths through ../validation.ts, such as `payload.weight`, or
 *   `mutations.3.payload.durationSeconds` in a sync request.
 * - What needs a stored row is the server's to check after loading it, at the same paths: the
 *   exercise's load type with ./logging.ts checkSet, a planned session's metrics with
 *   ./other.ts checkMetrics.
 */
import * as z from 'zod/mini';
import { BODY_AREAS, SEVERITIES } from '../profile/catalog.ts';
import {
	customExerciseSchema,
	editOtherSessionSchema,
	editRunSchema,
	editRunSegmentSchema,
	editSetSchema,
	finishWorkoutSchema,
	LOG_LIMITS,
	logSetSchema,
	RECORD_LIMITS,
	setValueRules,
	startWorkoutSchema,
	substitutionSchema
} from '../training/schemas.ts';
import type { CustomMetric } from '../training/types.ts';
import { MUTATION_RULES, PAIN_ACTIONS } from './mutations.ts';
import type { MutationRule, MutationType } from './mutations.ts';
import { SYNC_LIMITS } from './protocol.ts';

/**
 * Whether a pain report must say where it hurts and how badly. False is the plan's default
 * (m4-plan open question 'Pain flow'): 'This hurts' takes one tap, and both may be left out.
 */
export const PAIN_DETAILS_REQUIRED = false;

type Fail = (path: PropertyKey[], message: string) => void;

/** A cross-field rule, reporting at paths below the checked value, as M3's schemas do. */
const rules = <T>(check: (value: T, fail: Fail) => void) =>
	z.superRefine<T>((value, ctx) => {
		check(value, (path, message) => ctx.addIssue({ code: 'custom', message, path, input: value }));
	});

// ---- M3's fields ----------------------------------------------------------------------------

const start = startWorkoutSchema.shape;
const finish = finishWorkoutSchema.shape;
const logged = logSetSchema.shape;
const set = editSetSchema.shape;
const swap = substitutionSchema.shape;
const run = editRunSchema.shape;
const segment = editRunSegmentSchema.shape;

/** A client or server id: a UUID. */
const id = logged.exerciseId;
const optionalId = start.plannedSessionId;
/** A short free text: a note, as M3 bounds a run's. */
const note = run.notes;

/** A performed set's values: M3's, less isSkipped (a skip is its own type). */
const performed = {
	weight: set.weight,
	assistance: set.assistance,
	unit: set.unit,
	reps: set.reps,
	missedReps: set.missedReps,
	seconds: set.seconds,
	metres: set.metres,
	rpe: set.rpe,
	isWarmup: set.isWarmup,
	isExtra: set.isExtra
};

/** A distance in metres, as the run tables store it, bounded as M3 bounds a converted one. */
const metres = z.nullable(
	z
		.number('Enter the distance')
		.check(
			z.positive('Above 0'),
			z.maximum(RECORD_LIMITS.metres, `Up to ${RECORD_LIMITS.metres / 1000} km`)
		)
);

// ---- M4's fields ----------------------------------------------------------------------------

const slot = { position: logged.exercisePosition, plannedLineage: logged.plannedExerciseLineageId };
const place = { ...slot, setIndex: logged.setIndex, exerciseId: logged.exerciseId };
const swapped = { ...slot, fromExerciseId: swap.fromExerciseId, toExerciseId: swap.toExerciseId };

// As workout_substitutions_exercises_ck.
const differentExercise = rules<{ fromExerciseId: string; toExerciseId: string }>((s, fail) => {
	if (s.fromExerciseId === s.toExerciseId) fail(['toExerciseId'], 'Pick a different exercise');
});

/** Nothing: a delete or an abandon carries no values, and any it is given is refused. */
const empty = z.record(z.string(), z.never('Nothing goes here'));

const workoutFields = {
	notes: finish.notes,
	sessionRpe: finish.sessionRpe,
	durationSeconds: finish.durationSeconds
};

const painDetail = <T extends readonly [string, ...string[]]>(values: T, message: string) =>
	PAIN_DETAILS_REQUIRED ? z.enum(values, message) : z.nullable(z.enum(values, message));

/** Each type's payload, in wire order. */
export const PAYLOAD_SCHEMAS = {
	'workout.start': z
		.object({
			kind: start.kind,
			title: start.title,
			sessionType: start.sessionType,
			discipline: start.discipline,
			plannedSessionId: start.plannedSessionId,
			plannedLineage: optionalId,
			programId: optionalId
		})
		.check(
			rules((w, fail) => {
				if (w.plannedSessionId !== null) return;
				if (w.plannedLineage !== null) fail(['plannedLineage'], 'An ad-hoc workout has no plan');
				if (w.programId !== null) fail(['programId'], 'An ad-hoc workout has no plan');
			})
		),
	'workout.update': z.object(workoutFields),
	'workout.finish': z.object(workoutFields),
	'workout.abandon': empty,
	'set.log': z.object({ ...place, ...performed }).check(setValueRules()),
	'set.skip': z.object({ ...place, unit: set.unit }),
	'set.edit': z.object(performed).check(setValueRules()),
	'set.delete': empty,
	'exercise.skip': z
		.object({
			...slot,
			exerciseId: logged.exerciseId,
			unit: set.unit,
			sets: z
				.array(z.object({ id, setIndex: logged.setIndex }))
				.check(z.maxLength(LOG_LIMITS.position[1], `Up to ${LOG_LIMITS.position[1]} sets`))
		})
		.check(
			rules((s, fail) =>
				s.sets.forEach((one, k) => {
					if (s.sets.findIndex((o) => o.id === one.id) < k)
						fail(['sets', k, 'id'], 'Each set once');
					else if (s.sets.findIndex((o) => o.setIndex === one.setIndex) < k) {
						fail(['sets', k, 'setIndex'], 'Each set once');
					}
				})
			)
		),
	'exercise.substitute': z.object({ ...swapped, reason: swap.reason }).check(differentExercise),
	'exercise.dislike': z.object({ ...swapped, note }).check(differentExercise),
	'exercise.create': customExerciseSchema,
	'pain.report': z
		.object({
			...slot,
			exerciseId: logged.exerciseId,
			area: painDetail(BODY_AREAS, 'Pick where it hurts'),
			severity: painDetail(SEVERITIES, 'Pick how much it hurts'),
			action: z.enum(PAIN_ACTIONS, 'Pick what you did'),
			substitutionId: optionalId,
			note
		})
		.check(
			rules((p, fail) => {
				// A gentler option is the substitution the report names; nothing else names one.
				if ((p.action === 'substituted') !== (p.substitutionId !== null)) {
					fail(['substitutionId'], 'A substitution goes with a gentler option');
				}
			})
		),
	'run.log': z.object({
		distanceMetres: z.optional(metres),
		durationSeconds: z.optional(run.durationSeconds),
		avgHr: z.optional(run.avgHr),
		rpe: z.optional(run.rpe),
		notes: z.optional(run.notes)
	}),
	'run.segment': z
		.object({
			position: segment.position,
			kind: segment.kind,
			distanceMetres: metres,
			durationSeconds: segment.durationSeconds,
			avgHr: segment.avgHr,
			rpe: segment.rpe
		})
		.check(
			// As run_record_segments_measure_ck.
			rules((s, fail) => {
				if (s.distanceMetres === null && s.durationSeconds === null) {
					fail(['distanceMetres'], 'Give a distance or a duration');
				}
			})
		),
	'other.log': editOtherSessionSchema
};

/** The identity rule (MUTATION_RULES), on the envelope's ids. */
function checkIdentity(
	m: { id: string; type: MutationType; workoutId: string; entityId: string },
	fail: Fail
) {
	const { identity, entity } = MUTATION_RULES[m.type] as MutationRule;
	const byWorkout = entity === 'workout' || identity === 'record';
	if (byWorkout && m.entityId !== m.workoutId) fail(['entityId'], 'Not this change’s workout');
	else if (identity === 'create' && m.id !== m.entityId) fail(['id'], 'A new row has the id');
	else if (identity !== 'create' && identity !== 'segment' && m.id === m.entityId) {
		fail(['id'], 'A change has an id of its own');
	}
}

const envelopeOf = <T extends MutationType>(type: T) =>
	z
		.object({
			v: z.literal(1, 'Wire format v1'),
			id,
			type: z.literal(type),
			workoutId: id,
			entityId: id,
			at: z.iso.datetime({ offset: true, message: 'Use a date and time' }),
			payload: PAYLOAD_SCHEMAS[type]
		})
		.check(rules(checkIdentity));

type EnvelopeSchemas = { [T in MutationType]: ReturnType<typeof envelopeOf<T>> };
const ENVELOPES = Object.fromEntries(
	Object.keys(PAYLOAD_SCHEMAS).map((type) => [type, envelopeOf(type as MutationType)])
) as EnvelopeSchemas;

/** Any mutation, its payload checked by its type: an unknown type is refused at `type`. */
export const envelopeSchema = z.discriminatedUnion(
	'type',
	Object.values(ENVELOPES) as [
		EnvelopeSchemas['workout.start'],
		...EnvelopeSchemas[MutationType][]
	],
	'Not a change this server knows'
);

/** A batch from the outbox: 1 to SYNC_LIMITS.maxMutations mutations. Its byte cap is the endpoint's. */
export const syncRequestSchema = z.object({
	v: z.literal(1, 'Wire format v1'),
	mutations: z
		.array(envelopeSchema)
		.check(
			z.minLength(1, 'Nothing to sync'),
			z.maxLength(SYNC_LIMITS.maxMutations, `Up to ${SYNC_LIMITS.maxMutations} changes at once`)
		)
});

// ---- Bad values -----------------------------------------------------------------------------

/** A value that must be refused, as a change to a valid mutation of its type. */
export interface BadValue {
	/** What is wrong, as a test names it. */
	name: string;
	type: MutationType;
	/** What replaces the valid mutation's own fields, or its payload's. */
	envelope?: Record<string, unknown>;
	payload?: Record<string, unknown>;
	/** Where it is refused. */
	path: string;
	/** A planned session's metrics: only checkMetrics, given them, can refuse this value. */
	planned?: readonly CustomMetric[];
}

/**
 * Values Postgres's CHECKs refuse too, so a gap between a schema and the database shows: the
 * sync endpoint's tests write each one past the schemas, straight through the repositories.
 */
export const DB_CHECKED_BAD_VALUES: readonly BadValue[] = [
	{ name: 'RPE 11', type: 'set.log', payload: { rpe: 11 }, path: 'payload.rpe' },
	{ name: 'RPE off the half steps', type: 'set.log', payload: { rpe: 7.3 }, path: 'payload.rpe' },
	{ name: 'reps -1', type: 'set.log', payload: { reps: -1 }, path: 'payload.reps' },
	{
		name: 'missed reps 51',
		type: 'set.log',
		payload: { missedReps: 51 },
		path: 'payload.missedReps'
	},
	{
		name: 'seconds 0',
		type: 'set.log',
		payload: { reps: null, seconds: 0 },
		path: 'payload.seconds'
	},
	{
		name: 'distance 0',
		type: 'run.log',
		payload: { distanceMetres: 0 },
		path: 'payload.distanceMetres'
	},
	{
		name: 'a weight with assistance',
		type: 'set.log',
		payload: { weight: 20, assistance: 10 },
		path: 'payload.assistance'
	},
	{
		name: "severity 'extreme'",
		type: 'pain.report',
		payload: { severity: 'extreme' },
		path: 'payload.severity'
	},
	{
		name: "pain action 'ignored'",
		type: 'pain.report',
		payload: { action: 'ignored' },
		path: 'payload.action'
	},
	{
		name: 'metrics that are not an array',
		type: 'other.log',
		payload: { metrics: { rounds: 6 } },
		path: 'payload.metrics'
	}
];

/**
 * Values only the schemas (and the rules after them) refuse: Postgres keeps these vocabularies
 * open, as M3's policy does for the substitution reason, the mutation type and metric keys, and
 * M2's for a body area.
 */
export const SCHEMA_ONLY_BAD_VALUES: readonly BadValue[] = [
	{
		name: 'an unknown substitution reason',
		type: 'exercise.substitute',
		payload: { reason: 'bored' },
		path: 'payload.reason'
	},
	{
		name: 'an unknown mutation type',
		type: 'set.log',
		envelope: { type: 'set.teleport' },
		path: 'type'
	},
	{ name: 'v 2', type: 'set.log', envelope: { v: 2 }, path: 'v' },
	{
		name: 'an unknown body area',
		type: 'pain.report',
		payload: { area: 'tail' },
		path: 'payload.area'
	},
	{
		name: 'an unknown metric key on a planned session',
		type: 'other.log',
		payload: { metrics: [{ key: 'kicks', label: 'Kicks', unit: null, value: 40 }] },
		path: 'payload.metrics.0.key',
		planned: [{ key: 'rounds', label: 'Rounds', unit: null, value: 6 }]
	}
];
