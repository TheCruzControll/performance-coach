/**
 * What planned sessions prescribe, on real Postgres (ADR 0010): a planned week's strength
 * exercises with their set prescriptions, an interval run's segments and a Muay Thai class's
 * details round-trip in order; one shared table of values is refused, or accepted, alike by the
 * CHECKs and by the program-plan contract's zod schemas; every row is history (UPDATE and DELETE
 * refused, TRUNCATE the test-only bypass); and an exercise a plan names cannot be deleted.
 */
import { asc, eq, getTableName, is, sql, type SQL } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type * as z from 'zod/mini';
import {
	otherDetailsSchema,
	plannedExerciseSchema,
	runSegmentSchema,
	runSegmentsSchema,
	setPrescriptionSchema
} from '../../../src/lib/domain/training/schemas';
import type {
	CustomMetric,
	ExerciseRef,
	OtherDetails,
	PlannedExercisePlan,
	RunSegment,
	SetPrescription
} from '../../../src/lib/domain/training/types';
import { validate } from '../../../src/lib/domain/validation';
import {
	exercises,
	plannedExercises,
	plannedRunSegments,
	plannedSessionDetails,
	plannedSessions,
	programBlocks,
	programs,
	programVersionBlocks,
	programVersions,
	programVersionWeeks,
	programWeeks,
	setPrescriptions,
	type Executor
} from '../../../src/lib/server/db';
import * as prescriptionSchema from '../../../src/lib/server/db/schema/prescriptions';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

/** Every table prescriptions.ts defines, so a new one cannot miss its guard. */
const PRESCRIPTION_TABLES = Object.values(prescriptionSchema)
	.filter((value) => is(value, PgTable))
	.map((table) => getTableName(table))
	.sort();

const MONDAY = '2026-11-09';
const SUNDAY = '2026-11-15';

// ---- the contract's values ------------------------------------------------------------------

const set = (over: Partial<SetPrescription> = {}): SetPrescription => ({
	role: 'working',
	sets: 3,
	repsMin: 5,
	repsMax: 5,
	seconds: null,
	metres: null,
	targetRpe: 7,
	loadKind: 'rpe_based',
	loadValue: null,
	loadUnit: null,
	loadBasis: null,
	reference1rm: null,
	reference1rmUnit: null,
	restSeconds: 120,
	tempo: null,
	notes: null,
	...over
});

/** A valid set of each load kind. */
const BY_RPE = set();
const ABSOLUTE = set({ loadKind: 'absolute', loadValue: 100, loadUnit: 'kg', targetRpe: null });
const PERCENT = set({
	loadKind: 'percent_1rm',
	loadValue: 0.75,
	loadBasis: 'measured',
	reference1rm: 180,
	reference1rmUnit: 'kg',
	targetRpe: null
});
const FROM_E1RM = set({
	role: 'back_off',
	loadKind: 'from_e1rm',
	loadValue: 0.72,
	targetRpe: null
});

const exercise = (
	ref: ExerciseRef,
	sets: SetPrescription[],
	over: Partial<PlannedExercisePlan> = {}
): PlannedExercisePlan => ({
	exercise: ref,
	baselineLift: null,
	superset: null,
	substitutedFrom: null,
	substitutionReason: null,
	instructions: null,
	notes: null,
	sets,
	...over
});

const SQUAT = exercise({ key: 'back_squat' }, [BY_RPE], { baselineLift: 'back_squat' });

const segment = (kind: RunSegment['kind'], over: Partial<RunSegment> = {}): RunSegment => ({
	kind,
	repeatGroup: null,
	repeats: null,
	distanceMetres: null,
	durationSeconds: null,
	paceMinSecondsPerKm: null,
	paceMaxSecondsPerKm: null,
	hrZone: null,
	targetRpe: null,
	...over
});

const INTERVAL = segment('interval', {
	repeatGroup: 1,
	repeats: 6,
	distanceMetres: 400,
	paceMinSecondsPerKm: 225,
	paceMaxSecondsPerKm: 240,
	hrZone: 4,
	targetRpe: 8
});

/** Warm-up, 6 × (400 m + 90 s), cool-down. */
const INTERVALS: RunSegment[] = [
	segment('warm_up', { durationSeconds: 600, targetRpe: 3 }),
	INTERVAL,
	segment('recovery', { repeatGroup: 1, repeats: 6, durationSeconds: 90, targetRpe: 2 }),
	segment('cool_down', { durationSeconds: 600, hrZone: 2 })
];

const metric = (key: string, value: CustomMetric['value'], unit: string | null = null) => ({
	key,
	label: key.replace('_', ' '),
	unit,
	value
});

const CLASS: OtherDetails = {
	kind: 'class',
	durationMinutes: 90,
	targetRpe: 7,
	metrics: [
		metric('rounds', 6),
		metric('round_length', 3, 'min'),
		metric('sparring', false),
		metric('focus', 'Teeps and checks')
	],
	notes: 'Bring shin guards.'
};

/** Thursday's strength: every measure and load kind, a superset, a swap and the owner's own. */
const strengthPlan = (custom: string): PlannedExercisePlan[] => [
	exercise(
		{ key: 'back_squat' },
		[
			set({ role: 'warm_up', sets: 2, targetRpe: 5, restSeconds: 60 }),
			set({ role: 'top', sets: 1, restSeconds: 180, notes: 'Record weight, reps and RPE.' }),
			// A computed fraction (10 % off a chart value) is stored exactly as validated.
			{ ...FROM_E1RM, sets: 2, loadValue: 0.863 * 0.9, restSeconds: 150 }
		],
		{ baselineLift: 'back_squat', instructions: 'Work up to a set of 5 at RPE 7.' }
	),
	exercise({ key: 'deadlift' }, [{ ...PERCENT, repsMin: 3, repsMax: 3, reference1rm: 182.5 }], {
		baselineLift: 'deadlift'
	}),
	exercise(
		{ key: 'goblet_squat' },
		[{ ...ABSOLUTE, repsMin: 10, repsMax: 12, loadValue: 24, restSeconds: 90, tempo: '31X0' }],
		{
			superset: 1,
			substitutedFrom: { key: 'front_squat' },
			substitutionReason: 'equipment_unavailable'
		}
	),
	exercise(
		{ key: 'sled_push' },
		[{ ...ABSOLUTE, repsMin: null, repsMax: null, metres: 20, loadValue: 225, loadUnit: 'lb' }],
		{ superset: 1 }
	),
	exercise({ customId: custom }, [set({ sets: 2, repsMin: 15, repsMax: 20, targetRpe: 6.5 })], {
		notes: 'Your own warm-up.'
	}),
	exercise({ key: 'burpee' }, [
		set({ repsMin: null, repsMax: null, seconds: 30, targetRpe: 8.5, restSeconds: 30 })
	])
];

// ---- storing and reading --------------------------------------------------------------------

/** Exercise ids by ref and back: catalogue rows by key, the owner's own by id. */
async function library(db: Executor) {
	const rows = await db.select({ id: exercises.id, key: exercises.key }).from(exercises);
	const byKey = new Map(rows.map((row) => [row.key, row.id]));
	return {
		idOf(ref: ExerciseRef): string {
			if ('customId' in ref) return ref.customId;
			const id = byKey.get(ref.key);
			if (!id) throw new Error(`${ref.key} is not in the catalogue`);
			return id;
		},
		refOf(id: string): ExerciseRef {
			const key = rows.find((row) => row.id === id)?.key;
			return key ? { key } : { customId: id };
		}
	};
}

/**
 * A planned week of version 1 holding a Monday interval run, a Tuesday Muay Thai class and a
 * Thursday strength session, with nothing prescribed yet.
 */
async function storeWeek(db: Executor) {
	const ownerId = await makeOwner(db);
	const [program] = await db.insert(programs).values({ ownerId, title: 'Fight camp' }).returning();
	const programId = program!.id;
	const [version] = await db
		.insert(programVersions)
		.values({
			programId,
			number: 1,
			createdBy: 'rules',
			summary: 'Your first program',
			startsOn: MONDAY,
			firstPlannedDay: MONDAY
		})
		.returning();
	const [block] = await db
		.insert(programBlocks)
		.values({
			programId,
			position: 1,
			phase: 'baseline',
			name: 'Baseline',
			startsOn: MONDAY,
			endsOn: SUNDAY
		})
		.returning();
	const [week] = await db
		.insert(programWeeks)
		.values({
			blockId: block!.id,
			indexInBlock: 1,
			startsOn: MONDAY,
			endsOn: SUNDAY,
			kind: 'baseline'
		})
		.returning();
	await db.insert(programVersionBlocks).values({ versionId: version!.id, blockId: block!.id });
	await db.insert(programVersionWeeks).values({ versionId: version!.id, weekId: week!.id });

	const session = async (values: Omit<typeof plannedSessions.$inferInsert, 'weekId'>) => {
		const [row] = await db
			.insert(plannedSessions)
			.values({ weekId: week!.id, ...values })
			.returning();
		return row!.id;
	};
	const common = { intensity: 'hard', targetRpe: 7, source: 'generator' } as const;
	return {
		ownerId,
		...(await library(db)),
		run: await session({
			...common,
			scheduledOn: MONDAY,
			timeOfDay: 'morning',
			discipline: 'running',
			sessionType: 'interval_run',
			title: 'Intervals',
			estMinutes: 45
		}),
		muayThai: await session({
			...common,
			scheduledOn: '2026-11-10',
			timeOfDay: 'evening',
			discipline: 'muay_thai',
			sessionType: 'muay_thai',
			title: 'Muay Thai class',
			estMinutes: 90,
			source: 'commitment'
		}),
		strength: await session({
			...common,
			scheduledOn: '2026-11-12',
			timeOfDay: 'evening',
			discipline: 'strength',
			sessionType: 'strength',
			title: 'Full body A',
			estMinutes: 60,
			intensity: 'moderate'
		})
	};
}

type Week = Awaited<ReturnType<typeof storeWeek>>;

/** One of the owner's own exercises. */
async function customExercise(db: Executor, ownerId: string, name: string) {
	const [row] = await db
		.insert(exercises)
		.values({
			ownerId,
			name,
			pattern: 'mobility',
			primaryMuscles: ['glutes'],
			skillLevel: 'beginner',
			measure: 'reps',
			loadType: 'none'
		})
		.returning();
	return row!.id;
}

/** A planned exercise's row: its refs resolved to ids; its sets belong to set_prescriptions. */
function exerciseRow(week: Week, sessionId: string, position: number, e: PlannedExercisePlan) {
	const { exercise: ref, substitutedFrom, sets: _sets, ...fields } = e;
	return {
		sessionId,
		position,
		exerciseId: week.idOf(ref),
		substitutedFromExerciseId: substitutedFrom && week.idOf(substitutedFrom),
		...fields
	};
}

/** Store a strength session's exercises and sets last to first, so order must come from position. */
async function storeStrength(db: Executor, week: Week, plan: PlannedExercisePlan[]) {
	const ids: string[] = [];
	for (const [i, e] of [...plan.entries()].reverse()) {
		const [row] = await db
			.insert(plannedExercises)
			.values(exerciseRow(week, week.strength, i + 1, e))
			.returning();
		const sets = e.sets.map((s, k) => ({ plannedExerciseId: row!.id, position: k + 1, ...s }));
		if (sets.length) await db.insert(setPrescriptions).values(sets.reverse());
		ids.unshift(row!.id);
	}
	return ids;
}

async function storeRun(db: Executor, sessionId: string, segments: RunSegment[]) {
	const rows = segments.map((s, k) => ({ sessionId, position: k + 1, ...s }));
	return db.insert(plannedRunSegments).values(rows.reverse()).returning();
}

async function readStrength(db: Executor, week: Week): Promise<PlannedExercisePlan[]> {
	const rows = await db
		.select()
		.from(plannedExercises)
		.where(eq(plannedExercises.sessionId, week.strength))
		.orderBy(asc(plannedExercises.position));
	const plan: PlannedExercisePlan[] = [];
	for (const row of rows) {
		const { id, sessionId: _s, lineageId: _l, position: _p, exerciseId, ...fields } = row;
		const { substitutedFromExerciseId: from, ...rest } = fields;
		const sets = await db
			.select()
			.from(setPrescriptions)
			.where(eq(setPrescriptions.plannedExerciseId, id))
			.orderBy(asc(setPrescriptions.position));
		plan.push({
			exercise: week.refOf(exerciseId),
			substitutedFrom: from === null ? null : week.refOf(from),
			...rest,
			sets: sets.map(
				({ id: _i, plannedExerciseId: _e, position: _q, ...prescription }) => prescription
			)
		});
	}
	return plan;
}

async function readRun(db: Executor, sessionId: string): Promise<RunSegment[]> {
	const rows = await db
		.select()
		.from(plannedRunSegments)
		.where(eq(plannedRunSegments.sessionId, sessionId))
		.orderBy(asc(plannedRunSegments.position));
	return rows.map(({ id: _i, sessionId: _s, position: _p, ...s }) => s);
}

async function readDetails(db: Executor, sessionId: string): Promise<OtherDetails | undefined> {
	const [row] = await db
		.select()
		.from(plannedSessionDetails)
		.where(eq(plannedSessionDetails.sessionId, sessionId));
	if (!row) return undefined;
	const { sessionId: _s, ...details } = row;
	return details;
}

type PgError = { code?: string; table?: string; constraint?: string };
const UNDO = Symbol('undo');

/**
 * Run `write` in a savepoint that is always undone, so the test's transaction carries on and
 * rows it stores never collide: the Postgres error it failed with (drizzle wraps it as the
 * cause), or null when it was accepted.
 */
async function attempt(db: Executor, write: (tx: Executor) => Promise<unknown>) {
	try {
		await db.transaction(async (tx) => {
			await write(tx);
			throw UNDO;
		});
	} catch (err) {
		if (err === UNDO) return null;
		const { code, table, constraint } = ((err as { cause?: PgError }).cause ?? err) as PgError;
		return { code, table, constraint };
	}
	throw new Error('unreachable');
}

const refused = (code: string, table: string, constraint: string) => ({ code, table, constraint });

async function counts(db: Executor) {
	const result: Record<string, number> = {};
	for (const table of [...PRESCRIPTION_TABLES, 'exercises']) {
		const { rows } = await db.execute<{ n: number }>(
			sql`select count(*)::int as n from ${sql.identifier(table)}`
		);
		result[table] = rows[0]!.n;
	}
	return result;
}

// ---- the shared table -----------------------------------------------------------------------

type Part = 'exercise' | 'set' | 'segment' | 'details';

const TABLE: Record<Part, string> = {
	exercise: 'planned_exercises',
	set: 'set_prescriptions',
	segment: 'planned_run_segments',
	details: 'planned_session_details'
};

const SCHEMA: Record<Part, z.ZodMiniType> = {
	exercise: plannedExerciseSchema,
	set: setPrescriptionSchema,
	segment: runSegmentSchema,
	details: otherDetailsSchema
};

/** The zod paths that report a problem with `value` (none when the contract accepts it). */
function zodPaths(part: Part, value: object) {
	const result = validate(SCHEMA[part], value);
	return result.ok ? [] : Object.keys(result.errors);
}

/**
 * Store `value` as its part's row, in a week that holds a back squat (no sets yet) on Thursday
 * and nothing else: sets go under the squat, segments into the run, details on the class.
 */
function write(week: Week & { squat: string }, part: Part, value: object) {
	return (tx: Executor) => {
		if (part === 'exercise') {
			const row = exerciseRow(week, week.strength, 2, value as PlannedExercisePlan);
			return tx.insert(plannedExercises).values(row);
		}
		if (part === 'set') {
			const row = { plannedExerciseId: week.squat, position: 1, ...(value as SetPrescription) };
			return tx.insert(setPrescriptions).values(row);
		}
		if (part === 'segment') {
			const row = { sessionId: week.run, position: 1, ...(value as RunSegment) };
			return tx.insert(plannedRunSegments).values(row);
		}
		return tx
			.insert(plannedSessionDetails)
			.values({ sessionId: week.muayThai, ...(value as OtherDetails) });
	};
}

/** [what is wrong, the valid value it changes, the change, where zod reports it]. */
type Bad = [string, object, Record<string, unknown>, string];

const NO_REPS = { repsMin: null, repsMax: null };

/** Per part, per CHECK (named without its table and `_ck`): the values both must refuse. */
const BAD: Record<Part, Record<string, Bad[]>> = {
	set: {
		sets: [
			['0 sets', BY_RPE, { sets: 0 }, 'sets'],
			['21 sets', BY_RPE, { sets: 21 }, 'sets']
		],
		reps: [
			['0 reps', BY_RPE, { repsMin: 0 }, 'repsMin'],
			['101 reps', BY_RPE, { repsMin: 101, repsMax: 101 }, 'repsMax'],
			['reps_min > reps_max', BY_RPE, { repsMin: 8, repsMax: 5 }, 'repsMax'],
			['half a rep range', BY_RPE, { repsMax: null }, 'repsMax']
		],
		measure: [
			['no measure', BY_RPE, NO_REPS, 'repsMin'],
			['reps and seconds', BY_RPE, { seconds: 30 }, 'seconds'],
			['seconds and metres', BY_RPE, { ...NO_REPS, seconds: 30, metres: 20 }, 'metres']
		],
		seconds: [
			['0 seconds', BY_RPE, { ...NO_REPS, seconds: 0 }, 'seconds'],
			['over an hour', BY_RPE, { ...NO_REPS, seconds: 3601 }, 'seconds']
		],
		metres: [
			['0 metres', BY_RPE, { ...NO_REPS, metres: 0 }, 'metres'],
			['over 10 km', BY_RPE, { ...NO_REPS, metres: 10_001 }, 'metres']
		],
		target_rpe: [
			['RPE 4.5', BY_RPE, { targetRpe: 4.5 }, 'targetRpe'],
			['RPE 10.5', BY_RPE, { targetRpe: 10.5 }, 'targetRpe'],
			['RPE off the half steps', BY_RPE, { targetRpe: 7.25 }, 'targetRpe']
		],
		rest: [
			['negative rest', BY_RPE, { restSeconds: -1 }, 'restSeconds'],
			['rest over 15 minutes', BY_RPE, { restSeconds: 901 }, 'restSeconds']
		],
		tempo: [
			['a tempo that is not one', BY_RPE, { tempo: 'slow' }, 'tempo'],
			['a lower-case explosive x', BY_RPE, { tempo: '31x0' }, 'tempo']
		],
		load_kind: [['an unknown load kind', BY_RPE, { loadKind: 'velocity' }, 'loadKind']],
		load_unit: [['an unknown load unit', ABSOLUTE, { loadUnit: 'st' }, 'loadUnit']],
		load_basis: [['an unknown load basis', PERCENT, { loadBasis: 'guessed' }, 'loadBasis']],
		reference_1rm_unit: [
			['an unknown 1RM unit', PERCENT, { reference1rmUnit: 'st' }, 'reference1rmUnit']
		],
		rpe_based: [['rpe_based without an RPE', BY_RPE, { targetRpe: null }, 'targetRpe']],
		load_needs: [
			['rpe_based with a load', BY_RPE, { loadValue: 100 }, 'loadValue'],
			['absolute without a unit', ABSOLUTE, { loadUnit: null }, 'loadUnit'],
			['absolute without a weight', ABSOLUTE, { loadValue: null }, 'loadValue'],
			['absolute with a basis', ABSOLUTE, { loadBasis: 'measured' }, 'loadBasis'],
			['percent_1rm without a basis', PERCENT, { loadBasis: null }, 'loadBasis'],
			['percent_1rm without a 1RM', PERCENT, { reference1rm: null }, 'reference1rm'],
			['percent_1rm without its unit', PERCENT, { reference1rmUnit: null }, 'reference1rmUnit'],
			['percent_1rm with a load unit', PERCENT, { loadUnit: 'kg' }, 'loadUnit'],
			['from_e1rm without a fraction', FROM_E1RM, { loadValue: null }, 'loadValue'],
			['from_e1rm with a unit', FROM_E1RM, { loadUnit: 'kg' }, 'loadUnit'],
			['from_e1rm with a 1RM', FROM_E1RM, { reference1rm: 180 }, 'reference1rm']
		],
		load_value: [
			['percent > 1', PERCENT, { loadValue: 1.05 }, 'loadValue'],
			['percent below 30 %', PERCENT, { loadValue: 0.25 }, 'loadValue'],
			['from_e1rm above 100 %', FROM_E1RM, { loadValue: 1.1 }, 'loadValue'],
			['over 500 kg', ABSOLUTE, { loadValue: 500.5 }, 'loadValue'],
			['under 1 kg', ABSOLUTE, { loadValue: 0.5 }, 'loadValue'],
			['over 1100 lb', ABSOLUTE, { loadUnit: 'lb', loadValue: 1100.5 }, 'loadValue'],
			['under 2 lb', ABSOLUTE, { loadUnit: 'lb', loadValue: 1.5 }, 'loadValue']
		],
		reference_1rm: [
			['a 1RM over 500 kg', PERCENT, { reference1rm: 501 }, 'reference1rm'],
			['a 1RM under 2 lb', PERCENT, { reference1rm: 1.5, reference1rmUnit: 'lb' }, 'reference1rm']
		]
	},
	segment: {
		measure: [
			['neither distance nor duration', INTERVAL, { distanceMetres: null }, 'distanceMetres']
		],
		distance: [['a 0 m segment', INTERVAL, { distanceMetres: 0 }, 'distanceMetres']],
		duration: [
			['a 0 s segment', INTERVAL, { distanceMetres: null, durationSeconds: 0 }, 'durationSeconds']
		],
		repeats: [
			['repeats with no group', INTERVAL, { repeatGroup: null }, 'repeatGroup'],
			['a group with no repeats', INTERVAL, { repeats: null }, 'repeats'],
			['a single repeat', INTERVAL, { repeats: 1 }, 'repeats'],
			['repeat group 0', INTERVAL, { repeatGroup: 0 }, 'repeatGroup']
		],
		pace: [
			['pace min > max', INTERVAL, { paceMinSecondsPerKm: 250 }, 'paceMaxSecondsPerKm'],
			['half a pace range', INTERVAL, { paceMaxSecondsPerKm: null }, 'paceMaxSecondsPerKm'],
			['a pace of 0', INTERVAL, { paceMinSecondsPerKm: 0 }, 'paceMinSecondsPerKm']
		],
		hr_zone: [
			['HR zone 6', INTERVAL, { hrZone: 6 }, 'hrZone'],
			['HR zone 0', INTERVAL, { hrZone: 0 }, 'hrZone']
		],
		target_rpe: [
			['RPE 0.5', INTERVAL, { targetRpe: 0.5 }, 'targetRpe'],
			['RPE 10.5', INTERVAL, { targetRpe: 10.5 }, 'targetRpe'],
			['RPE off the half steps', INTERVAL, { targetRpe: 6.75 }, 'targetRpe']
		]
	},
	details: {
		metrics: [['metrics not an array', CLASS, { metrics: { rounds: 6 } }, 'metrics']],
		duration: [['a 0-minute session', CLASS, { durationMinutes: 0 }, 'durationMinutes']],
		target_rpe: [
			['RPE 0', CLASS, { targetRpe: 0 }, 'targetRpe'],
			['RPE 11', CLASS, { targetRpe: 11 }, 'targetRpe'],
			['RPE off the half steps', CLASS, { targetRpe: 7.25 }, 'targetRpe']
		]
	},
	exercise: {
		superset: [['superset 0', SQUAT, { superset: 0 }, 'superset']],
		substitution: [
			[
				'a swap with no reason',
				SQUAT,
				{ substitutedFrom: { key: 'front_squat' } },
				'substitutionReason'
			],
			['a reason with no swap', SQUAT, { substitutionReason: 'pain' }, 'substitutionReason']
		]
	}
};

/** A CHECK's full name. */
const checkName = (part: Part, check: string) => `${TABLE[part]}_${check}_ck`;

/** [what is at the edge, the valid value it changes, the change]: both must accept it. */
type Good = [string, object, Record<string, unknown>];

const GOOD: Record<Part, Good[]> = {
	set: [
		['1 set', BY_RPE, { sets: 1 }],
		['20 sets', BY_RPE, { sets: 20 }],
		['a single rep', BY_RPE, { repsMin: 1, repsMax: 1 }],
		['100 reps', BY_RPE, { repsMin: 100, repsMax: 100 }],
		['a 1-second hold', BY_RPE, { ...NO_REPS, seconds: 1 }],
		['an hour', BY_RPE, { ...NO_REPS, seconds: 3600 }],
		['1 metre', BY_RPE, { ...NO_REPS, metres: 1 }],
		['10 km', BY_RPE, { ...NO_REPS, metres: 10_000 }],
		['RPE 5', BY_RPE, { targetRpe: 5 }],
		['RPE 10', BY_RPE, { targetRpe: 10 }],
		['RPE 9.5', BY_RPE, { targetRpe: 9.5 }],
		['no rest', BY_RPE, { restSeconds: 0 }],
		['15 minutes of rest', BY_RPE, { restSeconds: 900 }],
		['rest not given', BY_RPE, { restSeconds: null }],
		['an explosive tempo', BY_RPE, { tempo: '31X0' }],
		['1 kg', ABSOLUTE, { loadValue: 1 }],
		['500 kg', ABSOLUTE, { loadValue: 500 }],
		['2 lb', ABSOLUTE, { loadUnit: 'lb', loadValue: 2 }],
		['1100 lb', ABSOLUTE, { loadUnit: 'lb', loadValue: 1100 }],
		['a weight with an RPE', ABSOLUTE, { targetRpe: 8 }],
		['30 % of a 1RM', PERCENT, { loadValue: 0.3 }],
		['100 % of a 1RM', PERCENT, { loadValue: 1 }],
		[
			'an estimated 1RM in lb',
			PERCENT,
			{ loadBasis: 'estimated', reference1rm: 1100, reference1rmUnit: 'lb' }
		],
		['a 1 kg 1RM', PERCENT, { reference1rm: 1 }],
		['30 % of an e1RM', FROM_E1RM, { loadValue: 0.3 }],
		['100 % of an e1RM', FROM_E1RM, { loadValue: 1 }]
	],
	segment: [
		['HR zone 1', INTERVAL, { hrZone: 1 }],
		['HR zone 5', INTERVAL, { hrZone: 5 }],
		['RPE 1', INTERVAL, { targetRpe: 1 }],
		['RPE 10', INTERVAL, { targetRpe: 10 }],
		['two repeats', INTERVAL, { repeats: 2 }],
		['a distance and a duration', INTERVAL, { durationSeconds: 75 }],
		['an even pace', INTERVAL, { paceMinSecondsPerKm: 240, paceMaxSecondsPerKm: 240 }],
		// The contract's caps, which Postgres leaves to it: it accepts them too.
		['2:00 to 25:00 per km', INTERVAL, { paceMinSecondsPerKm: 120, paceMaxSecondsPerKm: 1500 }],
		['20 groups of 50', INTERVAL, { repeatGroup: 20, repeats: 50 }],
		['100 km', INTERVAL, { repeatGroup: null, repeats: null, distanceMetres: 100_000 }],
		['6 hours', INTERVAL, { distanceMetres: null, durationSeconds: 21_600 }]
	],
	details: [
		['10 minutes', CLASS, { durationMinutes: 10 }],
		['300 minutes', CLASS, { durationMinutes: 300 }],
		['RPE 1', CLASS, { targetRpe: 1 }],
		['RPE 10', CLASS, { targetRpe: 10 }],
		['no RPE', CLASS, { targetRpe: null }],
		['no metrics', CLASS, { metrics: [] }],
		['20 metrics', CLASS, { metrics: Array.from({ length: 20 }, (_, i) => metric(`m${i}`, i)) }]
	],
	exercise: [
		['superset 1', SQUAT, { superset: 1 }],
		['superset 10', SQUAT, { superset: 10 }],
		[
			'a swap with its reason',
			SQUAT,
			{ substitutedFrom: { key: 'front_squat' }, substitutionReason: 'injury' }
		]
	]
};

const PARTS = Object.keys(TABLE) as Part[];

/** The CHECKs only Postgres has: the contract orders by array index, not by a position. */
const POSITION_CHECKS = (['exercise', 'set', 'segment'] as const).map((p) =>
	checkName(p, 'position')
);

// ---- tests ----------------------------------------------------------------------------------

describe('planned prescriptions', () => {
	it('round-trip a planned week of strength, an interval run and a Muay Thai class, in order', async () => {
		await withRollback(async (db) => {
			const week = await storeWeek(db);
			const plan = strengthPlan(await customExercise(db, week.ownerId, 'Banded hip walk'));
			for (const e of plan) expect(validate(plannedExerciseSchema, e)).toMatchObject({ ok: true });
			expect(validate(runSegmentsSchema, INTERVALS)).toMatchObject({ ok: true });
			expect(validate(otherDetailsSchema, CLASS)).toMatchObject({ ok: true });

			await storeStrength(db, week, plan);
			await storeRun(db, week.run, INTERVALS);
			await db.insert(plannedSessionDetails).values({ sessionId: week.muayThai, ...CLASS });

			expect(await readStrength(db, week)).toEqual(plan);
			expect(await readRun(db, week.run)).toEqual(INTERVALS);
			expect(await readDetails(db, week.muayThai)).toEqual(CLASS);
			// Nothing else is in the other sessions.
			expect(await readRun(db, week.strength)).toEqual([]);
			expect(await readDetails(db, week.run)).toBeUndefined();

			// Each planned exercise has a lineage of its own, which its copies in later versions keep.
			const lineages = await db
				.select({ lineage: plannedExercises.lineageId })
				.from(plannedExercises)
				.where(eq(plannedExercises.sessionId, week.strength));
			expect(new Set(lineages.map((l) => l.lineage)).size).toBe(plan.length);

			// A row, without its keys and position, is the contract's value.
			type Row<T extends { $inferSelect: object }, K extends string> = Omit<T['$inferSelect'], K>;
			expectTypeOf<
				Row<typeof setPrescriptions, 'id' | 'plannedExerciseId' | 'position'>
			>().toEqualTypeOf<SetPrescription>();
			expectTypeOf<
				Row<typeof plannedRunSegments, 'id' | 'sessionId' | 'position'>
			>().toEqualTypeOf<RunSegment>();
			expectTypeOf<Row<typeof plannedSessionDetails, 'sessionId'>>().toEqualTypeOf<OtherDetails>();
			expectTypeOf<
				Row<
					typeof plannedExercises,
					'id' | 'sessionId' | 'lineageId' | 'position' | 'exerciseId' | 'substitutedFromExerciseId'
				>
			>().toEqualTypeOf<Omit<PlannedExercisePlan, 'exercise' | 'substitutedFrom' | 'sets'>>();
		});
	});

	it('are refused alike by the CHECKs and the zod schemas, for every bad value in one table', async () => {
		await withRollback(async (db) => {
			const week = await storeWeek(db);
			const [squat] = await storeStrength(db, week, [{ ...SQUAT, sets: [] }]);
			const at = { ...week, squat: squat! };

			for (const part of PARTS) {
				for (const [check, cases] of Object.entries(BAD[part])) {
					for (const [what, base, change, path] of cases) {
						const value = { ...base, ...change };
						expect(zodPaths(part, value), `${what}: zod`).toContain(path);
						expect(await attempt(db, write(at, part, value)), `${what}: Postgres`).toEqual(
							refused('23514', TABLE[part], checkName(part, check))
						);
					}
				}
			}
		});
	});

	it('are accepted alike at every edge the zod schemas accept', async () => {
		await withRollback(async (db) => {
			const week = await storeWeek(db);
			const [squat] = await storeStrength(db, week, [{ ...SQUAT, sets: [] }]);
			const at = { ...week, squat: squat! };

			for (const part of PARTS) {
				for (const [what, base, change] of GOOD[part]) {
					const value = { ...base, ...change };
					expect(zodPaths(part, value), `${what}: zod`).toEqual([]);
					expect(await attempt(db, write(at, part, value)), `${what}: Postgres`).toBeNull();
				}
			}
		});
	});

	it('have no CHECK that the shared table leaves out, positions aside', async () => {
		await withRollback(async (db) => {
			const tables = sql.join(
				PRESCRIPTION_TABLES.map((table) => sql`${table}`),
				sql`, `
			);
			const { rows } = await db.execute<{ name: string }>(
				sql`select c.conname as name from pg_constraint c join pg_class t on t.oid = c.conrelid
					where c.contype = 'c' and t.relname in (${tables})`
			);
			const shared = PARTS.flatMap((part) =>
				Object.keys(BAD[part]).map((check) => checkName(part, check))
			);
			expect(rows.map((row) => row.name).sort()).toEqual([...shared, ...POSITION_CHECKS].sort());
			expect(PRESCRIPTION_TABLES).toEqual(Object.values(TABLE).sort());
		});
	});

	it('keep one row per position, numbered from 1, and one details row per session', async () => {
		await withRollback(async (db) => {
			const week = await storeWeek(db);
			const [squat] = await storeStrength(db, week, [SQUAT]);
			await storeRun(db, week.run, [INTERVAL]);
			await db.insert(plannedSessionDetails).values({ sessionId: week.muayThai, ...CLASS });
			const exerciseAt = (position: number) => (tx: Executor) =>
				tx.insert(plannedExercises).values(exerciseRow(week, week.strength, position, SQUAT));
			const setAt = (position: number) => (tx: Executor) =>
				tx.insert(setPrescriptions).values({ plannedExerciseId: squat!, position, ...BY_RPE });
			const segmentAt = (position: number) => (tx: Executor) =>
				tx.insert(plannedRunSegments).values({ sessionId: week.run, position, ...INTERVAL });

			expect(await attempt(db, exerciseAt(0))).toEqual(
				refused('23514', 'planned_exercises', 'planned_exercises_position_ck')
			);
			expect(await attempt(db, setAt(0))).toEqual(
				refused('23514', 'set_prescriptions', 'set_prescriptions_position_ck')
			);
			expect(await attempt(db, segmentAt(0))).toEqual(
				refused('23514', 'planned_run_segments', 'planned_run_segments_position_ck')
			);
			expect(await attempt(db, exerciseAt(1))).toEqual(
				refused('23505', 'planned_exercises', 'planned_exercises_session_position_uq')
			);
			expect(await attempt(db, setAt(1))).toEqual(
				refused('23505', 'set_prescriptions', 'set_prescriptions_exercise_position_uq')
			);
			expect(await attempt(db, segmentAt(1))).toEqual(
				refused('23505', 'planned_run_segments', 'planned_run_segments_session_position_uq')
			);
			expect(
				await attempt(db, (tx) =>
					tx.insert(plannedSessionDetails).values({ sessionId: week.muayThai, ...CLASS })
				)
			).toEqual(refused('23505', 'planned_session_details', 'planned_session_details_pkey'));
			expect(await attempt(db, exerciseAt(2))).toBeNull();
		});
	});
});

describe('prescription history', () => {
	/** A week with one row in every prescription table: the squat's set, an interval, the class. */
	async function storeOneOfEach(db: Executor) {
		const week = await storeWeek(db);
		const [squat] = await storeStrength(db, week, [SQUAT]);
		const [interval] = await storeRun(db, week.run, [INTERVAL]);
		await db.insert(plannedSessionDetails).values({ sessionId: week.muayThai, ...CLASS });
		return { ...week, squat: squat!, interval: interval!.id };
	}

	it('refuses every UPDATE and DELETE of a stored prescription', async () => {
		await withRollback(async (db) => {
			const w = await storeOneOfEach(db);
			const updates: Record<string, SQL> = {
				planned_exercises: sql`update planned_exercises set notes = 'Rewritten' where id = ${w.squat}`,
				set_prescriptions: sql`update set_prescriptions set sets = 4 where planned_exercise_id = ${w.squat}`,
				planned_run_segments: sql`update planned_run_segments set repeats = 5 where id = ${w.interval}`,
				planned_session_details: sql`update planned_session_details set duration_minutes = 60 where session_id = ${w.muayThai}`
			};
			const deletes: Record<string, SQL> = {
				planned_exercises: sql`delete from planned_exercises where id = ${w.squat}`,
				set_prescriptions: sql`delete from set_prescriptions where planned_exercise_id = ${w.squat}`,
				planned_run_segments: sql`delete from planned_run_segments where id = ${w.interval}`,
				planned_session_details: sql`delete from planned_session_details where session_id = ${w.muayThai}`
			};
			expect(Object.keys(updates).sort()).toEqual(PRESCRIPTION_TABLES);
			expect(Object.keys(deletes).sort()).toEqual(PRESCRIPTION_TABLES);

			for (const [table, statement] of Object.entries(updates)) {
				expect(await attempt(db, (tx) => tx.execute(statement)), `update ${table}`).toEqual(
					refused('23001', table, 'history_refuse_update')
				);
			}
			for (const [table, statement] of Object.entries(deletes)) {
				expect(await attempt(db, (tx) => tx.execute(statement)), `delete ${table}`).toEqual(
					refused('23001', table, 'history_refuse_delete')
				);
			}
			expect(await readStrength(db, w)).toEqual([SQUAT]);
			expect(await readRun(db, w.run)).toEqual([INTERVAL]);
			expect(await readDetails(db, w.muayThai)).toEqual(CLASS);
		});
	});

	it('is purged with its program by TRUNCATE programs CASCADE; the exercises stay', async () => {
		await withRollback(async (db) => {
			const week = await storeWeek(db);
			await storeStrength(
				db,
				week,
				strengthPlan(await customExercise(db, week.ownerId, 'Hip walk'))
			);
			await storeRun(db, week.run, INTERVALS);
			await db.insert(plannedSessionDetails).values({ sessionId: week.muayThai, ...CLASS });
			const before = await counts(db);
			expect(Object.values(before).every((n) => n > 0)).toBe(true);

			await db.execute(sql`truncate programs cascade`);

			expect(await counts(db)).toEqual({
				...Object.fromEntries(PRESCRIPTION_TABLES.map((table) => [table, 0])),
				exercises: before.exercises
			});
		});
	});

	it('keeps an exercise that a plan prescribes or swapped out; one nothing names can go', async () => {
		await withRollback(async (db) => {
			const week = await storeWeek(db);
			const prescribed = await customExercise(db, week.ownerId, 'Banded hip walk');
			const replaced = await customExercise(db, week.ownerId, 'Monster walk');
			const unused = await customExercise(db, week.ownerId, 'Clamshell');
			await storeStrength(db, week, [
				exercise({ customId: prescribed }, [BY_RPE], {
					substitutedFrom: { customId: replaced },
					substitutionReason: 'owner_choice'
				})
			]);
			const remove = (id: string) => (tx: Executor) =>
				tx.delete(exercises).where(eq(exercises.id, id));

			expect(await attempt(db, remove(prescribed))).toEqual(
				refused('23503', 'planned_exercises', 'planned_exercises_exercise_id_exercises_id_fk')
			);
			expect(await attempt(db, remove(replaced))).toEqual(
				refused(
					'23503',
					'planned_exercises',
					'planned_exercises_substituted_from_exercise_id_exercises_id_fk'
				)
			);
			expect(await attempt(db, remove(unused))).toBeNull();
		});
	});
});
