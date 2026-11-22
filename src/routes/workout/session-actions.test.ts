import { describe, expect, it } from 'vitest';
import { workoutDayKits } from '../../../tests/fixtures/workout-day';
import { createMutation } from '#lib/domain/workout/mutations.ts';
import { applyLocal, replay, viewOf } from '#lib/domain/workout/project.ts';
import type { WorkoutState } from '#lib/domain/workout/project.ts';
import { otherTable } from '#lib/domain/workout/reducers/other.ts';
import { runTable } from '#lib/domain/workout/reducers/run.ts';
import { sessionPain } from './session-actions.ts';

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
