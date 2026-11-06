import { describe, expect, it } from 'vitest';
import { workoutDayKits } from '../../../../tests/fixtures/workout-day';
import { serverSplit } from '../../../../tests/fixtures/workout-sequences';
import { BODY_AREAS, SEVERITIES } from '../profile/catalog';
import type { BodyArea, Equipment, Severity } from '../profile/catalog';
import type { SubstitutionReason } from '../training/vocabulary';
import { createMutation, entityKey } from './mutations';
import type { Mutation, MutationInput, MutationOf, MutationType, PainAction } from './mutations';
import { project, replay } from './project';
import type { WorkoutInputs } from './project';
import type { CanonicalWorkout } from './protocol';
import { initialDevice } from './reducers/device';
import { strengthTable } from './reducers/tables';
import { slotAt } from './selectors';
import {
	END_WORKOUT_SEVERITIES,
	JUST_SWAP_REASON,
	QUICK_ACTIONS,
	effectsOf,
	painChoices,
	rankFor,
	unfinishedSets
} from './substitution';
import type { QuickAction } from './substitution';
import type { KitAlternative, LoggedSet, SlotView, StrengthKit, WorkoutView } from './types';

const DATE = '2026-11-06';
const BASE = workoutDayKits({ date: DATE }).strength;
const W = '00000000-0000-4000-8000-0000000000b1';
const idAt = (position: number) => BASE.exercises[position - 1]!.exercise.id;
const lineageAt = (position: number) => BASE.exercises[position - 1]?.plannedLineage ?? null;
const SQUAT = idAt(1);
const LEG_PRESS = idAt(2);
const RDL = idAt(3);
const PULL_UP = idAt(4);
const PLANK = idAt(5);

function option(id: string, equipment: Equipment[]): KitAlternative {
	return {
		exercise: {
			id,
			key: id,
			name: id.replaceAll('_', ' '),
			measure: 'reps',
			loadType: 'external',
			unilateral: false,
			pattern: 'squat',
			tags: [],
			restClass: 'compound',
			increment: 2.5
		},
		reasons: ['Same movement pattern'],
		equipment,
		lastTopSet: null
	};
}

/** Leg press's alternatives in the kit's (M3's) order, and RDL's gentler options per area. */
const LEG_PRESS_OPTIONS = [
	option('hack_squat', ['machines']),
	option('goblet_squat', ['dumbbells']),
	option('belt_squat', ['machines', 'cables']),
	option('air_squat', []),
	option('split_squat', ['dumbbells', 'bench'])
];
const BACK_FRIENDLY = [option('hip_thrust', ['barbell', 'bench']), option('back_extension', [])];
const HAMSTRING_FRIENDLY = [option('leg_curl', ['machines'])];

const KIT: StrengthKit = {
	...BASE,
	exercises: BASE.exercises.map((e) => {
		if (e.position === 2) {
			const exercise = { ...e.exercise, equipment: ['machines'] satisfies Equipment[] };
			return { ...e, exercise, alternatives: LEG_PRESS_OPTIONS };
		}
		if (e.position === 3) {
			return { ...e, gentler: { lower_back: BACK_FRIENDLY, hamstring: HAMSTRING_FRIENDLY } };
		}
		return e;
	})
};

let ids = 0;
const fresh = () => `fresh-${++ids}`;
const at = (second: number) => new Date(Date.UTC(2026, 10, 6, 18, 0, second)).toISOString();

function make<T extends MutationType>(
	type: T,
	input: Omit<MutationInput<T>, 'workoutId' | 'at'> & { second?: number }
): MutationOf<T> {
	const { second = 0, ...rest } = input;
	return createMutation(type, { workoutId: W, at: at(second), ...rest }, fresh);
}

const start = () =>
	make('workout.start', {
		entityId: W,
		payload: {
			kind: 'strength',
			title: KIT.title,
			sessionType: KIT.sessionType,
			discipline: KIT.discipline,
			plannedSessionId: KIT.plannedSessionId,
			plannedLineage: KIT.plannedLineage,
			programId: KIT.programId
		}
	});

const done = (fields: Partial<LoggedSet> = {}): LoggedSet => ({
	reps: 8,
	seconds: null,
	metres: null,
	weight: 100,
	assistance: null,
	unit: 'kg',
	rpe: 8,
	missedReps: 0,
	isWarmup: false,
	isExtra: false,
	...fields
});

const log = (id: string, position: number, setIndex: number, exerciseId = idAt(position)) =>
	make('set.log', {
		entityId: id,
		second: 10 * position + setIndex,
		payload: { position, plannedLineage: lineageAt(position), setIndex, exerciseId, ...done() }
	});

const skipSets = (position: number, sets: [string, number][], exerciseId = idAt(position)) =>
	make('exercise.skip', {
		second: 50,
		payload: {
			position,
			plannedLineage: lineageAt(position),
			exerciseId,
			unit: 'kg',
			sets: sets.map(([id, setIndex]) => ({ id, setIndex }))
		}
	});

const substitute = (
	id: string,
	position: number,
	from: string,
	to: string,
	reason: SubstitutionReason = 'equipment_unavailable'
) =>
	make('exercise.substitute', {
		entityId: id,
		second: 20,
		payload: {
			position,
			plannedLineage: lineageAt(position),
			fromExerciseId: from,
			toExerciseId: to,
			reason
		}
	});

const dislike = (id: string, position: number, from: string, to: string, note: string | null) =>
	make('exercise.dislike', {
		entityId: id,
		second: 25,
		payload: {
			position,
			plannedLineage: lineageAt(position),
			fromExerciseId: from,
			toExerciseId: to,
			note
		}
	});

function pain(
	id: string,
	position: number,
	action: PainAction,
	{
		area = null,
		severity = null,
		substitutionId = null
	}: { area?: BodyArea | null; severity?: Severity | null; substitutionId?: string | null } = {}
) {
	return make('pain.report', {
		entityId: id,
		second: 30,
		payload: {
			position,
			plannedLineage: lineageAt(position),
			exerciseId: idAt(position),
			area,
			severity,
			action,
			substitutionId,
			note: 'Sharp at the bottom'
		}
	});
}

function inputs(
	pending: readonly Mutation[],
	canonical: CanonicalWorkout | null = null
): WorkoutInputs {
	return { workoutId: W, kit: KIT, canonical, pending };
}

const view = (pending: readonly Mutation[], canonical: CanonicalWorkout | null = null) =>
	project(strengthTable, inputs(pending, canonical))!;
const serverModel = (mutations: readonly Mutation[]) =>
	replay(strengthTable, inputs(mutations)).rows!;
const slot = (v: WorkoutView, position: number) => slotAt(v, position)!;

/** The view with every pending flag cleared: what the rows say, whatever is still unsent. */
function settled(v: WorkoutView | null) {
	const clear = <R extends { pending: boolean }>(row: R): R => ({ ...row, pending: false });
	return (
		v && {
			...v,
			workout: clear(v.workout),
			slots: v.slots.map((s) => ({
				...s,
				substitution: s.substitution && clear(s.substitution),
				sets: s.sets.map(clear)
			}))
		}
	);
}

// ---- The rules ------------------------------------------------------------------------------

/** Slots an action can be taken on: planned, already swapped, added here, ad-hoc. */
function slots(): Record<string, SlotView> {
	const v = view([start(), substitute('swap', 2, LEG_PRESS, 'goblet_squat')]);
	const added: SlotView = {
		...slot(v, 1),
		position: 6,
		plannedLineage: null,
		kit: null,
		state: 'added'
	};
	return {
		planned: slot(v, 1),
		swapped: slot(v, 2),
		added,
		adhoc: { ...added, position: 1 }
	};
}

describe('the quick actions', () => {
	const ACTIONS = Object.keys(QUICK_ACTIONS) as QuickAction[];

	it('are the five the sheet offers, in its order, each ending in its own mutation', () => {
		expect(ACTIONS).toEqual([
			'machine_unavailable',
			'suggest_alternative',
			'dislike',
			'pain',
			'skip'
		]);
		expect(ACTIONS.map((a) => QUICK_ACTIONS[a].sends)).toEqual([
			'exercise.substitute',
			'exercise.substitute',
			'exercise.dislike',
			'pain.report',
			'exercise.skip'
		]);
		expect(ACTIONS.map((a) => QUICK_ACTIONS[a].reason)).toEqual([
			'equipment_unavailable',
			'owner_choice',
			'dislike',
			'pain',
			null
		]);
	});

	it('let only a confirmed dislike write a preference, and only a dislike of a planned exercise change the program', () => {
		for (const [name, target] of Object.entries(slots())) {
			for (const action of ACTIONS) {
				const effects = effectsOf(action, target);
				const where = `${action} on the ${name} slot`;
				expect(effects.writesPreference, where).toBe(action === 'dislike');
				expect(effects.needsConfirmation, where).toBe(action === 'dislike');
				expect(effects.changesProgram, where).toBe(action === 'dislike' && name === 'planned');
			}
			for (const action of ['machine_unavailable', 'pain'] as const) {
				expect(effectsOf(action, target)).toEqual({
					writesPreference: false,
					changesProgram: false,
					needsConfirmation: false
				});
			}
		}
	});
});

describe('rankFor', () => {
	const keys = (list: KitAlternative[]) => list.map((a) => a.exercise.id);
	const legPress = () => slot(view([start()]), 2);

	it("puts the alternatives that need none of the slot's equipment first when it is unavailable, each part in the kit's order", () => {
		// The planned leg press needs a machine, as its kit entry says.
		expect(keys(rankFor('equipment_unavailable', LEG_PRESS_OPTIONS, legPress()))).toEqual([
			'goblet_squat',
			'air_squat',
			'split_squat',
			'hack_squat',
			'belt_squat'
		]);
		// Swapped for the split squat, its alternative entry says it needs the dumbbells and the bench.
		const split = slot(
			view([start(), substitute('s', 2, LEG_PRESS, 'split_squat', 'owner_choice')]),
			2
		);
		expect(keys(rankFor('equipment_unavailable', LEG_PRESS_OPTIONS, split))).toEqual([
			'hack_squat',
			'belt_squat',
			'air_squat',
			'goblet_squat',
			'split_squat'
		]);
	});

	it("keeps the kit's ranking for every other reason or when the slot's needs are unknown, and never changes the kit's list", () => {
		const before = [...LEG_PRESS_OPTIONS];
		for (const reason of ['owner_choice', 'dislike', 'pain', 'situational'] as const) {
			expect(rankFor(reason, LEG_PRESS_OPTIONS, legPress()), reason).toEqual(LEG_PRESS_OPTIONS);
		}
		// A kit entry that does not say (the squat's), an added exercise.
		for (const unknown of [slot(view([start()]), 1), slots().added!]) {
			expect(keys(rankFor('equipment_unavailable', LEG_PRESS_OPTIONS, unknown))).toEqual(
				keys(before)
			);
		}
		expect(LEG_PRESS_OPTIONS).toEqual(before);
	});
});

describe('painChoices', () => {
	const rdl = () => slot(view([start()]), 3);
	const kinds = (choices: ReturnType<typeof painChoices>) =>
		choices.map((c) => (c.action === 'substituted' ? c.option.exercise.id : c.action));

	it("puts Stop first, then only the kit's gentler options for the area", () => {
		expect(kinds(painChoices(rdl(), 'lower_back', 'moderate'))).toEqual([
			'stopped',
			'hip_thrust',
			'back_extension'
		]);
		expect(kinds(painChoices(rdl(), 'hamstring', 'mild'))).toEqual(['stopped', 'leg_curl']);
	});

	it('adds End the workout here only when the pain is severe', () => {
		expect(END_WORKOUT_SEVERITIES).toEqual(['severe']);
		for (const severity of [null, ...SEVERITIES]) {
			const choices = kinds(painChoices(rdl(), 'lower_back', severity));
			expect(choices[0], String(severity)).toBe('stopped');
			expect(choices.at(-1) === 'ended_workout', String(severity)).toBe(severity === 'severe');
		}
		expect(kinds(painChoices(rdl(), 'lower_back', 'severe'))).toEqual([
			'stopped',
			'hip_thrust',
			'back_extension',
			'ended_workout'
		]);
	});

	it('still offers Stop when no option fits: no area chosen, an area with none, no kit', () => {
		expect(kinds(painChoices(rdl(), null, 'moderate'))).toEqual(['stopped']);
		for (const area of BODY_AREAS.filter((a) => a !== 'lower_back' && a !== 'hamstring')) {
			expect(kinds(painChoices(rdl(), area, 'mild')), area).toEqual(['stopped']);
		}
		const added = { ...rdl(), kit: null };
		expect(kinds(painChoices(added, 'knee', 'severe'))).toEqual(['stopped', 'ended_workout']);
	});

	it('never offers the exercise being performed as the gentler option', () => {
		const swapped = slot(
			view([start(), substitute('swap', 3, RDL, 'hip_thrust', 'owner_choice')]),
			3
		);
		expect(kinds(painChoices(swapped, 'lower_back', null))).toEqual(['stopped', 'back_extension']);
	});
});

describe('unfinishedSets', () => {
	it('lists the planned sets with no row yet, logged or skipped, and none for an added exercise', () => {
		expect(unfinishedSets(slot(view([start()]), 1))).toEqual([1, 2, 3, 4]);
		const v = view([start(), log('a', 1, 1), log('b', 1, 3), skipSets(2, [['c', 2]])]);
		expect(unfinishedSets(slot(v, 1))).toEqual([2, 4]);
		expect(unfinishedSets(slot(v, 2))).toEqual([1, 3]);
		expect(unfinishedSets({ kit: null, sets: [] })).toEqual([]);
	});
});

// ---- The structure reducers -----------------------------------------------------------------

describe('the structure reducers', () => {
	it('skip the sets an exercise.skip names, and the slot reads Skipped when none of it was done', () => {
		const skip = skipSets(4, [
			['p1', 1],
			['p2', 2],
			['p3', 3]
		]);
		const v = view([start(), skip]);
		expect(slot(v, 4).state).toBe('skipped');
		expect(slot(v, 4).sets.map((s) => [s.id, s.setIndex, s.isSkipped, s.pending])).toEqual([
			['p1', 1, true, true],
			['p2', 2, true, true],
			['p3', 3, true, true]
		]);
		expect(slot(v, 4).sets[0]).toMatchObject({
			exerciseId: PULL_UP,
			plannedLineage: lineageAt(4),
			reps: null,
			weight: null,
			rpe: null,
			unit: 'kg',
			performedAt: skip.at,
			deletedAt: null
		});
		expect(unfinishedSets(slot(v, 4))).toEqual([]);

		// Synced, it reads the same from the server's rows.
		expect(settled(view([], serverModel([start(), skip])))).toStrictEqual(settled(v));
	});

	it('keep what was done when the rest of an exercise is skipped: nothing is left, and it does not read Skipped', () => {
		const v = view([
			start(),
			log('a', 1, 1),
			log('b', 1, 2),
			skipSets(1, [
				['c', 3],
				['d', 4]
			])
		]);
		expect(slot(v, 1).state).toBe('planned');
		expect(slot(v, 1).sets.map((s) => s.isSkipped)).toEqual([false, false, true, true]);
		expect(unfinishedSets(slot(v, 1))).toEqual([]);
		// Skipping every planned set one by one is the same as skipping the exercise.
		const oneByOne = [1, 2, 3].map((i) =>
			make('set.skip', {
				entityId: `k${i}`,
				payload: {
					position: 5,
					plannedLineage: lineageAt(5),
					setIndex: i,
					exerciseId: PLANK,
					unit: 'kg'
				}
			})
		);
		expect(slot(view([start(), ...oneByOne.slice(0, 2)]), 5).state).toBe('planned');
		expect(slot(view([start(), ...oneByOne]), 5).state).toBe('skipped');
	});

	it('swap a slot for today: the substitute is performed, the plan kept, and it reads Swapped, pending until synced', () => {
		const swap = substitute('sub1', 2, LEG_PRESS, 'hack_squat');
		const v = view([start(), swap]);
		expect(slot(v, 2)).toMatchObject({
			exerciseId: 'hack_squat',
			state: 'swapped',
			kit: { exercise: { id: LEG_PRESS } },
			substitution: {
				id: 'sub1',
				position: 2,
				plannedLineage: lineageAt(2),
				fromExerciseId: LEG_PRESS,
				toExerciseId: 'hack_squat',
				reason: 'equipment_unavailable',
				deletedAt: null,
				pending: true
			}
		});
		expect(v.exercises.hack_squat).toMatchObject({ name: 'hack squat' });
		const synced = view([], serverModel([start(), swap]));
		expect(slot(synced, 2).substitution!.pending).toBe(false);
		expect(settled(synced)).toStrictEqual(settled(v));
		// Every other slot is as planned.
		expect(v.slots.filter((s) => s.position !== 2).map((s) => s.state)).toEqual(
			Array(4).fill('planned')
		);
	});

	it('follow a slot through several swaps from what the rows hold, whatever order they come in', () => {
		const chain = [
			substitute('zz', 2, LEG_PRESS, 'hack_squat'),
			substitute('aa', 2, 'hack_squat', 'goblet_squat', 'owner_choice')
		];
		const rows = serverModel([start(), ...chain]);
		const reversed = { ...rows, substitutions: [...rows.substitutions].reverse() };
		for (const canonical of [rows, reversed]) {
			expect(slot(view([], canonical), 2)).toMatchObject({
				exerciseId: 'goblet_squat',
				state: 'swapped',
				substitution: { id: 'aa', reason: 'owner_choice', pending: false }
			});
		}
		// Another device's workout before its kit arrives: followed from the exercise no swap led to.
		const elsewhere = serverModel([start(), ...chain, log('g1', 2, 1, 'goblet_squat')]);
		const noKit = project(strengthTable, {
			workoutId: W,
			kit: null,
			canonical: elsewhere,
			pending: []
		});
		expect(slot(noKit!, 2)).toMatchObject({
			exerciseId: 'goblet_squat',
			kit: null,
			state: 'swapped',
			substitution: { id: 'aa' }
		});
		// Swapped back to the planned exercise, the slot reads as planned.
		const back = substitute('back', 2, 'goblet_squat', LEG_PRESS, 'owner_choice');
		expect(slot(view([back], reversed), 2)).toMatchObject({
			exerciseId: LEG_PRESS,
			state: 'planned',
			substitution: null
		});
		// So does an added exercise, which has no kit to compare with.
		const keg = { position: 6, exercise: option('keg_carry', []).exercise, addedAt: at(60) };
		const device = { ...initialDevice(), added: [keg] };
		const added = (pending: Mutation[]) =>
			slot(project(strengthTable, { ...inputs(pending), device })!, 6);
		const away = substitute('away', 6, 'keg_carry', 'farmer_carry', 'owner_choice');
		const home = substitute('home', 6, 'farmer_carry', 'keg_carry', 'owner_choice');
		expect(added([start(), away])).toMatchObject({ exerciseId: 'farmer_carry', state: 'swapped' });
		expect(added([start(), away, home])).toMatchObject({
			exerciseId: 'keg_carry',
			state: 'added',
			substitution: null
		});
	});

	it("leave a slot as planned when the server's rows hold its substitution or pain report only as a tombstone", () => {
		const rows = serverModel([
			start(),
			substitute('sub1', 2, LEG_PRESS, 'hack_squat'),
			pain('r1', 4, 'stopped')
		]);
		const gone = '2026-11-06T18:30:00.000Z';
		const tombstones = {
			...rows,
			substitutions: rows.substitutions.map((s) => ({ ...s, deletedAt: gone })),
			pain: rows.pain.map((r) => ({ ...r, deletedAt: gone }))
		};
		expect(slot(view([], rows), 2).state).toBe('swapped');
		expect(slot(view([], rows), 4).state).toBe('stopped');
		expect(slot(view([], tombstones), 2)).toMatchObject({
			exerciseId: LEG_PRESS,
			state: 'planned',
			substitution: null
		});
		expect(slot(view([], tombstones), 4).state).toBe('planned');
		// A replayed create of a tombstoned row stays deleted.
		const replayed = substitute('sub1', 2, LEG_PRESS, 'hack_squat');
		expect(slot(view([replayed], tombstones), 2).state).toBe('planned');
	});

	it('settle two devices that swapped the same exercise offline on one swap, whatever order the rows come in', () => {
		const rows = serverModel([
			start(),
			substitute('phone', 2, LEG_PRESS, 'hack_squat'),
			substitute('laptop', 2, LEG_PRESS, 'goblet_squat', 'owner_choice')
		]);
		for (const substitutions of [rows.substitutions, [...rows.substitutions].reverse()]) {
			expect(slot(view([], { ...rows, substitutions }), 2)).toMatchObject({
				exerciseId: 'goblet_squat',
				substitution: { id: 'laptop' }
			});
		}
	});

	it("read a confirmed dislike as won't be prescribed, its substitution's reason dislike and its note left to the preference", () => {
		const v = view([start(), dislike('d1', 3, RDL, 'hip_thrust', 'Hurts my grip')]);
		expect(slot(v, 3)).toMatchObject({
			exerciseId: 'hip_thrust',
			state: 'wont_prescribe',
			substitution: { id: 'd1', fromExerciseId: RDL, toExerciseId: 'hip_thrust', reason: 'dislike' }
		});
		const rows = serverModel([start(), dislike('d1', 3, RDL, 'hip_thrust', 'Hurts my grip')]);
		expect(rows.substitutions).toEqual([
			{
				id: 'd1',
				position: 3,
				plannedLineage: lineageAt(3),
				fromExerciseId: RDL,
				toExerciseId: 'hip_thrust',
				reason: 'dislike',
				deletedAt: null
			}
		]);
		// A later swap of the substitute reads by the latest substitution.
		const again = substitute('s2', 3, 'hip_thrust', 'back_extension');
		expect(slot(view([again], rows), 3)).toMatchObject({
			exerciseId: 'back_extension',
			state: 'swapped'
		});
	});

	it("read 'Just swap it today', a refused dislike re-sent as today's substitution, as Swapped", () => {
		const swap = substitute('d1', 3, RDL, 'hip_thrust', JUST_SWAP_REASON);
		const v = view([start(), swap]);
		expect(slot(v, 3)).toMatchObject({
			exerciseId: 'hip_thrust',
			state: 'swapped',
			substitution: { id: 'd1', reason: JUST_SWAP_REASON }
		});
		expect(settled(view([], serverModel([start(), swap])))).toStrictEqual(settled(v));
	});

	it('record a pain report, and read the slot Stopped when it stopped the exercise or the workout', () => {
		const report = pain('r1', 4, 'stopped', { area: 'shoulder', severity: 'moderate' });
		const rows = serverModel([start(), log('a', 4, 1), report]);
		expect(rows.pain).toEqual([
			{
				id: 'r1',
				position: 4,
				plannedLineage: lineageAt(4),
				exerciseId: PULL_UP,
				area: 'shoulder',
				severity: 'moderate',
				action: 'stopped',
				substitutionId: null,
				note: 'Sharp at the bottom',
				reportedAt: report.at,
				deletedAt: null
			}
		]);
		expect(slot(view([], rows), 4).state).toBe('stopped');
		// Stop also skips what is left; the slot still reads Stopped, not Skipped.
		const stop = skipSets(4, [
			['p2', 2],
			['p3', 3]
		]);
		expect(slot(view([stop], rows), 4).state).toBe('stopped');
		expect(
			slot(
				view([
					start(),
					report,
					skipSets(4, [
						['q1', 1],
						['q2', 2],
						['q3', 3]
					])
				]),
				4
			).state
		).toBe('stopped');
		expect(
			slot(view([start(), pain('r2', 3, 'ended_workout', { severity: 'severe' })]), 3).state
		).toBe('stopped');
	});

	it('read a gentler option chosen for pain as Swapped, with reason pain', () => {
		const swap = substitute('g1', 3, RDL, 'back_extension', 'pain');
		const report = pain('r1', 3, 'substituted', { area: 'lower_back', substitutionId: 'g1' });
		const v = view([start(), swap, report]);
		expect(slot(v, 3)).toMatchObject({
			exerciseId: 'back_extension',
			state: 'swapped',
			substitution: { id: 'g1', reason: 'pain' }
		});
	});

	it('change nothing on a replay of any structure mutation, and wait for the workout without throwing', () => {
		const structure = [
			skipSets(5, [
				['p1', 1],
				['p2', 2],
				['p3', 3]
			]),
			substitute('sub1', 2, LEG_PRESS, 'hack_squat'),
			dislike('d1', 3, RDL, 'hip_thrust', null),
			pain('r1', 4, 'stopped')
		];
		const once = serverModel([start(), ...structure]);
		expect(serverModel([start(), ...structure, ...structure])).toStrictEqual(once);
		expect(view([start(), ...structure], once)).toStrictEqual(view([start(), ...structure]));
		// A replayed skip never revives a deleted set.
		const del = make('set.delete', { entityId: 'p1', second: 60, payload: {} });
		const deleted = serverModel([start(), structure[0]!, del]);
		expect(deleted.sets.find((s) => s.id === 'p1')!.deletedAt).toBe(del.at);
		expect(serverModel([start(), structure[0]!, del, structure[0]!])).toStrictEqual(deleted);
		// Before its workout.start, nothing is created.
		for (const m of structure) expect(replay(strengthTable, inputs([m])).rows, m.type).toBeNull();
	});

	it('replay deterministically: every split between the server and the outbox, in any order the outbox may deliver, folds to one view', () => {
		const M: Mutation[] = [
			start(),
			log('a1', 1, 1),
			substitute('sub1', 2, LEG_PRESS, 'hack_squat'),
			log('a2', 2, 1, 'hack_squat'),
			substitute('sub2', 2, 'hack_squat', 'goblet_squat', 'owner_choice'),
			log('a3', 2, 2, 'goblet_squat'),
			dislike('dis1', 3, RDL, 'hip_thrust', 'Grip gives out'),
			log('a4', 3, 1, 'hip_thrust'),
			log('a5', 4, 1),
			pain('pain1', 4, 'stopped', { area: 'shoulder', severity: 'moderate' }),
			skipSets(4, [
				['s42', 2],
				['s43', 3]
			]),
			substitute('sub3', 5, PLANK, 'back_extension', 'pain'),
			pain('pain2', 5, 'substituted', { area: 'lower_back', substitutionId: 'sub3' }),
			skipSets(1, [
				['s12', 2],
				['s13', 3],
				['s14', 4]
			]),
			make('workout.finish', { second: 90, payload: { sessionRpe: 8 } })
		];
		const fold = settled(view(M));
		expect(fold!.slots.map((s) => [s.exerciseId, s.state])).toEqual([
			[SQUAT, 'planned'],
			['goblet_squat', 'swapped'],
			['hip_thrust', 'wont_prescribe'],
			[PULL_UP, 'stopped'],
			['back_extension', 'swapped']
		]);
		let checked = 0;
		for (let seed = 1; seed <= 60; seed++) {
			const { k, applied, random } = serverSplit(seed, M);
			const server = replay(strengthTable, inputs(applied)).rows;
			const canonical = server && {
				...server,
				sets: random.shuffle(server.sets),
				substitutions: random.shuffle(server.substitutions),
				pain: random.shuffle(server.pain)
			};
			for (let i = 0; i <= k + 1; i++) {
				const pending = M.slice(i);
				const v = view(pending, canonical);
				expect(settled(v), `seed ${seed}, k ${k}, i ${i}`).toStrictEqual(fold);
				const touched = new Set(pending.map(entityKey));
				for (const s of v.slots.filter((s) => s.substitution)) {
					expect(s.substitution!.pending).toBe(touched.has(`slot:${W}:${s.position}`));
				}
				checked++;
			}
		}
		expect(checked).toBeGreaterThan(200);
	});
});
