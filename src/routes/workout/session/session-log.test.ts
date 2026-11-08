import { describe, expect, it } from 'vitest';
import { workoutDayKits } from '../../../../tests/fixtures/workout-day';
import { customMetricsSchema, RECORD_LIMITS } from '#lib/domain/training/schemas.ts';
import { OTHER_SESSION_KIND_LABEL } from '#lib/domain/training/vocabulary.ts';
import { validate } from '#lib/domain/validation.ts';
import type { LocalAction, Mutation, OtherKit } from '#lib/domain/workout/index.ts';
import { createMutation } from '#lib/domain/workout/mutations.ts';
import { applyLocal, applyMutation, replay, viewOf } from '#lib/domain/workout/project.ts';
import type { WorkoutState } from '#lib/domain/workout/project.ts';
import { otherTable } from '#lib/domain/workout/reducers/other.ts';
import {
	addMetric,
	checkValues,
	KIND_WORDS,
	keyOf,
	removable,
	saveActions,
	serverErrors,
	SESSION_MINUTES,
	shownValues,
	startValues,
	stopwatchMinutes,
	templateOf,
	unsaved
} from './session-log.ts';

const PLANNED = workoutDayKits({ date: '2026-11-06' }).other;
const AD_HOC: OtherKit = {
	...PLANNED,
	plannedSessionId: null,
	plannedLineage: null,
	programId: null,
	other: { kind: 'conditioning', durationMinutes: 45, targetRpe: null, metrics: [] }
};
const W = '00000000-0000-4000-8000-0000000000e2';
const AT = '2026-11-06T18:00:00.000Z';
const STARTED = Date.parse(AT);

function started(kit: OtherKit = PLANNED): WorkoutState {
	const start = createMutation('workout.start', {
		workoutId: W,
		entityId: W,
		at: AT,
		payload: {
			kind: 'other',
			title: kit.title,
			sessionType: kit.sessionType,
			discipline: kit.discipline,
			plannedSessionId: kit.plannedSessionId,
			plannedLineage: kit.plannedLineage,
			programId: kit.programId
		}
	});
	return replay(otherTable, { workoutId: W, kit, canonical: null, pending: [start] });
}

const viewIn = (state: WorkoutState) => viewOf(otherTable, state)!;
const apply = (state: WorkoutState, actions: (Mutation | LocalAction)[]) =>
	actions.reduce(
		(s, a) =>
			'v' in a ? applyMutation(otherTable, s, a) : applyLocal(otherTable, s, a as LocalAction),
		state
	);
const draft = (state: WorkoutState, change: object) =>
	apply(state, [{ type: 'session.draft', workoutId: W, draft: change }]);
/** 90 minutes after the start. */
const LATER = STARTED + 90 * 60_000;

describe('the session view’s words and limits', () => {
	it('names each type as the vocabulary does, and keeps M3’s minutes', () => {
		expect(KIND_WORDS).toStrictEqual(OTHER_SESSION_KIND_LABEL);
		expect(SESSION_MINUTES).toStrictEqual(RECORD_LIMITS.otherMinutes);
	});
});

describe('the session’s fields', () => {
	it('start from the plan’s type and metrics, and the stopwatch’s minutes', () => {
		const view = viewIn(started());
		expect(startValues(view, LATER)).toStrictEqual({
			kind: 'class',
			durationMinutes: 90,
			rpe: null,
			metrics: PLANNED.other.metrics,
			notes: null
		});
		// Never under a minute, never over M3's ten hours.
		expect(stopwatchMinutes(view, STARTED + 10_000)).toBe(1);
		expect(stopwatchMinutes(view, STARTED + 11 * 3_600_000)).toBe(600);
	});

	it('show what was changed and not saved over the start, so a reload restores it', () => {
		const state = draft(started(), { durationMinutes: 85, rpe: 8 });
		const values = shownValues(viewIn(state), LATER);
		expect(values).toMatchObject({ kind: 'class', durationMinutes: 85, rpe: 8 });
		expect(unsaved(viewIn(state), values)).toBe(true);
	});

	it('Save sends every value once as other.log and clears the draft; the record then holds them', () => {
		const metrics = [
			{ key: 'rounds', label: 'Rounds', unit: null, value: 6 },
			{ key: 'sparred', label: 'Sparred', unit: null, value: true }
		];
		const state = draft(started(), { durationMinutes: 90, rpe: 8, metrics, notes: ' Good pads ' });
		const view = viewIn(state);
		const saved = saveActions(view, shownValues(view, LATER), AT);
		if (!saved.ok) throw new Error('refused');
		const [log, clear] = saved.actions;
		expect(log).toMatchObject({
			type: 'other.log',
			workoutId: W,
			entityId: W,
			payload: { kind: 'class', durationMinutes: 90, rpe: 8, metrics, notes: 'Good pads' }
		});
		expect(clear).toStrictEqual({ type: 'session.draft', workoutId: W, draft: null });

		const after = viewIn(apply(state, saved.actions));
		expect(after.device.session).toBeNull();
		expect(after.other).toMatchObject({ durationMinutes: 90, metrics, pending: true });
		expect(unsaved(after, shownValues(after, LATER + 60_000))).toBe(false);
	});

	it('saving again after a change sends another other.log with the absolute values', () => {
		const metrics = [{ key: 'rounds', label: 'Rounds', unit: null, value: 6 }];
		const first = saveActions(
			viewIn(started()),
			{ ...startValues(viewIn(started()), LATER), metrics },
			AT
		);
		if (!first.ok) throw new Error('refused');
		const once = apply(started(), first.actions);
		const changed = draft(once, { metrics: [{ ...metrics[0]!, value: 7 }] });
		const view = viewIn(changed);
		expect(unsaved(view, shownValues(view, LATER))).toBe(true);
		const second = saveActions(view, shownValues(view, LATER), AT);
		if (!second.ok) throw new Error('refused');
		expect(second.actions[0].id).not.toBe(first.actions[0].id);
		expect(second.actions[0]).toMatchObject({
			entityId: W,
			payload: { durationMinutes: 90, metrics: [{ key: 'rounds', value: 7 }] }
		});
	});

	it('refuses minutes out of range and a metric left blank, by field, and sends nothing', () => {
		const view = viewIn(started());
		const values = {
			...startValues(view, LATER),
			durationMinutes: 0,
			metrics: [{ key: 'focus', label: 'Focus', unit: null, value: '  ' }]
		};
		expect(checkValues(values)).toStrictEqual({
			durationMinutes: 'Between 1 and 600 minutes',
			'metric:focus': 'Focus is a short text'
		});
		expect(saveActions(view, values, AT)).toEqual({ ok: false, errors: expect.any(Object) });
	});

	it('types a number typed as text, as the plan types it', () => {
		const view = viewIn(started());
		const values = {
			...startValues(view, LATER),
			metrics: [{ key: 'rounds', label: 'Rounds', unit: null, value: '7' }]
		};
		const saved = saveActions(view, values, AT);
		expect(saved.ok && saved.actions[0].payload).toMatchObject({
			metrics: [{ key: 'rounds', value: 7 }]
		});
	});
});

describe('the metrics a session takes', () => {
	it('a planned session takes its plan’s, and may drop only one its plan lacks', () => {
		const template = templateOf(viewIn(started()));
		expect(template).toStrictEqual(PLANNED.other.metrics);
		expect(removable(template, 'rounds')).toBe(false);
		expect(removable(template, 'kicks')).toBe(true);
	});

	it('an ad-hoc session takes the owner’s own: any may go', () => {
		const template = templateOf(viewIn(started(AD_HOC)));
		expect(template).toBeNull();
		expect(removable(template, 'rounds')).toBe(true);
	});

	it('adds the owner’s metric under a snake_case key M3 accepts, starting from its type', () => {
		const added = addMetric([], ' Bike calories ', 'number');
		expect(added).toStrictEqual({
			ok: true,
			metrics: [{ key: 'bike_calories', label: 'Bike calories', unit: null, value: 0 }]
		});
		expect(keyOf('Crème brûlée — rounds!')).toBe('creme_brulee_rounds');
		expect(keyOf('10k pace')).toBe('metric_10k_pace');
		for (const label of ['Bike calories', 'Crème brûlée', '10k pace', 'A'.repeat(40)]) {
			const result = addMetric([], label, 'text');
			if (!result.ok) throw new Error(result.error);
			const metrics = result.metrics.map((m) => ({ ...m, value: 'x' }));
			expect(validate(customMetricsSchema, metrics).ok, label).toBe(true);
		}
	});

	it('refuses a blank, a duplicate, an unkeyable or a 21st metric', () => {
		const [rounds] = PLANNED.other.metrics;
		expect(addMetric([], '  ', 'number')).toEqual({ ok: false, error: 'Name the metric' });
		expect(addMetric([rounds!], 'rounds', 'number')).toEqual({
			ok: false,
			error: 'rounds is already here'
		});
		expect(addMetric([], '!!!', 'number')).toEqual({
			ok: false,
			error: 'Use letters or numbers in the name'
		});
		const twenty = Array.from({ length: 20 }, (_, i) => ({ ...rounds!, key: `m${i}` }));
		expect(addMetric(twenty, 'Kicks', 'number')).toEqual({ ok: false, error: 'Up to 20 metrics' });
	});

	it('puts a server’s error on its metric by key, and the rest on their fields', () => {
		const metrics = [
			{ key: 'rounds', label: 'Rounds', unit: null, value: 6 },
			{ key: 'kicks', label: 'Kicks', unit: null, value: 40 }
		];
		expect(
			serverErrors(
				{
					'payload.metrics.1.key': 'Kicks is not one of this session’s metrics',
					'payload.durationMinutes': 'Between 1 and 600 minutes'
				},
				metrics
			)
		).toStrictEqual({
			'metric:kicks': 'Kicks is not one of this session’s metrics',
			durationMinutes: 'Between 1 and 600 minutes'
		});
		expect(serverErrors({ 'payload.metrics': 'Each metric once' }, metrics)).toStrictEqual({
			metrics: 'Each metric once'
		});
	});
});
