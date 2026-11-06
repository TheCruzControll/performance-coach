import { describe, expect, it } from 'vitest';
import { SCHEMAS, validate } from '#lib/domain/profile/schemas.ts';
import type { ExercisePreference } from '#lib/domain/profile/types.ts';
import { exercisesDraft, exercisesPayload, listErrors } from './exercise-preferences';

/** As the services return them: dislikes first (the repository sorts by sentiment). */
const saved: ExercisePreference[] = [
	{ id: 'p1', exercise: 'Burpees', sentiment: 'dislike', reason: 'Wrists ache in the push-up' },
	{ id: 'p2', exercise: 'Leg press', sentiment: 'dislike', reason: null },
	{ id: 'p3', exercise: 'Front squat', sentiment: 'like', reason: 'Asked for more of it' },
	{ id: 'p4', exercise: 'Deadlift', sentiment: 'like', reason: null }
];

describe('exercisesDraft', () => {
	it('starts with two empty lists when nothing is saved yet', () => {
		expect(exercisesDraft([])).toEqual({ likes: [], dislikes: [], reasons: {} });
		expect(exercisesPayload(exercisesDraft([]))).toEqual({ items: [] });
	});

	it('splits the preferences into likes and dislikes, each in the order they came', () => {
		const draft = exercisesDraft(saved);
		expect(draft.likes).toEqual(['Front squat', 'Deadlift']);
		expect(draft.dislikes).toEqual(['Burpees', 'Leg press']);
	});
});

describe('exercisesPayload', () => {
	it('round-trips every sentiment and reason: a save sends back what it was given', () => {
		expect(exercisesPayload(exercisesDraft(saved))).toEqual({
			items: [
				{ exercise: 'Front squat', sentiment: 'like', reason: 'Asked for more of it' },
				{ exercise: 'Deadlift', sentiment: 'like', reason: null },
				{ exercise: 'Burpees', sentiment: 'dislike', reason: 'Wrists ache in the push-up' },
				{ exercise: 'Leg press', sentiment: 'dislike', reason: null }
			]
		});
	});

	it('keeps a reason through edits around it; a new exercise has none', () => {
		const draft = exercisesDraft(saved);
		draft.likes = ['Bench press', ...draft.likes.filter((e) => e !== 'Deadlift')];
		draft.dislikes.push('Box jumps');
		expect(exercisesPayload(draft).items).toEqual([
			{ exercise: 'Bench press', sentiment: 'like', reason: null },
			{ exercise: 'Front squat', sentiment: 'like', reason: 'Asked for more of it' },
			{ exercise: 'Burpees', sentiment: 'dislike', reason: 'Wrists ache in the push-up' },
			{ exercise: 'Leg press', sentiment: 'dislike', reason: null },
			{ exercise: 'Box jumps', sentiment: 'dislike', reason: null }
		]);
	});

	it('finds the reason of an exercise removed and typed again in another case', () => {
		const draft = exercisesDraft(saved);
		draft.dislikes = ['Leg press', 'burpees'];
		expect(exercisesPayload(draft).items).toContainEqual({
			exercise: 'burpees',
			sentiment: 'dislike',
			reason: 'Wrists ache in the push-up'
		});
	});

	it('drops the reason of an exercise moved to the other list: it no longer says why', () => {
		const draft = exercisesDraft(saved);
		draft.dislikes = draft.dislikes.filter((e) => e !== 'Burpees');
		draft.likes.push('Burpees');
		expect(exercisesPayload(draft).items).toContainEqual({
			exercise: 'Burpees',
			sentiment: 'like',
			reason: null
		});
	});

	it('gives an exercise named like an object key no reason of its own', () => {
		const draft = exercisesDraft([]);
		draft.likes = ['constructor', '__proto__'];
		expect(exercisesPayload(draft).items.map((i) => i.reason)).toEqual([null, null]);
	});

	it('posts what the shared schema takes, and the schema refuses an exercise in both lists', () => {
		const draft = exercisesDraft(saved);
		expect(validate(SCHEMAS.exercises, exercisesPayload(draft)).ok).toBe(true);
		draft.likes.push('leg press');
		expect(validate(SCHEMAS.exercises, exercisesPayload(draft))).toEqual({
			ok: false,
			errors: { items: 'Each exercise once — it can’t be liked and disliked' }
		});
	});
});

describe('listErrors', () => {
	it('shows nothing when nothing is wrong', () => {
		expect(listErrors({}, 2)).toEqual({ likes: undefined, dislikes: undefined });
	});

	it('puts an exercise’s error on its own list, counting the likes first', () => {
		expect(listErrors({ 'items.1.exercise': 'Too long' }, 2)).toEqual({
			likes: 'Too long',
			dislikes: undefined
		});
		expect(listErrors({ 'items.2.exercise': 'Too long' }, 2)).toEqual({
			likes: undefined,
			dislikes: 'Too long'
		});
	});

	it('puts an error about the whole list on the list to swap out', () => {
		expect(listErrors({ items: 'Each exercise once' }, 2)).toEqual({
			likes: undefined,
			dislikes: 'Each exercise once'
		});
	});
});
