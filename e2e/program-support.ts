/**
 * Programs for the program screens' specs (`*.serial.e2e.ts`), before the generator lands: a
 * fixture program stored through the real store by the test-only route, at dates the server
 * computes from the owner's time zone, and a reset that leaves no M3 row behind.
 *
 * - Pin the browser to the zone the route records: `test.use({ timezoneId: PROGRAM_TZ })`.
 * - Use the dates seedProgram returns. Never compute a date in the browser or the spec: the
 *   server's today is the one the screens show, on any weekday and in any machine zone.
 */
import { expect, type APIRequestContext } from '@playwright/test';
import type { ProgramFixture } from '../src/lib/server/test-support/program-fixtures';
import { query, SAME_ORIGIN } from './support';

/** The owner's time zone in program specs: a zone with daylight saving, so neither UTC nor fixed. */
export const PROGRAM_TZ = 'Europe/London';

/** Where week 1 starts: the Monday of last, this or next week, by the server's today. */
export type ProgramStart = 'last_week' | 'this_week' | 'next_week';

export interface SeededSession {
	/** The session's path in version 1, e.g. `blocks.0.weeks.1.sessions.2`. */
	ref: string;
	/** What the session's URL carries (/train/session/<lineage>). */
	lineage: string;
	date: string;
	title: string;
}

export interface SeededProgram {
	programId: string;
	version: number;
	/** The owner's today, in PROGRAM_TZ, when the program was stored. */
	today: string;
	/** The Monday week 1 starts on. */
	weekStart: string;
	sessions: SeededSession[];
}

/**
 * The tables of M1 (auth, observability) and M2 (the training profile). Every other table is
 * M3's or later, and resetPrograms must empty it (program-support.serial.e2e.ts checks); the
 * exercise library keeps its catalogue rows. Listed by name, not read from a schema file, so a
 * new table is never mistaken for an old one.
 */
export const M1_M2_TABLES = [
	'app_errors',
	'auth_events',
	'auth_rate_limits',
	'auth_sessions',
	'owners',
	'passkey_credentials',
	'recovery_codes',
	'used_setup_tokens',
	'web_vitals',
	'webauthn_challenges',
	'athlete_profiles',
	'body_weight_entries',
	'discipline_experience',
	'equipment_profiles',
	'exercise_preferences',
	'injuries',
	'muay_thai_profiles',
	'race_results',
	'running_profiles',
	'schedule_commitments',
	'schedules',
	'strength_baselines',
	'training_goal_events',
	'training_goals'
] as const;

/** The tables resetPrograms truncates: CASCADE takes every table with a foreign key to one. */
export const RESET_ROOTS = [
	'programs',
	'workouts',
	'recovery_notes',
	'training_audit',
	'coach_proposals',
	'weekly_reviews',
	'cycle_reviews',
	'sync_mutations'
] as const;

/**
 * Remove every program, logged session, note, audit row, proposal and review, the sync ledger,
 * and the owner's custom exercises; the catalogue stays. TRUNCATE fires no row triggers, so the
 * history guards that refuse DELETE are not involved, and CASCADE reaches every table below these
 * roots. Only test code does this (scripts/history-guards.test.ts keeps TRUNCATE out of src/).
 */
export async function resetPrograms(): Promise<void> {
	await query(
		`truncate ${RESET_ROOTS.join(', ')} cascade;
		delete from exercises where owner_id is not null`
	);
}

/**
 * Start from no program, then store `fixture` with week 1 on `start`'s Monday in PROGRAM_TZ:
 * the dates and lineages of what was stored. Edits seed next_week (every session is ahead on any
 * weekday); Today uses the 'today' fixtures on this_week; 'one-week' on last_week is a finished
 * first block.
 */
export async function seedProgram(
	request: APIRequestContext,
	{ fixture, start }: { fixture: ProgramFixture; start: ProgramStart }
): Promise<SeededProgram> {
	await resetPrograms();
	const response = await request.post('/api/test-support/program', {
		headers: SAME_ORIGIN,
		data: { fixture, start, timeZone: PROGRAM_TZ }
	});
	expect(response.status(), `seeding '${fixture}' (${start})`).toBe(201);
	return (await response.json()) as SeededProgram;
}
