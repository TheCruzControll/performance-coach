/**
 * Fix for the workout's own changes. A refused start (its planned session is gone, say) can be
 * kept as a session not linked to the plan: the same id, no planned session. A refused update or
 * finish opens the summary (FinishSheet.svelte, loaded only then) with the refused duration,
 * session RPE and notes and the server's errors; Save re-queues it under its id. Discard of a
 * start that kept failing ends the workout as abandoned instead of deleting it (abandonWords), and
 * the end of a workout a sign-out stripped from the device is not offered at all (discardOffer):
 * the server holds that workout in progress, so its finish or abandon waits for the server.
 */
import { dependantsOf } from '#lib/client/workout/outbox-rules.ts';
import type { OutboxEntry } from '#lib/client/workout/outbox-rules.ts';
import { discardAbandons, loggedIn } from '#lib/client/workout/store.ts';
import type { Mutation } from '#lib/domain/workout/index.ts';
import type { FamilyFixes } from './registry.ts';

const editor = () => import('../FinishSheet.svelte');

/** workout.start, kept with no planned session, program or lineage. */
function unplanned(m: Mutation): Mutation {
	if (m.type !== 'workout.start') return m;
	const payload = { ...m.payload, plannedSessionId: null, plannedLineage: null, programId: null };
	return { ...m, payload };
}

/**
 * What Discard of a stuck start says (the store's discardAbandons): the start may have reached the
 * server, so the workout stays, abandoned, and only the `n` changes logged in it go.
 */
export function abandonWords(n: number): string {
	if (n === 0) return 'Discard ends this workout as abandoned.';
	const changes = n === 1 ? '1 change' : `${n} changes`;
	return `Discard ends this workout as abandoned and removes the ${changes} logged in it.`;
}

/** What the sync sheet says of an end the server must answer (the store's endsOnServer). */
export const HELD_END_WORDS =
	'Ending this workout on the server. It retries until it goes through.';

/**
 * What the sync sheet offers for a parked change, from the outbox and the store's heldEnds:
 * - held: the end of a workout the server holds. No Discard, only these words.
 * - abandon: a stuck start, whose Discard ends the workout as abandoned; `n` changes logged in it go.
 * - discard: `n` changes go, this one and those that depend on it, less any end held for the server.
 */
export type DiscardOffer =
	| { kind: 'held'; words: string }
	| { kind: 'abandon'; n: number; words: string }
	| { kind: 'discard'; n: number };

export function discardOffer(
	entries: readonly OutboxEntry[],
	seq: number,
	held: ReadonlySet<number>
): DiscardOffer {
	if (held.has(seq)) return { kind: 'held', words: HELD_END_WORDS };
	if (discardAbandons(entries, seq)) {
		const n = loggedIn(entries, seq).length;
		return { kind: 'abandon', n, words: abandonWords(n) };
	}
	return {
		kind: 'discard',
		n: 1 + dependantsOf(entries, seq).filter((e) => !held.has(e.seq)).length
	};
}

export const fixes: FamilyFixes<
	'workout.start' | 'workout.update' | 'workout.finish' | 'workout.abandon'
> = {
	'workout.start': {
		kind: 'rewrite',
		label: 'Keep it as a session not linked to the plan',
		rewrite: unplanned,
		discard: 'Discard removes this workout and everything logged in it.'
	},
	'workout.update': {
		kind: 'editor',
		editor,
		discard: 'Discard keeps the notes and effort the server has.'
	},
	'workout.finish': {
		kind: 'editor',
		editor,
		discard: 'Discard leaves the workout unfinished.'
	},
	'workout.abandon': { kind: 'discard-only', discard: 'Discard keeps the workout.' }
};
