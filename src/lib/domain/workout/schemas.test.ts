import { describe, expect, expectTypeOf, it } from 'vitest';
import type * as z from 'zod/mini';
import { editOtherSessionSchema, editRunSchema, editSetSchema } from '../training/schemas';
import { validate } from '../validation';
import { createMutation, MUTATION_RULES, MUTATION_TYPES } from './mutations';
import type { Mutation, MutationOf, MutationPayloads, MutationType } from './mutations';
import { checkMetrics } from './other';
import type { SyncRequest } from './protocol';
import {
	DB_CHECKED_BAD_VALUES,
	envelopeSchema,
	PAYLOAD_SCHEMAS,
	SCHEMA_ONLY_BAD_VALUES,
	syncRequestSchema
} from './schemas';
import type { BadValue } from './schemas';

const AT = '2026-11-06T18:00:00.000Z';
const W = '00000000-0000-4000-8000-00000000000a';
const ROW = '00000000-0000-4000-8000-0000000000a1';
const SQUAT = '00000000-0000-4000-8000-0000000000e1';
const LEG_PRESS = '00000000-0000-4000-8000-0000000000e2';
const SWAP = '00000000-0000-4000-8000-0000000000c1';

let n = 0;
const freshId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

const done = {
	reps: 5,
	seconds: null,
	metres: null,
	weight: 100,
	assistance: null,
	unit: 'kg',
	rpe: 8,
	missedReps: 0,
	isWarmup: false,
	isExtra: false
} as const;
const place = { position: 1, setIndex: 1, exerciseId: SQUAT, plannedLineage: null };
const slot = { position: 2, plannedLineage: null };

/** A valid payload of every type: a missing type fails pnpm check. */
const PAYLOADS: { [T in MutationType]: MutationPayloads[T] } = {
	'workout.start': {
		kind: 'strength',
		title: 'Lower body & pull',
		sessionType: 'strength',
		discipline: 'strength',
		plannedSessionId: null,
		plannedLineage: null,
		programId: null
	},
	'workout.update': { notes: 'Felt quick' },
	'workout.finish': { durationSeconds: 3900, sessionRpe: 8 },
	'workout.abandon': {},
	'set.log': { ...place, ...done },
	'set.skip': { ...place, unit: 'kg' },
	'set.edit': { ...done, reps: 4 },
	'set.delete': {},
	'exercise.skip': {
		...slot,
		exerciseId: LEG_PRESS,
		unit: 'kg',
		sets: [
			{ id: freshId(), setIndex: 2 },
			{ id: freshId(), setIndex: 3 }
		]
	},
	'exercise.substitute': {
		...slot,
		fromExerciseId: LEG_PRESS,
		toExerciseId: SQUAT,
		reason: 'equipment_unavailable'
	},
	'exercise.dislike': { ...slot, fromExerciseId: LEG_PRESS, toExerciseId: SQUAT, note: null },
	'exercise.create': {
		name: 'Sandbag shouldering',
		aliases: [],
		pattern: 'carry',
		primaryMuscles: ['glutes'],
		secondaryMuscles: [],
		equipment: [],
		substitutionGroup: null,
		skillLevel: 'beginner',
		repMin: 3,
		repMax: 8,
		defaultSeconds: null,
		unilateral: false,
		measure: 'reps',
		loadType: 'external',
		tags: [],
		disciplines: []
	},
	'pain.report': {
		...slot,
		exerciseId: LEG_PRESS,
		area: 'knee',
		severity: 'mild',
		action: 'stopped',
		substitutionId: null,
		note: null
	},
	'run.log': { distanceMetres: 5000 },
	'run.segment': {
		position: 1,
		kind: 'warm_up',
		distanceMetres: null,
		durationSeconds: 600,
		avgHr: null,
		rpe: null
	},
	'other.log': { kind: 'class', durationMinutes: 90, rpe: 7, metrics: [], notes: null }
};

/** A valid mutation of `type` for workout W, as createMutation makes it. */
function make<T extends MutationType>(type: T, payload: unknown = PAYLOADS[type]): MutationOf<T> {
	const { identity, entity } = MUTATION_RULES[type];
	const needsRow = identity === 'edit' && entity !== 'workout';
	return createMutation(
		type,
		{
			workoutId: W,
			entityId: needsRow ? ROW : undefined,
			at: AT,
			payload: payload as MutationPayloads[T]
		},
		freshId
	);
}

/** Field errors of a mutation, or {} when it passes. */
const errorsOf = (input: unknown) => {
	const result = validate(envelopeSchema, input);
	return result.ok ? {} : result.errors;
};

/** A valid mutation of the bad value's type, with the bad value in it. */
const withBadValue = (bad: BadValue) => {
	const m = make(bad.type);
	return { ...m, ...bad.envelope, payload: { ...m.payload, ...bad.payload } };
};

describe('one schema per mutation type', () => {
	it('covers every type, and a valid mutation of each passes unchanged', () => {
		expect(Object.keys(PAYLOAD_SCHEMAS)).toEqual(MUTATION_TYPES);
		for (const type of MUTATION_TYPES) {
			const m = make(type);
			expect(validate(envelopeSchema, m), type).toEqual({ ok: true, data: m });
		}
	});

	it('gives each schema its contract type as output', () => {
		// Compile-time: pnpm check fails when a schema and its contract type drift apart.
		// (branded: the contract spells payloads as intersections, the schemas as flat objects.)
		type Typed = Exclude<MutationType, 'exercise.create'>;
		type Outputs = { [T in Typed]: z.output<(typeof PAYLOAD_SCHEMAS)[T]> };
		type Envelopes = { [T in Typed]: Extract<z.output<typeof envelopeSchema>, { type: T }> };
		expectTypeOf<Outputs>().branded.toEqualTypeOf<Pick<MutationPayloads, Typed>>();
		expectTypeOf<Envelopes>().branded.toEqualTypeOf<{ [T in Typed]: MutationOf<T> }>();
		expectTypeOf<z.output<typeof envelopeSchema>['type']>().toEqualTypeOf<MutationType>();
		expectTypeOf<z.output<typeof envelopeSchema>>().toExtend<Mutation>();
		expectTypeOf<z.output<typeof syncRequestSchema>>().toExtend<SyncRequest>();
		// M3's custom exercise, as M3 checks it: the catalogue's lists are read-only.
		type Created = z.output<(typeof PAYLOAD_SCHEMAS)['exercise.create']>;
		expectTypeOf<Created>().toExtend<MutationPayloads['exercise.create']>();
		expectTypeOf<keyof Created>().toEqualTypeOf<keyof MutationPayloads['exercise.create']>();
		// At run time too: an instant stays the device's string, not M3's Date.
		const parsed = validate(envelopeSchema, make('set.log'));
		expect(parsed.ok && parsed.data.at).toBe(AT);
	});

	it('reports a bound at its dotted path, with M3’s own words', () => {
		const tooHeavy = make('set.log', { ...place, ...done, weight: 1000.5 });
		expect(errorsOf(tooHeavy)).toEqual({ 'payload.weight': 'Up to 1000 kg' });

		const longSegment = { ...PAYLOADS['run.segment'], durationSeconds: 86_401 };
		expect(errorsOf(make('run.segment', longSegment))).toEqual({
			'payload.durationSeconds': 'Up to a day'
		});

		const where = { ...PAYLOADS['pain.report'], area: 'elbow pit' };
		expect(errorsOf(make('pain.report', where))).toEqual({
			'payload.area': 'Pick where it hurts'
		});

		const plank = { ...PAYLOADS['exercise.create'], measure: 'time', repMin: null, repMax: null };
		expect(errorsOf(make('exercise.create', plank))).toEqual({
			'payload.defaultSeconds': 'How long is one bout or hold?'
		});
	});

	it('takes each logged value’s bound from M3’s schema, so it has one definition', () => {
		const m3 = (schema: z.ZodMiniType, input: unknown) => {
			const result = validate(schema, input);
			return result.ok ? {} : result.errors;
		};
		const m3Set = { ...done, isSkipped: false };
		for (const change of [
			{ reps: 101 },
			{ missedReps: 51 },
			{ rpe: 7.3 },
			{ reps: null, seconds: 86_401 },
			{ weight: 2201, unit: 'lb' },
			{ weight: 20, assistance: 10 },
			{ reps: null }
		]) {
			const [path, message] = Object.entries(m3(editSetSchema, { ...m3Set, ...change }))[0]!;
			expect(errorsOf(make('set.edit', { ...done, ...change })), path).toEqual({
				[`payload.${path}`]: message
			});
		}
		const run = { distance: null, durationSeconds: null, avgHr: 300, rpe: 11, notes: '' };
		const runErrors = m3(editRunSchema, run);
		expect(errorsOf(make('run.log', { avgHr: 300, rpe: 11, notes: '' }))).toEqual({
			'payload.avgHr': runErrors.avgHr,
			'payload.rpe': runErrors.rpe,
			'payload.notes': runErrors.notes
		});
		const other = { ...PAYLOADS['other.log'], durationMinutes: 601 };
		expect(errorsOf(make('other.log', other))).toEqual({
			'payload.durationMinutes': m3(editOtherSessionSchema, other).durationMinutes
		});
	});
});

describe('M4’s own fields', () => {
	it('holds the envelope to wire format v1 and the identity rule', () => {
		const log = make('set.log');
		expect(errorsOf({ ...log, v: 2 })).toEqual({ v: 'Wire format v1' });
		expect(errorsOf({ ...log, id: 'set-1' })).toMatchObject({ id: 'Unknown id' });
		expect(errorsOf({ ...log, at: 'yesterday' })).toEqual({ at: 'Use a date and time' });
		expect(errorsOf({ ...log, type: 'set.teleport' })).toEqual({
			type: 'Not a change this server knows'
		});
		expect(errorsOf({ ...log, id: freshId() })).toEqual({ id: 'A new row has the id' });
		const edit = make('set.edit');
		expect(errorsOf({ ...edit, id: edit.entityId })).toEqual({
			id: 'A change has an id of its own'
		});
		expect(errorsOf({ ...make('run.log'), entityId: ROW })).toEqual({
			entityId: 'Not this change’s workout'
		});
		expect(errorsOf(make('run.segment'))).toEqual({});
		const segmentEdit = createMutation('run.segment', {
			workoutId: W,
			entityId: ROW,
			at: AT,
			payload: PAYLOADS['run.segment']
		});
		expect(errorsOf(segmentEdit)).toEqual({});
	});

	it('refuses values on a type that carries none', () => {
		expect(errorsOf(make('set.delete', { weight: 100 }))).toEqual({
			'payload.weight': 'Nothing goes here'
		});
		expect(errorsOf(make('workout.abandon', { notes: 'Tired' }))).toEqual({
			'payload.notes': 'Nothing goes here'
		});
	});

	it('names no plan on an ad-hoc workout', () => {
		const start = { ...PAYLOADS['workout.start'], programId: freshId() };
		expect(errorsOf(make('workout.start', start))).toEqual({
			'payload.programId': 'An ad-hoc workout has no plan'
		});
		const planned = { ...start, plannedSessionId: freshId(), plannedLineage: freshId() };
		expect(errorsOf(make('workout.start', planned))).toEqual({});
	});

	it('skips each set once, under its own id', () => {
		const [a, b] = PAYLOADS['exercise.skip'].sets as [{ id: string; setIndex: number }, object];
		const skip = (sets: unknown[]) => make('exercise.skip', { ...PAYLOADS['exercise.skip'], sets });
		expect(errorsOf(skip([a, { ...b, id: a.id }]))).toEqual({
			'payload.sets.1.id': 'Each set once'
		});
		expect(errorsOf(skip([a, { id: freshId(), setIndex: a.setIndex }]))).toEqual({
			'payload.sets.1.setIndex': 'Each set once'
		});
		expect(errorsOf(skip([{ ...a, id: 'x' }]))).toEqual({ 'payload.sets.0.id': 'Unknown id' });
	});

	it('swaps to a different exercise, and a pain report names a substitution only for one', () => {
		const same = { ...PAYLOADS['exercise.substitute'], toExerciseId: LEG_PRESS };
		expect(errorsOf(make('exercise.substitute', same))).toEqual({
			'payload.toExerciseId': 'Pick a different exercise'
		});
		const sameDislike = { ...PAYLOADS['exercise.dislike'], toExerciseId: LEG_PRESS };
		expect(errorsOf(make('exercise.dislike', sameDislike))).toMatchObject({
			'payload.toExerciseId': 'Pick a different exercise'
		});

		const pain = PAYLOADS['pain.report'];
		const swapped = { ...pain, action: 'substituted', substitutionId: SWAP };
		expect(errorsOf(make('pain.report', swapped))).toEqual({});
		const missing = { ...pain, action: 'substituted' };
		const stray = { ...pain, substitutionId: SWAP };
		for (const report of [missing, stray]) {
			expect(errorsOf(make('pain.report', report))).toEqual({
				'payload.substitutionId': 'A substitution goes with a gentler option'
			});
		}
		const unsure = { ...pain, area: null, severity: null };
		expect(errorsOf(make('pain.report', unsure))).toEqual({});
	});

	it('takes a run’s fields one at a time, and a segment with a distance or a duration', () => {
		expect(errorsOf(make('run.log', {}))).toEqual({});
		expect(errorsOf(make('run.log', { distanceMetres: 500_001 }))).toEqual({
			'payload.distanceMetres': 'Up to 500 km'
		});
		const unmeasured = { ...PAYLOADS['run.segment'], durationSeconds: null };
		expect(errorsOf(make('run.segment', unmeasured))).toEqual({
			'payload.distanceMetres': 'Give a distance or a duration'
		});
	});

	it('syncs 1 to 25 mutations, reporting each at its place in the batch', () => {
		const batch = (mutations: unknown[]) => validate(syncRequestSchema, { v: 1, mutations });
		const mutations = MUTATION_TYPES.slice(0, 4).map((type) => make(type));
		expect(batch(mutations)).toEqual({ ok: true, data: { v: 1, mutations } });

		const segment = make('run.segment', { ...PAYLOADS['run.segment'], durationSeconds: 0 });
		expect(batch([...mutations.slice(0, 3), segment])).toEqual({
			ok: false,
			errors: { 'mutations.3.payload.durationSeconds': 'Up to a day' }
		});
		expect(batch([])).toEqual({ ok: false, errors: { mutations: 'Nothing to sync' } });
		const many = Array.from({ length: 26 }, () => make('set.log'));
		expect(batch(many)).toEqual({ ok: false, errors: { mutations: 'Up to 25 changes at once' } });
		expect(validate(syncRequestSchema, { v: 2, mutations })).toEqual({
			ok: false,
			errors: { v: 'Wire format v1' }
		});
	});
});

describe('the bad-value tables', () => {
	it.each([...DB_CHECKED_BAD_VALUES, ...SCHEMA_ONLY_BAD_VALUES].map((bad) => [bad.name, bad]))(
		'refuses %s at its path',
		(_, bad) => {
			const input = withBadValue(bad);
			const errors = errorsOf(input);
			if (bad.planned) {
				// Valid in itself: only the planned session's metrics refuse it.
				expect(errors).toEqual({});
				const { metrics } = (input as MutationOf<'other.log'>).payload;
				expect(Object.keys(checkMetrics(metrics, bad.planned))).toEqual([bad.path]);
				expect(checkMetrics(metrics, null)).toEqual({});
			} else {
				expect(Object.keys(errors)).toEqual([bad.path]);
			}
		}
	);

	it('lists what the brief names, each in its own table', () => {
		const names = (table: readonly BadValue[]) => table.map((bad) => bad.name);
		expect(names(DB_CHECKED_BAD_VALUES)).toEqual([
			'RPE 11',
			'RPE off the half steps',
			'reps -1',
			'missed reps 51',
			'seconds 0',
			'distance 0',
			'a weight with assistance',
			"severity 'extreme'",
			"pain action 'ignored'",
			'metrics that are not an array'
		]);
		expect(names(SCHEMA_ONLY_BAD_VALUES)).toEqual([
			'an unknown substitution reason',
			'an unknown mutation type',
			'v 2',
			'an unknown body area',
			'an unknown metric key on a planned session'
		]);
	});
});
