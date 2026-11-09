/**
 * Starting a workout from the server's own kit, for the specs that need what only the server
 * builds (the alternatives, the gentler options, a planned slot): startFromKit stores a fixture
 * program (seedProgram), reads the planned session's kit from GET /api/workouts/kit, puts the
 * workout in IndexedDB as the app does when it starts one (seedWorkout), opens the kind's page
 * against the real server and waits until its workout.start has landed. Serial specs only: it
 * replaces the owner's program.
 */
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import type { ProgramFixture } from '../src/lib/server/test-support/program-fixtures';
import type { StartKit } from '../src/lib/domain/workout';
import {
	seedProgram,
	type ProgramStart,
	type SeededProgram,
	type SeededSession
} from './program-support';
import { query } from './support';
import { gotoWorkout, seedWorkout } from './workout-support';

export interface StartFromKit {
	/** The fixture program to store; 'workout-day' unless given. */
	fixture?: ProgramFixture;
	start?: ProgramStart;
	/** The session to start: the first of today's unless given. */
	pick?: (program: SeededProgram) => SeededSession | undefined;
	/** Runs once the program is stored and before the kit is read: history the kit should see. */
	before?: () => Promise<unknown>;
}

export interface StartedWorkout {
	program: SeededProgram;
	session: SeededSession;
	kit: StartKit;
	workoutId: string;
}

export async function startFromKit(
	page: Page,
	request: APIRequestContext,
	{
		fixture = 'workout-day',
		start = 'this_week',
		pick = (p) => p.sessions.find((s) => s.date === p.today),
		before
	}: StartFromKit = {}
): Promise<StartedWorkout> {
	const program = await seedProgram(request, { fixture, start });
	const session = pick(program);
	if (!session) throw new Error(`startFromKit: no session to start in '${fixture}'`);
	await before?.();
	const response = await request.get(`/api/workouts/kit?lineage=${session.lineage}`);
	expect(response.status(), `the kit of '${session.title}'`).toBe(200);
	const kit = (await response.json()) as StartKit;
	const workoutId = await seedWorkout(page, kit, { startedMinutesAgo: 5 });
	await gotoWorkout(page, kit.kind, { sync: 'real' });
	await expect(page.locator('main#main[data-store]')).toBeAttached();
	await expect
		.poll(
			async () => (await query('select 1 from workouts where client_id = $1', [workoutId])).length,
			{ message: 'the workout.start lands', timeout: 15_000 }
		)
		.toBe(1);
	return { program, session, kit, workoutId };
}
