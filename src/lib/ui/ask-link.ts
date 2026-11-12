/**
 * 'Ask the coach' links (PRD §12, the brief's contextual entry points): Coach opened on a new
 * conversation with a question waiting in the composer, the chip that says where it came from
 * (`from`, the coach's ENTRY_LABEL) and what it is about (`ref`, a source ref the turn context
 * carries). Built from strings alone, so the screens that link to Coach (the workout's sheets,
 * Today's plan) load no coach module: Coach reads the query (coach/[[thread]]/words.ts prefillOf).
 */

/** Where each entry point is, as the turn endpoint and Coach's chip name it. */
export type AskFrom = 'workout' | 'exercise' | 'today';

/** What the question is about: a workout or an exercise, by its id. */
export interface AskRef {
	type: 'workout' | 'exercise';
	id: string;
}

/**
 * Decision (M5 plan, coach-entry-points; the brief's examples): each entry point's question,
 * prefilled for the owner to send as it is or edit first.
 */
export const ASK_QUESTIONS = Object.freeze({
	workout: 'Can we change today’s workout?',
	exercise: (name: string) => `How has my ${name} progressed?`,
	today: 'What should I focus on next week?'
});

/** Coach (/coach) with `ask` prefilled from `from`, about `ref` when given. */
export function askHref(ask: string, from: AskFrom, ref: AskRef | null = null): string {
	const query = new URLSearchParams({ ask, from });
	if (ref) query.set('ref', `${ref.type}:${ref.id}`);
	return `/coach?${query}`;
}
