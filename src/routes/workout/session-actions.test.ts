import { describe, expect, it } from 'vitest';
import { workoutDayKits } from '../../../tests/fixtures/workout-day';
import { createMutation } from '#lib/domain/workout/mutations.ts';
import type { Mutation } from '#lib/domain/workout/index.ts';
import { applyLocal, replay, viewOf } from '#lib/domain/workout/project.ts';
import type { WorkoutState } from '#lib/domain/workout/project.ts';
import { otherTable } from '#lib/domain/workout/reducers/other.ts';
import { runTable } from '#lib/domain/workout/reducers/run.ts';
import { SWAP_BIKE } from '#lib/domain/workout/substitution.ts';
import { finishValues, noteOf } from './finish.ts';
import { bikeKit, bikeStart, runEnd, sessionPain, swapOptions } from './session-actions.ts';

const RUN = workoutDayKits({ date: '2026-11-06' }).run;
const OTHER = workoutDayKits({ date: '2026-11-06' }).other;
const W = '00000000-0000-4000-8000-0000000000e4';
const AT = '2026-11-06T18:00:00.000Z';
const DETAILS = { area: 'shin_calf', severity: 'moderate', note: '  sore shin  ' } as const;

function startedRun(): WorkoutState {
	const start = createMutation('workout.start', {
		workoutId: W,
		entityId: W,
		at: AT,
		payload: {
			kind: 'run',
			title: RUN.title,
			sessionType: RUN.sessionType,
			discipline: RUN.discipline,
			plannedSessionId: null,
			plannedLineage: null,
			programId: null
		}
	});
	return replay(runTable, { workoutId: W, kit: RUN, canonical: null, pending: [start] });
}

function startedOther(): WorkoutState {
	const start = createMutation('workout.start', {
		workoutId: W,
		entityId: W,
		at: AT,
		payload: {
			kind: 'other',
			title: OTHER.title,
			sessionType: OTHER.sessionType,
			discipline: OTHER.discipline,
			plannedSessionId: null,
			plannedLineage: null,
			programId: null
		}
	});
	return replay(otherTable, { workoutId: W, kit: OTHER, canonical: null, pending: [start] });
}

describe('sessionPain', () => {
	it('reports a run’s pain at the segment on screen, naming no exercise, with the note trimmed', () => {
		const state = applyLocal(runTable, startedRun(), { type: 'goTo', workoutId: W, position: 3 });
		const report = sessionPain(viewOf(runTable, state)!, DETAILS, AT);
		expect(report).toMatchObject({ type: 'pain.report', workoutId: W, at: AT });
		expect(report.id).toBe(report.entityId);
		expect(report.payload).toEqual({
			position: 3,
			plannedLineage: null,
			exerciseId: null,
			area: 'shin_calf',
			severity: 'moderate',
			note: 'sore shin',
			action: 'ended_workout',
			substitutionId: null
		});
	});

	it('reports a class’s pain at position 1, and sends a blank note as none', () => {
		const view = viewOf(otherTable, startedOther())!;
		const report = sessionPain(view, { ...DETAILS, note: '   ' }, AT);
		expect(report.payload).toEqual({
			position: 1,
			plannedLineage: null,
			exerciseId: null,
			area: 'shin_calf',
			severity: 'moderate',
			note: null,
			action: 'ended_workout',
			substitutionId: null
		});
	});
});

const NO_PINS = { plannedSessionId: null, plannedLineage: null, programId: null } as const;
const PINS = {
	plannedSessionId: RUN.plannedSessionId,
	plannedLineage: RUN.plannedLineage,
	programId: RUN.programId
} as const;
const BIKE = '00000000-0000-4000-8000-0000000000e5';
const MS = Date.parse(AT);

/** A run started with the given pins, as start.ts writes it. */
function runStarted(pins: typeof NO_PINS | typeof PINS, more: Mutation[] = []): WorkoutState {
	const start = createMutation('workout.start', {
		workoutId: W,
		entityId: W,
		at: AT,
		payload: {
			kind: 'run',
			title: RUN.title,
			sessionType: RUN.sessionType,
			discipline: RUN.discipline,
			...pins
		}
	});
	return replay(runTable, { workoutId: W, kit: RUN, canonical: null, pending: [start, ...more] });
}

const segment = (values: { distanceMetres: number | null; durationSeconds: number | null }) =>
	createMutation('run.segment', {
		workoutId: W,
		at: AT,
		payload: { position: 1, kind: 'warm_up', avgHr: null, rpe: null, ...values }
	});

describe('swapOptions', () => {
	it('offers the zone 2 bike for the minutes left, or the fallback when none are', () => {
		const view = viewOf(runTable, runStarted(NO_PINS))!;
		expect(swapOptions(view, null, 25)).toEqual([{ to: 'bike', minutes: 25 }]);
		expect(swapOptions(view, null, null)).toEqual([
			{ to: 'bike', minutes: SWAP_BIKE.fallbackMinutes }
		]);
	});

	it('offers nothing for a run without its kit', () => {
		const start = createMutation('workout.start', {
			workoutId: W,
			entityId: W,
			at: AT,
			payload: {
				kind: 'run',
				title: RUN.title,
				sessionType: RUN.sessionType,
				discipline: RUN.discipline,
				...NO_PINS
			}
		});
		const state = replay(runTable, { workoutId: W, kit: null, canonical: null, pending: [start] });
		expect(swapOptions(viewOf(runTable, state)!, null, 25)).toEqual([]);
	});

	it('offers a Muay Thai class its lighter format, and nothing once it is technique', () => {
		const view = viewOf(otherTable, startedOther())!;
		expect(swapOptions(view, 'class', null)).toEqual([{ to: 'lighter', kind: 'technical' }]);
		expect(swapOptions(view, 'technical', null)).toEqual([]);
	});
});

describe('runEnd', () => {
	it('abandons a run with nothing run, and pauses its stopwatch at the same moment', () => {
		const view = viewOf(runTable, runStarted(NO_PINS))!;
		const [end, pause] = runEnd(view, MS);
		expect(end).toMatchObject({
			type: 'workout.abandon',
			workoutId: W,
			at: AT,
			payload: {}
		});
		expect(pause).toEqual({ type: 'stopwatch.pause', workoutId: W, at: MS });
	});

	it('finishes a run with what was run, with the finish sheet’s starting values', () => {
		const view = viewOf(
			runTable,
			runStarted(NO_PINS, [segment({ distanceMetres: 1000, durationSeconds: 360 })])
		)!;
		const [end, pause] = runEnd(view, MS);
		const values = finishValues(view, MS);
		expect(end).toMatchObject({ type: 'workout.finish', workoutId: W, at: AT });
		expect(end.payload).toEqual({ ...values, notes: noteOf(values.notes) });
		expect(pause).toEqual({ type: 'stopwatch.pause', workoutId: W, at: MS });
	});

	it('finishes a run whose distance was logged without a segment', () => {
		const log = createMutation('run.log', {
			workoutId: W,
			at: AT,
			payload: { distanceMetres: 5000 }
		});
		const view = viewOf(runTable, runStarted(NO_PINS, [log]))!;
		expect(runEnd(view, MS)[0].type).toBe('workout.finish');
	});
});

describe('bikeStart', () => {
	it('starts a zone 2 bike pinned to the run’s planned session, with its kit and stopwatch', () => {
		const view = viewOf(runTable, runStarted(PINS))!;
		const [start, attach, watch] = bikeStart(view, RUN, 25, MS, () => BIKE);
		expect(start).toMatchObject({
			type: 'workout.start',
			id: BIKE,
			entityId: BIKE,
			workoutId: BIKE,
			at: AT,
			payload: {
				kind: 'other',
				title: 'Zone 2 bike',
				sessionType: 'conditioning',
				discipline: 'running',
				...PINS
			}
		});
		expect(attach).toEqual({ type: 'kit.attach', workoutId: BIKE, kit: bikeKit(view, RUN, 25) });
		expect(watch).toEqual({ type: 'stopwatch.start', workoutId: BIKE, at: MS });
	});

	it('keeps an unpinned run unplanned: no pin in the start or the kit, whatever the run kit names', () => {
		const view = viewOf(runTable, runStarted(NO_PINS))!;
		const [start] = bikeStart(view, RUN, 25, MS, () => BIKE);
		expect(start.payload).toMatchObject(NO_PINS);
		const kit = bikeKit(view, RUN, 25);
		expect(kit).toMatchObject(NO_PINS);
		expect(kit).not.toHaveProperty('run');
		expect(kit).toMatchObject({
			kind: 'other',
			title: 'Zone 2 bike',
			sessionType: 'conditioning',
			date: RUN.date,
			units: RUN.units,
			other: { kind: 'conditioning', durationMinutes: 25, targetRpe: null, metrics: [] }
		});
	});

	it('replays as a conditioning session on this device', () => {
		const view = viewOf(runTable, runStarted(PINS))!;
		const [start, attach, watch] = bikeStart(view, RUN, 25, MS, () => BIKE);
		let state = replay(otherTable, {
			workoutId: BIKE,
			kit: null,
			canonical: null,
			pending: [start]
		});
		state = applyLocal(otherTable, state, attach);
		state = applyLocal(otherTable, state, watch);
		const bike = viewOf(otherTable, state)!;
		expect(bike.workout.kind).toBe('other');
		expect(bike.kit).toMatchObject({ kind: 'other', other: { kind: 'conditioning' } });
	});
});
