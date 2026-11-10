import { describe, expect, it } from 'vitest';
import { workoutDayKits } from '../../../tests/fixtures/workout-day';
import type {
	KitAlternative,
	KitExerciseMeta,
	LoggedSet,
	Mutation,
	MutationOf,
	StrengthKit,
	WorkoutView
} from '#lib/domain/workout/index.ts';
import { createMutation } from '#lib/domain/workout/mutations.ts';
import { applyLocal, applyMutation, replay, viewOf } from '#lib/domain/workout/project.ts';
import type { WorkoutState } from '#lib/domain/workout/project.ts';
import { strengthTable } from '#lib/domain/workout/reducers/tables.ts';
import { slotAt } from '#lib/domain/workout/selectors.ts';
import {
	alternativesFor,
	correctedReport,
	dislike,
	replaceWithOwn,
	reportPain,
	skipExercise,
	substitute
} from './actions.ts';
import { logSet } from './log.ts';

const W = '00000000-0000-4000-8000-0000000000f1';
const AT = '2026-11-06T18:00:00.000Z';
const BASE = workoutDayKits({ date: '2026-11-06' }).strength;
const LEG_PRESS = 2;
const PLANK = 5;

const meta = (key: string, name: string): KitExerciseMeta => ({
	...BASE.exercises[LEG_PRESS - 1]!.exercise,
	id: key,
	key,
	name
});
const option = (key: string, name: string, equipment: KitAlternative['equipment']) => ({
	exercise: { ...meta(key, name), equipment },
	reasons: ['Same movement: squat'],
	equipment,
	lastTopSet: null
});
// M3's ranking: hack squat first, then the goblet squat, which needs no machine.
const HACK = option('hack_squat', 'Hack squat', ['machines']);
const GOBLET = option('goblet_squat', 'Goblet squat', ['dumbbells']);
const KIT: StrengthKit = {
	...BASE,
	exercises: BASE.exercises.map((e) =>
		e.position === LEG_PRESS
			? {
					...e,
					exercise: { ...e.exercise, equipment: ['machines'] },
					alternatives: [HACK, GOBLET],
					gentler: { knee: [GOBLET] }
				}
			: e
	)
};

function started(): WorkoutState {
	const start = createMutation('workout.start', {
		workoutId: W,
		at: AT,
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
	return replay(strengthTable, { workoutId: W, kit: KIT, canonical: null, pending: [start] });
}

const viewOfState = (state: WorkoutState) => viewOf(strengthTable, state) as WorkoutView;

/** Applies what an action dispatches, as the store does. */
function apply(
	state: WorkoutState,
	mutation: Mutation,
	followUps: Parameters<typeof applyLocal>[2][] = []
) {
	let next = applyMutation(strengthTable, state, mutation);
	for (const action of followUps) next = applyLocal(strengthTable, next, action);
	return next;
}

const SET: LoggedSet = {
	reps: 10,
	seconds: null,
	metres: null,
	weight: 120,
	assistance: null,
	unit: 'kg',
	rpe: 7,
	missedReps: 0,
	isWarmup: false,
	isExtra: false
};

describe('alternativesFor', () => {
	it('puts the alternatives that need none of the slot’s equipment first when the machine is taken', () => {
		const slot = slotAt(viewOfState(started()), LEG_PRESS)!;
		expect(alternativesFor(slot, 'machine_unavailable').map((a) => a.exercise.id)).toEqual([
			'goblet_squat',
			'hack_squat'
		]);
		expect(alternativesFor(slot, 'suggest_alternative').map((a) => a.exercise.id)).toEqual([
			'hack_squat',
			'goblet_squat'
		]);
	});

	it('never offers the exercise the slot performs now, and nothing for one with no kit entry', () => {
		const state = started();
		const swapped = apply(
			state,
			substitute(viewOfState(state), LEG_PRESS, 'hack_squat', 'suggest_alternative', AT)
		);
		const slot = slotAt(viewOfState(swapped), LEG_PRESS)!;
		expect(alternativesFor(slot, 'dislike').map((a) => a.exercise.id)).toEqual(['goblet_squat']);
		expect(alternativesFor({ ...slot, kit: null }, 'dislike')).toEqual([]);
	});
});

describe('substitute', () => {
	it('swaps the exercise performed for this session only, under its own client id', () => {
		const state = started();
		const m = substitute(viewOfState(state), LEG_PRESS, 'goblet_squat', 'machine_unavailable', AT);
		expect(m.type).toBe('exercise.substitute');
		expect(m.id).toBe(m.entityId);
		expect(m).toMatchObject({ workoutId: W, at: AT });
		expect(m.payload).toEqual({
			position: LEG_PRESS,
			plannedLineage: KIT.exercises[LEG_PRESS - 1]!.plannedLineage,
			fromExerciseId: 'leg_press',
			toExerciseId: 'goblet_squat',
			reason: 'equipment_unavailable'
		});
		const slot = slotAt(viewOfState(apply(state, m)), LEG_PRESS)!;
		expect(slot).toMatchObject({ exerciseId: 'goblet_squat', state: 'swapped' });
	});

	it('records the owner’s choice for Suggest an alternative, from the exercise performed now', () => {
		const state = started();
		const first = substitute(
			viewOfState(state),
			LEG_PRESS,
			'hack_squat',
			'suggest_alternative',
			AT
		);
		const after = apply(state, first);
		const second = substitute(
			viewOfState(after),
			LEG_PRESS,
			'goblet_squat',
			'suggest_alternative',
			AT
		);
		expect(second.payload).toMatchObject({
			fromExerciseId: 'hack_squat',
			toExerciseId: 'goblet_squat',
			reason: 'owner_choice'
		});
		expect(slotAt(viewOfState(apply(after, second)), LEG_PRESS)!.exerciseId).toBe('goblet_squat');
	});
});

describe('replaceWithOwn', () => {
	const SANDBAG = {
		name: 'Sandbag shouldering',
		aliases: [],
		pattern: 'hinge',
		primaryMuscles: ['glutes', 'hamstrings'],
		secondaryMuscles: [],
		equipment: [],
		substitutionGroup: null,
		skillLevel: 'beginner',
		repMin: null,
		repMax: null,
		defaultSeconds: null,
		unilateral: false,
		measure: 'reps',
		loadType: 'external',
		tags: [],
		disciplines: []
	} as const;

	it('creates the exercise under its own client id, then swaps to it as the owner’s choice', () => {
		const state = started();
		const [created, swap] = replaceWithOwn(viewOfState(state), LEG_PRESS, SANDBAG, AT);
		expect(created).toMatchObject({ type: 'exercise.create', workoutId: W, at: AT });
		expect(created.id).toBe(created.entityId);
		expect(created.payload).toEqual(SANDBAG);
		expect(swap.type).toBe('exercise.substitute');
		expect(swap.payload).toEqual({
			position: LEG_PRESS,
			plannedLineage: KIT.exercises[LEG_PRESS - 1]!.plannedLineage,
			fromExerciseId: 'leg_press',
			toExerciseId: created.entityId,
			reason: 'owner_choice'
		});
	});

	it('names the new exercise at once, so its sets log on it before anything syncs', () => {
		let state = started();
		const [created, swap] = replaceWithOwn(viewOfState(state), LEG_PRESS, SANDBAG, AT);
		state = apply(apply(state, created), swap);
		const view = viewOfState(state);
		expect(slotAt(view, LEG_PRESS)).toMatchObject({
			exerciseId: created.entityId,
			state: 'swapped'
		});
		expect(view.exercises[created.entityId]).toEqual({
			name: 'Sandbag shouldering',
			measure: 'reps',
			loadType: 'external',
			unilateral: false
		});
		const { mutation } = logSet(view, LEG_PRESS, 1, { ...SET, weight: 40 }, AT);
		expect(mutation.payload).toMatchObject({ exerciseId: created.entityId, weight: 40 });
	});
});

describe('dislike', () => {
	it('sends one exercise.dislike, which reads Won’t be prescribed again', () => {
		const state = started();
		const m = dislike(
			viewOfState(state),
			LEG_PRESS,
			'hack_squat',
			AT
		) as MutationOf<'exercise.dislike'>;
		expect(m.type).toBe('exercise.dislike');
		expect(m.id).toBe(m.entityId);
		expect(m.payload).toEqual({
			position: LEG_PRESS,
			plannedLineage: KIT.exercises[LEG_PRESS - 1]!.plannedLineage,
			fromExerciseId: 'leg_press',
			toExerciseId: 'hack_squat',
			note: null
		});
		const slot = slotAt(viewOfState(apply(state, m)), LEG_PRESS)!;
		expect(slot).toMatchObject({ exerciseId: 'hack_squat', state: 'wont_prescribe' });
	});
});

describe('skipExercise', () => {
	const ids = () => {
		let n = 0;
		return () => `00000000-0000-4000-8000-00000000a${String(++n).padStart(3, '0')}`;
	};

	it('skips each planned set not done yet and moves on to the next exercise', () => {
		let state = started();
		const logged = logSet(viewOfState(state), LEG_PRESS, 1, SET, AT);
		state = apply(state, logged.mutation, logged.followUps);
		const { mutation, followUps } = skipExercise(viewOfState(state), LEG_PRESS, AT, ids());
		expect(mutation.type).toBe('exercise.skip');
		expect(mutation.payload).toEqual({
			position: LEG_PRESS,
			plannedLineage: KIT.exercises[LEG_PRESS - 1]!.plannedLineage,
			exerciseId: 'leg_press',
			unit: 'kg',
			sets: [
				{ id: '00000000-0000-4000-8000-00000000a001', setIndex: 2 },
				{ id: '00000000-0000-4000-8000-00000000a002', setIndex: 3 }
			]
		});
		expect(followUps).toEqual([{ type: 'goTo', workoutId: W, position: LEG_PRESS + 1 }]);
		const view = viewOfState(apply(state, mutation, followUps));
		expect(view.device.position).toBe(LEG_PRESS + 1);
		expect(slotAt(view, LEG_PRESS)!.sets.map((s) => s.isSkipped)).toEqual([false, true, true]);
	});

	it('reads Skipped when nothing was done, and from the last exercise goes back to one left', () => {
		const state = started();
		const { mutation, followUps } = skipExercise(viewOfState(state), PLANK, AT, ids());
		expect(followUps).toEqual([{ type: 'goTo', workoutId: W, position: 1 }]);
		expect(slotAt(viewOfState(apply(state, mutation)), PLANK)!.state).toBe('skipped');
	});

	it('moves nowhere once nothing else is left to do', () => {
		let state = started();
		for (const slot of KIT.exercises) {
			if (slot.position === LEG_PRESS) continue;
			state = apply(state, skipExercise(viewOfState(state), slot.position, AT).mutation);
		}
		expect(skipExercise(viewOfState(state), LEG_PRESS, AT).followUps).toEqual([]);
	});
});

describe('reportPain', () => {
	const ids = () => {
		let n = 0;
		return () => `00000000-0000-4000-8000-00000000b${String(++n).padStart(3, '0')}`;
	};
	const DETAILS = { area: 'knee', severity: 'moderate', note: '  Sore at the bottom  ' } as const;
	const NONE = { area: null, severity: null, note: '   ' };

	/** Every mutation and follow-up of a report, applied as the store does. */
	function applied(state: WorkoutState, sent: ReturnType<typeof reportPain>) {
		let next = state;
		for (const m of sent.mutations) next = applyMutation(strengthTable, next, m);
		for (const action of sent.followUps) next = applyLocal(strengthTable, next, action);
		return viewOfState(next);
	}

	it('Stop: skips what is left, then reports it stopped with the details; the slot reads Stopped', () => {
		const state = started();
		const sent = reportPain(
			viewOfState(state),
			LEG_PRESS,
			{ action: 'stopped' },
			DETAILS,
			AT,
			ids()
		);
		expect(sent.mutations.map((m) => m.type)).toEqual(['exercise.skip', 'pain.report']);
		const report = sent.mutations[1] as MutationOf<'pain.report'>;
		expect(report.id).toBe(report.entityId);
		expect(report).toMatchObject({ workoutId: W, at: AT });
		expect(report.payload).toEqual({
			position: LEG_PRESS,
			plannedLineage: KIT.exercises[LEG_PRESS - 1]!.plannedLineage,
			exerciseId: 'leg_press',
			area: 'knee',
			severity: 'moderate',
			note: 'Sore at the bottom',
			action: 'stopped',
			substitutionId: null
		});
		expect(sent.followUps).toEqual([{ type: 'goTo', workoutId: W, position: LEG_PRESS + 1 }]);
		const view = applied(state, sent);
		expect(slotAt(view, LEG_PRESS)!.state).toBe('stopped');
		expect(slotAt(view, LEG_PRESS)!.sets.every((s) => s.isSkipped)).toBe(true);
		expect(view.device.position).toBe(LEG_PRESS + 1);
	});

	it('a gentler option: today’s swap with reason pain, and the report names it', () => {
		const state = started();
		const sent = reportPain(
			viewOfState(state),
			LEG_PRESS,
			{ action: 'substituted', option: GOBLET },
			NONE,
			AT
		);
		const [swap, report] = sent.mutations as [
			MutationOf<'exercise.substitute'>,
			MutationOf<'pain.report'>
		];
		expect(swap.type).toBe('exercise.substitute');
		expect(swap.payload).toMatchObject({
			fromExerciseId: 'leg_press',
			toExerciseId: 'goblet_squat',
			reason: 'pain'
		});
		expect(report.payload).toMatchObject({
			action: 'substituted',
			substitutionId: swap.entityId,
			area: null,
			severity: null,
			note: null
		});
		expect(sent.followUps).toEqual([]);
		expect(slotAt(applied(state, sent), LEG_PRESS)).toMatchObject({
			exerciseId: 'goblet_squat',
			state: 'swapped'
		});
	});

	it('End the workout here: the report alone, and the slot reads Stopped', () => {
		const state = started();
		const sent = reportPain(
			viewOfState(state),
			LEG_PRESS,
			{ action: 'ended_workout' },
			{ ...DETAILS, severity: 'severe' },
			AT
		);
		expect(sent.mutations.map((m) => m.type)).toEqual(['pain.report']);
		expect(sent.mutations[0]!.payload).toMatchObject({
			action: 'ended_workout',
			severity: 'severe'
		});
		expect(sent.followUps).toEqual([]);
		expect(slotAt(applied(state, sent), LEG_PRESS)!.state).toBe('stopped');
	});
});

describe('correctedReport', () => {
	it('keeps the id and what was done, and takes the corrected details', () => {
		const state = started();
		const { mutations } = reportPain(
			viewOfState(state),
			LEG_PRESS,
			{ action: 'stopped' },
			{ area: null, severity: null, note: 'x'.repeat(600) },
			AT
		);
		const refused = mutations[1] as MutationOf<'pain.report'>;
		const next = correctedReport(refused, { area: 'knee', severity: 'mild', note: ' Better ' });
		expect(next).toEqual({
			...refused,
			payload: { ...refused.payload, area: 'knee', severity: 'mild', note: 'Better' }
		});
	});
});
