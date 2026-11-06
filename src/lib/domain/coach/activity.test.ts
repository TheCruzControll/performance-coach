import { describe, expect, it } from 'vitest';
import { ACTIVITY_STATES } from './events';
import { activityLabel, GENERIC_ACTIVITY } from './activity';
import { TOOL_NAMES, type ToolName } from './tools';

const UUID = '3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f';
/** Strings a model or a tool result could carry in place of a name. */
const IDS = [
	UUID,
	UUID.toUpperCase(),
	'barbell_bench_press',
	`workout:${UUID}`,
	`/progress/workouts/${UUID}`,
	'64b7f0c2a91e4d3f8c2b1a0e',
	'bench a1b2c3d4e5',
	`bench ${UUID}`,
	'ex_01HZX8K2M4',
	'deadliftdeadliftdeadlift',
	'bench\npress'
];
const items = (n: number) => ({
	items: Array.from({ length: n }, (_, i) => ({ id: `${UUID}${i}` }))
});

describe('activity wording', () => {
	it('words every tool when running, done and failed', () => {
		for (const tool of TOOL_NAMES) {
			const label = activityLabel(tool, {});
			expect(Object.keys(label).sort()).toEqual([...ACTIVITY_STATES].sort());
			expect(label.running).toMatch(/^[A-Z][^…]+…$/);
			expect(label.done).toMatch(/^[A-Z][^…]*[^….]$/);
			expect(label.failed).toMatch(/^Couldn’t [^…]*[^….]$/);
			expect(new Set(Object.values(label)).size).toBe(3);
			for (const text of Object.values(label)) expect(text).not.toMatch(/_|\d/);
		}
	});

	it('names the exercise, the count and the span when the input gives them', () => {
		expect(activityLabel('get_exercise_history', { exercise: 'bench', limit: 6 })).toEqual({
			running: 'Looking at your last 6 bench sessions…',
			done: 'Looked at your last 6 bench sessions',
			failed: 'Couldn’t load your last 6 bench sessions'
		});
		expect(activityLabel('get_training_history', { weeks: 4 }).running).toBe(
			'Looking at your last 4 weeks of training…'
		);
		expect(activityLabel('get_exercise_alternatives', { exercise: 'leg press' }).failed).toBe(
			'Couldn’t find alternatives to leg press'
		);
		expect(
			activityLabel('update_exercise_preferences', { exercise: 'Bulgarian split squats' }).running
		).toBe('Noting your preference about Bulgarian split squats…');
		expect(activityLabel('propose_program_adjustment', {}).running).toBe('Drafting the change…');
	});

	it('counts what the tool returned once it is done, and only then', () => {
		const input = { exercise: 'bench', limit: 6 };
		expect(activityLabel('get_exercise_history', input, items(4)).done).toBe(
			'Looked at your last 4 bench sessions'
		);
		expect(activityLabel('get_exercise_history', input, items(4)).running).toBe(
			'Looking at your last 6 bench sessions…'
		);
		expect(activityLabel('get_recent_workouts', {}, { count: 3 }).done).toBe(
			'Looked at your last 3 workouts'
		);
		expect(activityLabel('get_exercise_alternatives', { exercise: 'squat' }, items(5)).done).toBe(
			'Found 5 alternatives to squat'
		);
		// Nothing returned is not a count of zero.
		expect(activityLabel('get_recent_workouts', {}, items(0)).done).toBe(
			'Looked at your recent workouts'
		);
	});

	it('uses the singular for one', () => {
		expect(activityLabel('get_exercise_history', { exercise: 'bench', limit: 1 }).running).toBe(
			'Looking at your last bench session…'
		);
		expect(activityLabel('get_running_history', { weeks: 1 }).running).toBe(
			'Looking at your last week of running…'
		);
		expect(activityLabel('get_running_history', { weeks: 3 }).running).toBe(
			'Looking at your last 3 weeks of running…'
		);
		expect(activityLabel('get_running_history', { limit: 1 }).done).toBe('Looked at your last run');
		expect(activityLabel('get_recent_workouts', { limit: 2 }).done).toBe(
			'Looked at your last 2 workouts'
		);
		expect(activityLabel('get_exercise_alternatives', { exercise: 'squat' }, items(1)).done).toBe(
			'Found 1 alternative to squat'
		);
		expect(activityLabel('get_training_load', { weeks: 1 }).done).toBe(
			'Worked out your training load over the last week'
		);
	});

	it('never shows a raw id, a key or a ref, whatever the input and output carry', () => {
		for (const tool of TOOL_NAMES) {
			const generic = activityLabel(tool, {});
			for (const id of IDS) {
				const input = { exercise: id, id, exerciseId: id, workoutId: id, ids: [id], limit: 6 };
				const output = { exercise: { id, name: id }, items: [{ id }], id };
				const label = activityLabel(tool, input, output);
				for (const text of Object.values(label)) {
					expect(text).not.toContain(id.trim());
					const tokens = id.split(/[\s:/]+/).filter((part) => part.length >= 8 && /\d/.test(part));
					for (const token of tokens) expect(text).not.toContain(token);
					expect(text).not.toMatch(/[_:/]/);
				}
				// An id is dropped, not replaced: the wording is the tool's own, with the count kept.
				expect(label.running).toBe(activityLabel(tool, { limit: 6 }).running);
				expect(generic.running).not.toContain(id);
			}
		}
	});

	it('ignores anything that is not a small whole number or a short name', () => {
		const generic = activityLabel('get_exercise_history', {});
		for (const limit of [0, -3, 2.5, 1e9, Number.NaN, '6', null, [6]])
			expect(activityLabel('get_exercise_history', { limit }).running).toBe(generic.running);
		for (const exercise of ['', '   ', 42, { name: 'bench' }, 'x'.repeat(41), '1234'])
			expect(activityLabel('get_exercise_history', { exercise }).running).toBe(generic.running);
		for (const input of [null, undefined, 'bench', 6, [{ exercise: 'bench' }]])
			expect(activityLabel('get_exercise_history', input)).toEqual(generic);
		expect(
			activityLabel('get_exercise_history', Object.create({ exercise: 'bench', limit: 6 }))
		).toEqual(generic);
		expect(activityLabel('get_exercise_history', { exercise: '  bench  ' }).running).toBe(
			'Looking at your bench history…'
		);
	});

	it('takes the exercise from the output when the input named it by id', () => {
		expect(
			activityLabel(
				'get_personal_records',
				{ exerciseId: UUID },
				{ exercise: { name: 'Deadlift' } }
			).done
		).toBe('Looked at your Deadlift records');
		expect(
			activityLabel('get_personal_records', { exerciseId: UUID }, { exercise: 'Deadlift' }).done
		).toBe('Looked at your Deadlift records');
	});

	it('words a tool that is not in the catalogue generically, without its name', () => {
		const label = activityLabel('drop_all_tables' as ToolName, { exercise: 'bench' });
		expect(label).toEqual(GENERIC_ACTIVITY);
		for (const text of Object.values(label)) expect(text).not.toMatch(/drop|table|bench/i);
	});
});
