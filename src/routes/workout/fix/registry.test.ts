import { describe, expect, it } from 'vitest';
import { createMutation, MUTATION_TYPES } from '#lib/domain/workout/index.ts';
import { JUST_SWAP_REASON } from '#lib/domain/workout/substitution.ts';
import { fixFor } from './registry';

const SET_TYPES = ['set.log', 'set.skip', 'set.edit'];
const EDITOR_TYPES = [
	'workout.update',
	'workout.finish',
	'run.log',
	'run.segment',
	'other.log',
	'exercise.substitute',
	'pain.report'
];
const REWRITE_TYPES = ['workout.start', 'exercise.dislike'];

describe('the Fix registry', () => {
	it.each(MUTATION_TYPES)(
		'gives %s an editor, a rewrite or Discard only, with its words',
		async (type) => {
			const entry = await fixFor(type);
			expect(entry.discard).toMatch(/^Discard \w.+\.$/);
			expect(entry.kind).toBe(
				SET_TYPES.includes(type)
					? 'set-editor'
					: EDITOR_TYPES.includes(type)
						? 'editor'
						: REWRITE_TYPES.includes(type)
							? 'rewrite'
							: 'discard-only'
			);
		}
	);

	it('keeps a refused start as a session not linked to the plan, under its id', async () => {
		const entry = await fixFor('workout.start');
		const start = createMutation('workout.start', {
			workoutId: '00000000-0000-4000-8000-0000000000d1',
			at: '2026-11-07T08:00:00.000Z',
			payload: {
				kind: 'strength',
				title: 'Lower body & pull',
				sessionType: 'strength',
				discipline: 'strength',
				plannedSessionId: '00000000-0000-4000-8000-0000000000d2',
				plannedLineage: '00000000-0000-4000-8000-0000000000d3',
				programId: '00000000-0000-4000-8000-0000000000d4'
			}
		});
		if (entry.kind !== 'rewrite') throw new Error('workout.start has a rewrite');
		expect(entry.label).toBe('Keep it as a session not linked to the plan');
		expect(entry.rewrite(start)).toEqual({
			...start,
			payload: { ...start.payload, plannedSessionId: null, plannedLineage: null, programId: null }
		});
	});

	it('re-sends a refused dislike as just today’s swap, under its id, with no preference', async () => {
		const entry = await fixFor('exercise.dislike');
		const dislike = createMutation('exercise.dislike', {
			workoutId: '00000000-0000-4000-8000-0000000000d1',
			at: '2026-11-07T08:10:00.000Z',
			payload: {
				position: 2,
				plannedLineage: '00000000-0000-4000-8000-0000000000d5',
				fromExerciseId: '00000000-0000-4000-8000-0000000000e1',
				toExerciseId: '00000000-0000-4000-8000-0000000000e2',
				note: 'Hurts my knees'
			}
		});
		if (entry.kind !== 'rewrite') throw new Error('exercise.dislike has a rewrite');
		expect(entry.label).toBe('Just swap it today');
		expect(entry.rewrite(dislike)).toEqual({
			v: 1,
			id: dislike.id,
			type: 'exercise.substitute',
			workoutId: dislike.workoutId,
			entityId: dislike.entityId,
			at: dislike.at,
			payload: {
				position: 2,
				plannedLineage: '00000000-0000-4000-8000-0000000000d5',
				fromExerciseId: '00000000-0000-4000-8000-0000000000e1',
				toExerciseId: '00000000-0000-4000-8000-0000000000e2',
				reason: JUST_SWAP_REASON
			}
		});
	});

	it('reopens a refused swap’s alternatives, and keeps the exercise when a skip is discarded', async () => {
		const swap = await fixFor('exercise.substitute');
		if (swap.kind !== 'editor') throw new Error('exercise.substitute has an editor');
		expect((await swap.editor()).default).toBeTypeOf('function');
		expect((await fixFor('exercise.skip')).discard).toBe('Discard keeps the exercise.');
	});
});
