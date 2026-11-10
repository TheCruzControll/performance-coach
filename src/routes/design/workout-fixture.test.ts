import { describe, expect, it } from 'vitest';
import { LOAD_TYPES, MEASURES } from '#lib/domain/training/vocabulary.ts';
import { currentExercise } from '#lib/domain/workout/selectors.ts';
import { toDo } from '#lib/domain/workout/flow.ts';
import { setFields } from '#lib/domain/workout/logging.ts';
import { upNextWords } from '#lib/ui/workout/up-next-words.ts';
import { LOGGERS, UP_NEXT, upNextView } from './workout-fixture';

describe('/design → Workout fixtures', () => {
	it('gives the logger every measure and every load type, with the fields each records', () => {
		const loggers = Object.values(LOGGERS);
		const amounts = new Set(loggers.map((l) => l.fields.amount));
		const loads = new Set(loggers.map((l) => l.fields.load));
		expect(amounts).toEqual(new Set(MEASURES.map((m) => setFields(m, 'none').amount)));
		expect(loads).toEqual(new Set(LOAD_TYPES.map((t) => setFields('reps', t).load)));
		// Each prefill carries a value for exactly the amount it records.
		for (const { fields, values } of loggers) expect(values[fields.amount]).not.toBeNull();
	});

	it('projects Up next inside a superset round: the partner, A2', () => {
		expect(upNextWords(upNextView(UP_NEXT.partner))).toEqual({
			position: 3,
			label: 'A2',
			name: 'Plank',
			target: '45 s at RPE 7'
		});
	});

	it('projects Up next between exercises: the current one has nothing left, the next is named', () => {
		const view = upNextView(UP_NEXT.between);
		expect(toDo(currentExercise(view)!)).toBeNull();
		expect(upNextWords(view)).toMatchObject({ label: 'A1', name: 'Pull-up' });
	});

	it('projects every exercise done: nothing is up next', () => {
		const view = upNextView(UP_NEXT.done);
		expect(view.slots.every((slot) => slot.sets.length === 2)).toBe(true);
		expect(upNextWords(view)).toBeNull();
	});
});
