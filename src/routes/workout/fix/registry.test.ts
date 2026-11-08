import { describe, expect, it } from 'vitest';
import { createMutation, MUTATION_TYPES } from '#lib/domain/workout/index.ts';
import { fixFor } from './registry';

const SET_TYPES = ['set.log', 'set.skip', 'set.edit'];
const EDITOR_TYPES = ['run.log', 'run.segment', 'other.log'];

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
						: type === 'workout.start'
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
});
