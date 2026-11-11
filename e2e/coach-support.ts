/**
 * The coach specs' support (`*.serial.e2e.ts`): coach fixtures seeded through the real services by
 * the test-only route, at dates the server computes from the owner's time zone; faults and
 * scripted runs for the mock coach; and SQL to compare the screens with.
 *
 * - Start every test from resetCoach (seedCoach resets first): it empties every program, log and
 *   coach row (resetTrainingProfile), clears the faults and the coach's turn rate limit. A spec
 *   that sets a fault also resets in afterEach or afterAll, so the next spec starts clean.
 * - Pin the browser to the zone the route records: `test.use({ timezoneId: COACH_TZ })`, and use
 *   the dates seedCoach returns; never compute a date in the spec.
 * - Faults and scripts live in the server's memory, so they hold for every browser until the next
 *   setCoachFault or resetCoach; serial specs run one at a time, so none sees another's.
 *
 * Written once and never edited: a fixture is added on the server (coach-fixtures.ts), a fault in
 * COACH_FAULTS, a script in mock-scripts/test.ts.
 */
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { createSseDecoder, type CoachEvent } from '../src/lib/domain/coach/events';
import type {
	CoachFault,
	CoachFixture,
	SeededCoach
} from '../src/lib/server/test-support/coach-fixtures';
import { gotoHydrated, query, resetTrainingProfile, SAME_ORIGIN } from './support';

export { query } from './support';
export type { CoachFault, CoachFixture, SeededCoach };

/** The owner's zone in coach specs: daylight saving, and neither UTC nor the runner's zone. */
export const COACH_TZ = 'Australia/Sydney';

const ROUTE = '/api/test-support/coach';

/** What a fault leaves in force: a forced script, a delay before every chunk, a shorter turn. */
export interface CoachControls {
	script?: string;
	chunkDelayMs?: number;
	turnMs?: number;
}

/** Put `fault` (and `controls`) in force for every turn until the next call or reset. */
export async function setCoachFault(
	request: APIRequestContext,
	fault: CoachFault,
	controls: CoachControls = {}
): Promise<void> {
	const response = await request.post(ROUTE, {
		headers: SAME_ORIGIN,
		data: { fault, ...controls }
	});
	expect(response.status(), `setting fault '${fault}'`).toBe(200);
}

/** No program, log or coach row, no fault, and the coach's turn rate limit cleared. */
export async function resetCoach(request: APIRequestContext): Promise<void> {
	await resetTrainingProfile();
	await setCoachFault(request, 'none');
}

/** Reset, then seed `fixture` in COACH_TZ: the ids and dates the spec compares with. */
export async function seedCoach(
	request: APIRequestContext,
	fixture: CoachFixture
): Promise<SeededCoach> {
	await resetCoach(request);
	const response = await request.post(ROUTE, {
		headers: SAME_ORIGIN,
		data: { fixture, timeZone: COACH_TZ },
		timeout: 30_000
	});
	expect(response.status(), `seeding '${fixture}'`).toBe(201);
	return (await response.json()) as SeededCoach;
}

/** Open a conversation (/coach/<id>) and wait until it has hydrated. */
export async function openThread(page: Page, threadId: string): Promise<void> {
	await gotoHydrated(page, `/coach/${threadId}`);
}

export interface PostedTurn {
	status: number;
	headers: Record<string, string>;
	/** The stream's events, in order; empty unless the turn streamed (200). */
	events: CoachEvent[];
}

/** Send one turn as the composer does and read its whole stream. */
export async function postTurn(
	request: APIRequestContext,
	text: string,
	threadId: string | null = null
): Promise<PostedTurn> {
	const response = await request.post('/api/coach/turns', {
		headers: SAME_ORIGIN,
		data: { threadId, clientMessageId: crypto.randomUUID(), text },
		timeout: 30_000
	});
	const events: CoachEvent[] = [];
	if (response.status() === 200) {
		const decoder = createSseDecoder();
		events.push(...decoder.push(await response.body()), ...decoder.end());
	}
	return { status: response.status(), headers: response.headers(), events };
}

/** The coach's rows, counted: what a refused turn must leave unchanged. */
export async function coachCounts(): Promise<{ threads: number; messages: number; runs: number }> {
	const [row] = await query<{ threads: number; messages: number; runs: number }>(
		`select (select count(*)::int from coach_threads) as threads,
			(select count(*)::int from coach_messages) as messages,
			(select count(*)::int from agent_runs) as runs`
	);
	return row!;
}

/** A thread's owner messages, oldest first: a retry must never add one. */
export async function ownerMessages(threadId: string): Promise<{ id: string; text: string }[]> {
	return query(
		`select id::text, content #>> '{}' as text from coach_messages
		where thread_id = $1 and kind = 'owner_message' order by seq`,
		[threadId]
	);
}

/** The newest turn run (a summary made after an answer is not one): how it ended, and why. */
export async function lastRun(): Promise<{
	id: string;
	threadId: string;
	status: string;
	error: string | null;
} | null> {
	const [run] = await query<{ id: string; threadId: string; status: string; error: string | null }>(
		`select id::text, thread_id::text as "threadId", status, error from agent_runs
		where kind <> 'summary' order by started_at desc, id desc limit 1`
	);
	return run ?? null;
}
