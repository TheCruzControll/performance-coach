/**
 * The coach's write-up on a review (review-narrative-ui), as CoachWriteUp draws it: written (the
 * stored released text, then the run's display blocks), being written, or a notice that says why
 * there is none. The server composes the first view (load.ts reviewNarration); the browser's
 * write-up-client.ts moves it on from POST /api/reviews/narrate's outcome and the polls of its
 * GET. Pure and isomorphic, and imported by neither view, so its words cost no initial JS.
 */
import { COACH_MAX_DURATION_S } from '#lib/domain/coach/budgets.ts';
import type { CompletedBlock } from '#lib/domain/coach/events.ts';

/**
 * Owner decision (the M6 plan's open question 'review write-up'): the coach writes a review up
 * once, when it is first opened. false waits for the owner's 'Ask your coach' instead.
 */
export const WRITE_UP_ON_OPEN = true;

/** Polling a write-up another request is running: 2, 4 and 8 s, then every 8 s. */
export const POLL_STEPS_MS: readonly number[] = Object.freeze([2_000, 4_000, 8_000]);

export interface WriteUpTarget {
	kind: 'weekly' | 'cycle';
	id: string;
}

export type NarrationView =
	| { state: 'written'; text: string; blocks: CompletedBlock[] }
	/** ask: this page requests it (POST); otherwise another request runs it and the page polls. */
	| { state: 'writing'; ask: boolean }
	/** action: the button that asks again ('Retry'), or null when asking cannot help. */
	| { state: 'notice'; title: string; detail: string; action: string | null };

/** POST /api/reviews/narrate's answer (agent/reviews/narrate.ts NarrationOutcome, on the wire). */
export type NarrateReply =
	| { outcome: 'written'; narrative: string; blocks: CompletedBlock[] }
	| { outcome: 'unavailable'; reason: string; runId?: string }
	| { outcome: 'failed' | 'superseded' };

/** GET /api/reviews/narrate's answer (narrationState, with the blocks once written). */
export type NarrationPoll =
	| { state: 'written'; narrative: string; blocks: CompletedBlock[] }
	| { state: 'running' }
	| { state: 'none' };

export const WRITING = 'Your coach is writing this up…';

const COMPLETE = 'The figures above are complete.';

const NOTICES: Record<string, [title: string, detail: string, action: string | null]> = {
	not_launched: [
		'Your coach is getting ready',
		`${COMPLETE} Its write-up comes once it’s ready.`,
		null
	],
	disabled: ['The coach is switched off', COMPLETE, null],
	unavailable: ['The coach is unavailable', COMPLETE, null],
	budget: [
		'Today’s coach budget is used up',
		`${COMPLETE} Open this review tomorrow for your coach’s write-up.`,
		null
	],
	rate_limited: [
		'Too many questions in a short time',
		`${COMPLETE} Try again in a minute.`,
		'Retry'
	],
	offline: ['You’re offline', `${COMPLETE} Try again once you’re back online.`, 'Retry'],
	failed: ['Couldn’t write this up', `${COMPLETE} Try again in a moment.`, 'Retry'],
	/** Refreshed elsewhere since this page loaded: asking again about this revision cannot help. */
	superseded: [
		'This review has been refreshed',
		'Reload the page for its latest figures and your coach’s write-up.',
		null
	],
	ask: [
		'Your coach can write this up',
		'What the figures above mean, and what to do next.',
		'Ask your coach'
	]
};

/**
 * Why there is no write-up, in words: a coach that is not launched or is switched off, the daily
 * budget, the rate limit, offline, a failure; any other reason is the coach being unavailable.
 */
export function noticeOf(reason: string): NarrationView {
	const [title, detail, action] = NOTICES[Object.hasOwn(NOTICES, reason) ? reason : 'unavailable']!;
	return { state: 'notice', title, detail, action };
}

/** The words the server renders for `view`: the write-up's paragraphs, or one line. */
export function linesOf(view: NarrationView): string[] {
	if (view.state === 'written') return view.text.split('\n\n');
	return [view.state === 'writing' ? WRITING : `${view.title}. ${view.detail}`];
}

/** What the page shows after its POST: busy means another request runs it, so poll. */
export function viewOfReply(reply: NarrateReply): NarrationView {
	if (reply.outcome === 'written')
		return { state: 'written', text: reply.narrative, blocks: reply.blocks };
	if (reply.outcome === 'unavailable')
		return reply.reason === 'busy' ? { state: 'writing', ask: false } : noticeOf(reply.reason);
	return noticeOf(reply.outcome);
}

/** What a poll shows: the run ended with nothing stored is a failure, with Retry. */
export function viewOfPoll(poll: NarrationPoll): NarrationView {
	if (poll.state === 'written')
		return { state: 'written', text: poll.narrative, blocks: poll.blocks };
	return poll.state === 'running' ? { state: 'writing', ask: false } : noticeOf('failed');
}

/** The waits between polls: POLL_STEPS_MS, then the last step until `maxS` has passed. */
export function pollDelaysMs(maxS: number = COACH_MAX_DURATION_S): number[] {
	const delays: number[] = [];
	let total = 0;
	for (let i = 0; total < maxS * 1000; i++) {
		const step = POLL_STEPS_MS[Math.min(i, POLL_STEPS_MS.length - 1)]!;
		delays.push(Math.min(step, maxS * 1000 - total));
		total += step;
	}
	return delays;
}
