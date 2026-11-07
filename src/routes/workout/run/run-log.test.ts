import { describe, expect, it } from 'vitest';
import { workoutDayKits } from '../../../../tests/fixtures/workout-day';
import { RECORD_LIMITS } from '#lib/domain/training/schemas.ts';
import { RUN_SEGMENT_KIND_LABEL } from '#lib/domain/training/vocabulary.ts';
import type { LocalAction, Mutation, RunKit } from '#lib/domain/workout/index.ts';
import { createMutation } from '#lib/domain/workout/mutations.ts';
import { applyLocal, applyMutation, replay, viewOf } from '#lib/domain/workout/project.ts';
import type { WorkoutState } from '#lib/domain/workout/project.ts';
import { runTable } from '#lib/domain/workout/reducers/tables.ts';
import {
	actualText,
	entryError,
	freeItem,
	HEART_RATE,
	nextFreePosition,
	paceOf,
	prefillOf,
	runFieldMutation,
	SEGMENT_WORDS,
	segmentActions,
	segmentItems,
	segmentTitle,
	targetText,
	totalsMutation,
	toStoredMetres,
	type SegmentItem,
	type SegmentValues
} from './run-log.ts';

const KIT = workoutDayKits({ date: '2026-11-06' }).run;
const AD_HOC: RunKit = { ...KIT, run: { segments: [] } };
const W = '00000000-0000-4000-8000-0000000000e1';
const AT = '2026-11-06T07:00:00.000Z';

function started(kit: RunKit = KIT): WorkoutState {
	const start = createMutation('workout.start', {
		workoutId: W,
		entityId: W,
		at: AT,
		payload: {
			kind: 'run',
			title: kit.title,
			sessionType: kit.sessionType,
			discipline: kit.discipline,
			plannedSessionId: null,
			plannedLineage: null,
			programId: null
		}
	});
	return replay(runTable, { workoutId: W, kit, canonical: null, pending: [start] });
}

const viewIn = (state: WorkoutState) => viewOf(runTable, state)!;

/** Applies what a dispatch carries, as the store does. */
const apply = (state: WorkoutState, actions: (Mutation | LocalAction)[]) =>
	actions.reduce(
		(s, a) =>
			'v' in a ? applyMutation(runTable, s, a) : applyLocal(runTable, s, a as LocalAction),
		state
	);

/** Logs the segment at `position` with `values` through segmentActions. */
function log(state: WorkoutState, position: number, values: SegmentValues, item?: SegmentItem) {
	const view = viewIn(state);
	const items = segmentItems(view);
	const at = item ?? items.find((i) => i.position === position)!;
	const actions = segmentActions(view, items, at, values, AT);
	return { state: apply(state, actions), actions };
}

const values = (distanceMetres: number | null, durationSeconds: number | null, avgHr = null) => ({
	distanceMetres,
	durationSeconds,
	avgHr
});

describe('the run view’s segments', () => {
	it('lists the planned run expanded: warm-up, six intervals with their recoveries, cool-down', () => {
		const items = segmentItems(viewIn(started()));
		expect(items.map(segmentTitle)).toEqual([
			'Warm-up',
			...Array.from({ length: 6 }, (_, i) => [
				`Interval ${i + 1} of 6`,
				`Recovery ${i + 1} of 6`
			]).flat(),
			'Cool-down'
		]);
		expect(items.map((i) => i.position)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
		expect(items.every((i) => i.logged === null)).toBe(true);
	});

	it('prefills from the target, a distance-only interval’s time from the middle of its pace range', () => {
		const [warmUp, interval, recovery] = segmentItems(viewIn(started()));
		expect(prefillOf(warmUp!)).toEqual(values(null, 600));
		// 400 m at 3:45–4:00 /km: 0.4 × 232.5 s = 93 s.
		expect(prefillOf(interval!)).toEqual(values(400, 93));
		expect(prefillOf(recovery!)).toEqual(values(null, 90));
	});

	it('says what a target asks for, and its pace in the owner’s unit', () => {
		const [warmUp, interval] = segmentItems(viewIn(started()));
		expect(targetText(warmUp!.target, 'km')).toBe('10:00 · Zone 2');
		expect(targetText(interval!.target, 'km')).toBe('400 m · 3:45–4:00 /km');
		expect(targetText(interval!.target, 'mi')).toBe('0.25 mi · 6:02–6:26 /mi');
		expect(targetText(null, 'km')).toBe('Your own segment');
	});

	it('works the pace out as typed, in min/km or min/mi, and only with both a distance and a time', () => {
		expect(paceOf(values(400, 92), 'km')).toBe('3:50 /km');
		expect(paceOf(values(1609.344, 480), 'mi')).toBe('8:00 /mi');
		expect(paceOf(values(400, 0), 'km')).toBeNull();
		expect(paceOf(values(null, 92), 'km')).toBeNull();
		expect(actualText({ distanceMetres: 5200, durationSeconds: 1560, avgHr: 151 }, 'km')).toBe(
			'5.2 km · 26:00 · 5:00 /km · 151 bpm'
		);
	});

	it('a first entry creates the segment, sends the totals, and moves to the next segment', () => {
		const { state, actions } = log(started(), 2, values(400, 92));
		const [segment, totals, move] = actions;
		expect(segment).toMatchObject({
			type: 'run.segment',
			payload: {
				position: 2,
				kind: 'interval',
				distanceMetres: 400,
				durationSeconds: 92,
				avgHr: null
			}
		});
		expect(segment!.id).toBe(segment!.entityId);
		expect(totals).toMatchObject({
			type: 'run.log',
			entityId: W,
			payload: { distanceMetres: 400, durationSeconds: 92, avgHr: null }
		});
		expect(move).toEqual({ type: 'goTo', workoutId: W, position: 3 });

		const view = viewIn(state);
		expect(view.run!.segments).toMatchObject([{ position: 2, paceSecondsPerKm: 230 }]);
		expect(view.device.position).toBe(3);
	});

	it('a later entry edits the same segment by its client id, with fresh ids, and stays put', () => {
		const first = log(started(), 2, values(400, 92));
		const id = first.actions[0]!.entityId;
		const second = log(first.state, 2, values(400, 88, null));
		const [edit, totals, ...rest] = second.actions;
		expect(edit).toMatchObject({
			type: 'run.segment',
			entityId: id,
			payload: { durationSeconds: 88 }
		});
		expect(edit!.id).not.toBe(id);
		expect(totals).toMatchObject({ type: 'run.log', payload: { durationSeconds: 88 } });
		expect(rest).toEqual([]);
		expect(viewIn(second.state).run!.segments).toHaveLength(1);
		expect(viewIn(second.state).run!.segments[0]).toMatchObject({ id, durationSeconds: 88 });
	});

	it('sends no run.log when the totals stay the same', () => {
		const first = log(started(), 1, values(2000, 600));
		const { actions } = log(first.state, 1, values(2000, 600));
		expect(actions.map((a) => a.type)).toEqual(['run.segment']);
	});

	it('a fixed segment’s totals: its corrected amounts in place of its own, or the first totals', () => {
		const first = log(started(), 1, values(2000, 600));
		const { state, actions } = log(first.state, 2, values(400, 90));
		const id = actions[0]!.entityId;
		expect(totalsMutation(viewIn(state), id, values(400, 85), AT)).toMatchObject({
			type: 'run.log',
			payload: { distanceMetres: 2400, durationSeconds: 685, avgHr: null }
		});
		expect(totalsMutation(viewIn(state), id, values(400, 90), AT)).toBeNull();
		// A segment queued without its totals (another tab's, refused): none yet, so they go.
		const lone = viewIn(apply(started(), [actions[0]!]));
		expect(totalsMutation(lone, id, values(400, 90), AT)).toMatchObject({
			payload: { distanceMetres: 400, durationSeconds: 90 }
		});
	});

	it('totals the run over what was run: time-weighted heart rate, none counted as 0', () => {
		let state = started();
		state = log(state, 1, { distanceMetres: 2000, durationSeconds: 600, avgHr: 130 }).state;
		state = log(state, 2, values(400, 90)).state;
		state = log(state, 3, { distanceMetres: null, durationSeconds: 90, avgHr: 160 }).state;
		expect(viewIn(state).run).toMatchObject({
			distanceMetres: 2400,
			durationSeconds: 780,
			avgHr: 134,
			paceSecondsPerKm: 325
		});
	});

	it('an ad-hoc run logs free segments at the next position', () => {
		let state = started(AD_HOC);
		expect(segmentItems(viewIn(state))).toEqual([]);
		expect(nextFreePosition([])).toBe(1);
		state = log(state, 1, values(3000, 900), freeItem(1, 'easy')).state;
		const items = segmentItems(viewIn(state));
		expect(items).toMatchObject([{ position: 1, kind: 'easy', target: null }]);
		expect(nextFreePosition(items)).toBe(2);
		expect(segmentTitle(items[0]!)).toBe('Easy');
	});

	it('refuses an entry with neither a distance nor a time, or a heart rate off the scale', () => {
		expect(entryError(values(0, 0))).toBe('amount');
		expect(entryError(values(null, 60))).toBeNull();
		expect(entryError({ ...values(400, 0), avgHr: 19 })).toBe('heart-rate');
		expect(entryError({ ...values(400, 0), avgHr: 251 })).toBe('heart-rate');
		expect(entryError({ ...values(400, 0), avgHr: 150 })).toBeNull();
		// A run.log carrying only its heart rate needs no distance.
		expect(entryError({ avgHr: 150 })).toBeNull();
	});

	it('stores a distance typed in miles to the millimetre', () => {
		expect(toStoredMetres(0.248548, 'mi')).toBe(399.999);
		expect(toStoredMetres(3.1, 'mi')).toBe(4988.966);
		expect(toStoredMetres(0.4, 'km')).toBe(400);
	});

	it('sends the run’s effort and notes only when they change', () => {
		const view = viewIn(started());
		expect(runFieldMutation(view, { rpe: null }, AT)).toBeNull();
		const rpe = runFieldMutation(view, { rpe: 7 }, AT)!;
		expect(rpe).toMatchObject({ type: 'run.log', entityId: W, payload: { rpe: 7 } });
		const after = viewIn(applyMutation(runTable, started(), rpe));
		expect(runFieldMutation(after, { rpe: 7 }, AT)).toBeNull();
		expect(runFieldMutation(after, { notes: 'Windy' }, AT)).toMatchObject({
			payload: { notes: 'Windy' }
		});
	});

	it('keeps its words and bounds equal to the vocabulary’s and M3’s', () => {
		expect(SEGMENT_WORDS).toEqual(RUN_SEGMENT_KIND_LABEL);
		expect(HEART_RATE).toEqual(RECORD_LIMITS.heartRate);
	});
});
