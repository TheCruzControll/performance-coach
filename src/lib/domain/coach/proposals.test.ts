import * as z from 'zod/mini';
import { describe, expect, it } from 'vitest';
import { goalSchema } from '../profile/schemas';
import {
	adjustDetailsSchema,
	adjustRunSegmentSchema,
	adjustSetSchema,
	moveSessionSchema,
	REASON_MAX,
	skipSessionSchema,
	swapSchema
} from '../training/edits';
import { validate } from '../validation';
import {
	ALTERNATIVE,
	EXERCISE,
	FIXTURES,
	GOAL,
	PLANNED,
	SESSION
} from '../../../../tests/fixtures/coach-proposals';
import {
	MAX_PROPOSAL_OPS,
	PAYLOAD_SCHEMAS,
	PROGRAM_OPS,
	PROPOSAL_KINDS,
	programOpSchema,
	proposalDraftSchema,
	proposalSchema,
	type ProgramOpKind
} from './proposals';

describe('proposalSchema', () => {
	it.each(PROPOSAL_KINDS)('takes a valid %s', (kind) => {
		const result = validate(proposalSchema, FIXTURES[kind]);
		expect(result).toMatchObject({ ok: true, data: { kind } });
		const { title, rationale, payload } = FIXTURES[kind];
		expect(validate(proposalDraftSchema(kind), { title, rationale, payload })).toMatchObject({
			ok: true
		});
	});

	it('needs a title of up to 80 characters and a non-empty rationale', () => {
		const base = FIXTURES.workout_update;
		expect(validate(proposalSchema, { ...base, title: 'x'.repeat(81), rationale: '  ' })).toEqual({
			ok: false,
			errors: { title: 'Up to 80 characters', rationale: 'Say why' }
		});
		expect(validate(proposalSchema, { ...base, title: ` ${'x'.repeat(80)} ` })).toMatchObject({
			ok: true
		});
		expect(validate(proposalSchema, { ...base, kind: 'rewrite_everything' })).toEqual({
			ok: false,
			errors: { kind: 'Unknown proposal kind' }
		});
	});

	it(`refuses more than ${MAX_PROPOSAL_OPS} ops, and none`, () => {
		const op = FIXTURES.workout_update.payload as { ops: unknown[] };
		const many = Array.from({ length: MAX_PROPOSAL_OPS + 1 }, () => op.ops[0]);
		const at = (ops: unknown[]) =>
			validate(proposalSchema, { ...FIXTURES.workout_update, payload: { ops } });
		expect(at(many.slice(1))).toMatchObject({ ok: true });
		expect(at(many)).toEqual({ ok: false, errors: { 'payload.ops': 'Up to 12 changes' } });
		expect(at([])).toEqual({ ok: false, errors: { 'payload.ops': 'Propose at least one change' } });
	});

	it('refuses a key no schema names, at every level, instead of dropping it', () => {
		const adjust = FIXTURES.program_adjustment;
		const goals = FIXTURES.goal_update.payload as { ops: [{ goal: object }, ...unknown[]] };
		const cases: [unknown, string][] = [
			[{ ...adjust, applied: true }, ''],
			[
				{ ...adjust, payload: { ...(adjust.payload as object), baseVersionId: SESSION } },
				'payload'
			],
			[
				{
					...adjust,
					payload: { ops: [{ op: 'skip', sessionLineage: SESSION, ownerId: SESSION }] }
				},
				'payload.ops.0'
			],
			[
				{
					...FIXTURES.goal_update,
					payload: { ops: [{ op: 'add', goal: { ...goals.ops[0].goal, priority: 1 } }] }
				},
				'payload.ops.0.goal'
			],
			[
				{
					...FIXTURES.next_cycle,
					payload: {
						...(FIXTURES.next_cycle.payload as { targets: object }),
						targets: { rpeCap: 8, volumeFactor: 1, loadStep: 0, runVolumeFactor: 1, sets: 9 }
					}
				},
				'payload.targets'
			]
		];
		for (const [input, path] of cases) {
			const result = validate(proposalSchema, input);
			expect(result.ok, path).toBe(false);
			if (!result.ok) expect(result.errors[path], path).toMatch(/^Unknown field: \w+$/);
		}
	});

	it('takes and refuses each goal exactly as M2’s goalSchema does', () => {
		const add = (goal: object) => ({
			...FIXTURES.goal_update,
			payload: { ops: [{ op: 'add', goal }] }
		});
		const fight = { kind: 'event', title: 'Fight', disciplines: ['custom'], eventType: 'Bout' };
		const goals = [
			(FIXTURES.goal_update.payload as { ops: [{ goal: object }] }).ops[0].goal,
			fight,
			{ ...fight, eventDate: '2027-03-01' },
			{ ...fight, eventDate: '2027-03-01', customDiscipline: 'Kickboxing' },
			{ kind: 'general', title: ' ', disciplines: [], focus: 'Squat', measure: '' },
			{ kind: 'race', title: 'Marathon' }
		];
		const refused = goals.map((goal) => {
			const theirs = validate(goalSchema, goal);
			const ours = validate(proposalSchema, add(goal));
			expect(ours.ok).toBe(theirs.ok);
			if (!theirs.ok && !ours.ok) {
				const prefixed = Object.entries(theirs.errors).map(([path, message]) => [
					`payload.ops.0.goal${path ? `.${path}` : ''}`,
					message
				]);
				expect(ours.errors).toEqual(Object.fromEntries(prefixed));
			}
			return !theirs.ok;
		});
		expect(refused).toEqual([false, true, true, false, true, true]);
		// M2's cross-field rule, which runs even beside a missing field.
		expect(validate(proposalSchema, add(fight))).toMatchObject({
			errors: { 'payload.ops.0.goal.customDiscipline': 'Name your custom discipline' }
		});
	});

	it('refuses a substitution or a rotation to the same exercise', () => {
		const substitution = FIXTURES.session_substitution;
		expect(
			validate(proposalSchema, {
				...substitution,
				payload: { ...(substitution.payload as object), toExerciseId: EXERCISE, reason: 'busy' }
			})
		).toEqual({
			ok: false,
			errors: { 'payload.reason': 'Pick a reason' }
		});
		expect(
			validate(proposalSchema, {
				...substitution,
				payload: { ...(substitution.payload as object), toExerciseId: EXERCISE }
			})
		).toEqual({ ok: false, errors: { 'payload.toExerciseId': 'Pick a different exercise' } });
		const cycle = FIXTURES.next_cycle;
		expect(
			validate(proposalSchema, {
				...cycle,
				payload: {
					...(cycle.payload as object),
					rotation: [{ fromExerciseId: ALTERNATIVE, toExerciseId: ALTERNATIVE }]
				}
			})
		).toEqual({
			ok: false,
			errors: { 'payload.rotation.0.toExerciseId': 'Pick a different exercise' }
		});
	});
});

/** M3's edit schemas, and the inputs M3's own tests (domain/training/edits.test.ts) give them. */
const M3: Record<ProgramOpKind, [z.ZodMiniType, Record<string, unknown>[]]> = {
	move: [
		moveSessionSchema,
		[
			{ sessionLineage: SESSION, toDate: '2026-11-11' },
			{ sessionLineage: SESSION, toDate: '2026-11-11', timeOfDay: null, reason: '  Work trip  ' },
			{
				sessionLineage: 'lower-a',
				toDate: '2026-11-31',
				timeOfDay: 'dawn',
				reason: 'x'.repeat(REASON_MAX + 1)
			},
			{}
		]
	],
	skip: [
		skipSessionSchema,
		[
			{ sessionLineage: SESSION, reason: ` ${'x'.repeat(REASON_MAX)} ` },
			{ sessionLineage: SESSION, reason: 3 }
		]
	],
	swap: [
		swapSchema,
		[
			{
				sessionLineage: SESSION,
				plannedExerciseLineage: PLANNED,
				toExerciseId: EXERCISE,
				scope: 'never_again'
			},
			{
				sessionLineage: SESSION,
				plannedExerciseLineage: PLANNED,
				toExerciseId: 'goblet_squat',
				scope: 'always'
			}
		]
	],
	adjust_set: [
		adjustSetSchema,
		[
			{
				sessionLineage: SESSION,
				plannedExerciseLineage: PLANNED,
				position: 1,
				targetRpe: 8.5,
				restSeconds: null
			},
			{
				sessionLineage: SESSION,
				plannedExerciseLineage: PLANNED,
				position: 0,
				targetRpe: 11,
				sets: 21
			}
		]
	],
	adjust_run_segment: [
		adjustRunSegmentSchema,
		[
			{ sessionLineage: SESSION, position: 2, distanceMetres: 5000 },
			{ sessionLineage: SESSION, position: 2, hrZone: 6 }
		]
	],
	adjust_details: [
		adjustDetailsSchema,
		[
			{ sessionLineage: SESSION, durationMinutes: 60 },
			{ sessionLineage: SESSION, durationMinutes: 5 }
		]
	]
};

describe('the replan payload', () => {
	const replan = (payload: object) => ({
		...FIXTURES.replan,
		payload: { ...(FIXTURES.replan.payload as object), ...payload }
	});
	const errorsOf = (input: unknown) => {
		const result = validate(proposalSchema, input);
		return result.ok ? {} : result.errors;
	};

	it('takes each directive, and refuses a start that is not a Monday at its path', () => {
		const deload = { kind: 'deload', week: '2026-11-16', trigger: 'reactive', reasons: ['Tired'] };
		const taper = { kind: 'taper', goalRef: GOAL, form: 'mini' };
		const priorities = { kind: 'priorities', cause: 'reorder' };
		for (const directive of [deload, taper, priorities])
			expect(errorsOf(replan({ directive }))).toEqual({});
		expect(errorsOf(replan({ from: '2026-11-17' }))).toEqual({
			'payload.from': 'Start on a Monday'
		});
		expect(errorsOf(replan({ fingerprint: 'stale' }))).toEqual({
			'payload.fingerprint': 'Not a digest'
		});
	});

	it('refuses a key its directive does not name, instead of dropping it', () => {
		const directive = { kind: 'priorities', cause: 'reorder', ops: [] };
		expect(errorsOf(replan({ directive }))).toEqual({ 'payload.directive': 'Unknown field: ops' });
		expect(errorsOf(replan({ change: 'all' }))).toEqual({ payload: 'Unknown field: change' });
	});
});

describe('programOpSchema', () => {
	it('has one op per M3 edit', () => {
		expect(Object.keys(M3)).toEqual([...PROGRAM_OPS]);
	});

	it.each(PROGRAM_OPS)('%s takes and refuses exactly what M3’s schema does', (op) => {
		const [schema, inputs] = M3[op];
		for (const input of inputs) {
			const ours = validate(programOpSchema, { op, ...input });
			const theirs = validate(schema, input);
			expect(ours.ok).toBe(theirs.ok);
			if (ours.ok && theirs.ok) expect(ours.data).toEqual({ op, ...(theirs.data as object) });
			if (!ours.ok && !theirs.ok) expect(ours.errors).toEqual(theirs.errors);
		}
		expect(inputs.some((input) => !validate(schema, input).ok)).toBe(true);
	});

	it('refuses an unknown op', () => {
		expect(validate(programOpSchema, { op: 'delete', sessionLineage: SESSION })).toEqual({
			ok: false,
			errors: { op: 'Pick a change' }
		});
	});
});

type Json = { [key: string]: unknown };

/** Every object node in a JSON Schema, with where it is. */
function objects(node: unknown, at = '$'): [string, Json][] {
	if (!node || typeof node !== 'object') return [];
	if (Array.isArray(node)) return node.flatMap((each, i) => objects(each, `${at}[${i}]`));
	const own = node as Json;
	const here: [string, Json][] = own.type === 'object' || 'properties' in own ? [[at, own]] : [];
	return here.concat(Object.entries(own).flatMap(([key, value]) => objects(value, `${at}.${key}`)));
}

describe('the JSON Schema of each kind', () => {
	it.each(PROPOSAL_KINDS)('closes every object of a %s', (kind) => {
		for (const schema of [PAYLOAD_SCHEMAS[kind], proposalDraftSchema(kind)]) {
			const found = objects(z.toJSONSchema(schema, { io: 'input' }));
			expect(found.length).toBeGreaterThan(0);
			for (const [at, node] of found) expect(node.additionalProperties, at).toBe(false);
		}
	});

	it('closes the whole proposal', () => {
		const found = objects(z.toJSONSchema(proposalSchema, { io: 'input' }));
		expect(found.length).toBeGreaterThan(PROPOSAL_KINDS.length * 2);
		for (const [at, node] of found) expect(node.additionalProperties, at).toBe(false);
	});
});
