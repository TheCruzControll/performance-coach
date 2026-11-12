import { describe, expect, it } from 'vitest';
import { createMutation, MUTATION_TYPES } from '#lib/domain/workout/index.ts';
import type { Mutation } from '#lib/domain/workout/index.ts';
import { JUST_SWAP_REASON } from '#lib/domain/workout/substitution.ts';
import { queued } from '#lib/client/workout/outbox-rules.ts';
import type { OutboxEntry } from '#lib/client/workout/outbox-rules.ts';
import { discardAbandons, loggedIn } from '#lib/client/workout/store.ts';
import { fixFor } from './registry';
import { abandonWords, discardOffer, HELD_END_WORDS, sentAgain } from './workout';

const SET_TYPES = ['set.log', 'set.skip', 'set.edit'];
const EDITOR_TYPES = [
	'workout.update',
	'workout.finish',
	'run.log',
	'run.segment',
	'other.log',
	'exercise.substitute',
	'exercise.create',
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

	it('says a stuck start’s Discard ends the workout as abandoned, counting the changes logged in it', () => {
		const workoutId = '00000000-0000-4000-8000-0000000000d1';
		const at = '2026-11-07T08:00:00.000Z';
		const start = createMutation('workout.start', {
			workoutId,
			at,
			payload: {
				kind: 'strength',
				title: 'Full body',
				sessionType: 'strength',
				discipline: 'strength',
				plannedSessionId: null,
				plannedLineage: null,
				programId: null
			}
		});
		const notes = (text: string) =>
			createMutation('workout.update', { workoutId, at, payload: { notes: text } });
		const stuck = (seq: number, m: Mutation): OutboxEntry => ({
			...queued(seq, m),
			parked: { reason: 'stuck', errors: {}, message: 'timeout' }
		});
		const entries = [stuck(1, start), queued(2, notes('a')), queued(3, notes('b'))];

		expect(discardAbandons(entries, 1)).toBe(true);
		const n = loggedIn(entries, 1).length;
		expect(abandonWords(n)).toBe(
			'Discard ends this workout as abandoned and removes the 2 changes logged in it.'
		);
		expect(abandonWords(1)).toBe(
			'Discard ends this workout as abandoned and removes the 1 change logged in it.'
		);
		expect(abandonWords(0)).toBe('Discard ends this workout as abandoned.');
		for (const count of [0, 1, 2]) expect(abandonWords(count)).toMatch(/^Discard \w.+\.$/);

		// A start stuck again with its abandon queued (an earlier Discard) still keeps both: the
		// abandon is not counted among the changes that go.
		const abandon = createMutation('workout.abandon', { workoutId, at, payload: {} });
		const again = [stuck(1, start), queued(4, abandon)];
		expect(discardAbandons(again, 1)).toBe(true);
		expect(loggedIn(again, 1)).toEqual([]);
		expect(abandonWords(loggedIn(again, 1).length)).toBe('Discard ends this workout as abandoned.');
		expect(loggedIn([...entries, queued(4, abandon)], 1).map((e) => e.seq)).toEqual([2, 3]);

		// Not for a refused start, or any other change.
		const refused: OutboxEntry = {
			...entries[0]!,
			parked: { reason: 'refused', errors: {}, message: 'Not valid' }
		};
		expect(discardAbandons([refused, ...entries.slice(1)], 1)).toBe(false);
		expect(discardAbandons([entries[0]!, stuck(2, notes('a'))], 2)).toBe(false);
	});

	it('offers no Discard for the end of a workout the server holds, only words and Try again', () => {
		const workoutId = '00000000-0000-4000-8000-0000000000d1';
		const at = '2026-11-07T08:00:00.000Z';
		const update = createMutation('workout.update', { workoutId, at, payload: { notes: 'a' } });
		const abandon = createMutation('workout.abandon', { workoutId, at, payload: {} });
		const finish = createMutation('workout.finish', { workoutId, at, payload: {} });
		const park = (seq: number, m: Mutation, reason: 'stuck' | 'refused'): OutboxEntry => ({
			...queued(seq, m),
			parked: { reason, errors: {}, message: 'Not valid' }
		});

		// The store's heldEnds names the end: the sheet offers no Discard for it. A refused one is
		// re-sent through Fix (resend), as the outbox's Try again only re-queues a stuck one.
		for (const end of [abandon, finish]) {
			expect(discardOffer([park(1, end, 'stuck')], 1, new Set([1]))).toEqual({
				kind: 'held',
				words: HELD_END_WORDS.stuck,
				resend: false
			});
			expect(discardOffer([park(1, end, 'refused')], 1, new Set([1]))).toEqual({
				kind: 'held',
				words: HELD_END_WORDS.refused,
				resend: true
			});
		}
		// Neither says it retries by itself: a parked change waits for Try again.
		expect(HELD_END_WORDS).toEqual({
			stuck:
				'The server still has this workout in progress, so this change stays until it goes through. Try again to send it.',
			refused:
				'The server still has this workout in progress and did not take this change. It stays until it goes through. Try again to send it once more.'
		});
		for (const words of Object.values(HELD_END_WORDS)) expect(words).not.toMatch(/retries/);

		// Discard of a change it depends on does not count it among the changes that go.
		const entries = [park(1, update, 'refused'), queued(2, abandon)];
		expect(discardOffer(entries, 1, new Set([2]))).toEqual({ kind: 'discard', n: 1 });

		// Not held (the device holds the workout's rows): Discard as before, counting the abandon.
		expect(discardOffer(entries, 1, new Set())).toEqual({ kind: 'discard', n: 2 });
		expect(discardOffer([park(1, abandon, 'refused')], 1, new Set())).toEqual({
			kind: 'discard',
			n: 1
		});
	});

	it('re-sends a refused held end under its id, at the time now only when the server named its time', () => {
		const workoutId = '00000000-0000-4000-8000-0000000000d1';
		const at = '2026-11-07T08:00:00.000Z';
		const now = new Date('2026-11-08T09:30:00.000Z');
		const abandon = createMutation('workout.abandon', { workoutId, at, payload: {} });
		const finish = createMutation('workout.finish', { workoutId, at, payload: {} });

		for (const end of [abandon, finish]) {
			const retimed = sentAgain(end, { at: 'Not before the workout started' }, now);
			expect(retimed).toEqual({ ...end, at: now.toISOString() });
			expect(retimed.id).toBe(end.id);
			// Refused for another reason (another account, a type not supported yet): sent as it was.
			expect(sentAgain(end, {}, now)).toBe(end);
			expect(sentAgain(end, { 'payload.rpe': 'Too high' }, now)).toBe(end);
		}
	});

	it('offers a stuck start’s Discard as ending the workout, with the changes logged in it', () => {
		const workoutId = '00000000-0000-4000-8000-0000000000d1';
		const at = '2026-11-07T08:00:00.000Z';
		const start = createMutation('workout.start', {
			workoutId,
			at,
			payload: {
				kind: 'strength',
				title: 'Full body',
				sessionType: 'strength',
				discipline: 'strength',
				plannedSessionId: null,
				plannedLineage: null,
				programId: null
			}
		});
		const notes = createMutation('workout.update', { workoutId, at, payload: { notes: 'a' } });
		const stuck: OutboxEntry = {
			...queued(1, start),
			parked: { reason: 'stuck', errors: {}, message: 'timeout' }
		};
		expect(discardOffer([stuck, queued(2, notes)], 1, new Set())).toEqual({
			kind: 'abandon',
			n: 1,
			words: abandonWords(1)
		});
	});
});
