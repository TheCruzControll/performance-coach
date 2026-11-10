/**
 * Helpers for the PRD §18 persistence matrix (persistence-matrix.serial.e2e.ts): a browser with a
 * profile on disk that can be crashed and relaunched, the process killer that crashes it, the
 * route that installs a service worker byte-different from the server's (so an update check
 * finds an app update), and the Postgres counts the cases assert.
 *
 * The killer only ever signals processes whose own command line contains the test's temporary
 * profile directory, so it cannot reach the test runner, the server under test or another
 * worker's browser.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
	BrowserContext,
	BrowserContextOptions,
	BrowserType,
	LaunchOptions
} from '@playwright/test';
import type { MutationPayloads, StrengthKit } from '../src/lib/domain/workout';
import { createMutation } from '../src/lib/domain/workout/mutations';
import { query, SAME_ORIGIN } from './support';

/** The fixture's strength kit as an ad hoc workout: its planned session is not in this database. */
export function adHoc(kit: StrengthKit): StrengthKit {
	return {
		...kit,
		plannedLineage: null,
		plannedSessionId: null,
		programId: null,
		exercises: kit.exercises.map((e) => ({ ...e, plannedLineage: null }))
	};
}

export interface SetRow {
	id: string;
	set_index: number;
	deleted: boolean;
}

/** Every set row Postgres holds for the workout with this client id, in set order. */
export const setsOf = (workoutId: string) =>
	query<SetRow>(
		`select r.client_mutation_id as id, r.set_index, r.deleted_at is not null as deleted
		   from set_records r join workouts w on w.id = r.workout_id
		  where w.client_id = $1
		  order by r.exercise_position, r.set_index, r.client_mutation_id`,
		[workoutId]
	);

/** How many workouts Postgres holds under this client id (one, or a duplicate slipped in). */
export const workoutCount = async (workoutId: string) =>
	(
		await query<{ n: number }>('select count(*)::int as n from workouts where client_id = $1', [
			workoutId
		])
	)[0]!.n;

/** The set.log of set `setIndex` of the kit's first exercise, as the logger queues it. */
export function firstExerciseSet(kit: StrengthKit, workoutId: string, setIndex: number) {
	const slot = kit.exercises[0]!;
	const planned = slot.sets.length;
	return createMutation('set.log', {
		workoutId,
		at: new Date().toISOString(),
		payload: {
			position: slot.position,
			exerciseId: slot.exercise.id,
			plannedLineage: null,
			setIndex,
			reps: 5,
			seconds: null,
			metres: null,
			weight: 100,
			assistance: null,
			unit: 'kg',
			rpe: 8,
			missedReps: 0,
			isWarmup: false,
			isExtra: setIndex > planned
		} satisfies MutationPayloads['set.log']
	});
}

/** A browser whose profile lives in its own temporary directory, so it survives a crash. */
export interface Profile {
	dir: string;
	/** Launches the browser on the profile and mints an owner session in it. */
	launch(): Promise<BrowserContext>;
	/** Deletes the profile directory. */
	remove(): void;
}

export function profile(
	browserType: BrowserType,
	options: BrowserContextOptions & LaunchOptions
): Profile {
	const dir = mkdtempSync(path.join(tmpdir(), 'pc-persistence-'));
	return {
		dir,
		async launch() {
			const context = await browserType.launchPersistentContext(dir, options);
			// A minted session for this browser alone. Minted again at every launch: a browser that
			// was killed may not have written its cookies to disk yet.
			const minted = await context.request.post('/api/test-support/session', {
				headers: SAME_ORIGIN
			});
			if (minted.status() !== 200) throw new Error(`minting a session: ${minted.status()}`);
			return context;
		},
		remove() {
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

/** How long a killed browser's context may take to report it is gone (a safety net only). */
const CLOSE_TIMEOUT_MS = 15_000;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The processes whose command line contains `dir` (never this one), by pid. */
export function processesOf(dir: string): number[] {
	const found = spawnSync('pgrep', ['-f', escapeRegExp(dir)], { encoding: 'utf8' });
	return found.stdout
		.split('\n')
		.filter(Boolean)
		.map(Number)
		.filter((pid) => pid !== process.pid)
		.filter((pid) => {
			// Checked again by the full command line, literally, right before the signal.
			const args = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
			return args.stdout.includes(dir);
		});
}

/**
 * kill -9 every process carrying the profile directory: no pagehide, unload or shutdown runs.
 * Resolves with the pids it signalled once the context has noticed its browser is gone; with none
 * when no process carries the path (the browser is then left running).
 */
export async function crash(context: BrowserContext, dir: string): Promise<number[]> {
	const pids = processesOf(dir);
	if (pids.length === 0) return [];
	const closed = new Promise<void>((resolve) => context.once('close', () => resolve()));
	for (const pid of pids) {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			// Gone already: a child that exited with its parent.
		}
	}
	const gone = await Promise.race([
		closed.then(() => true),
		new Promise<boolean>((resolve) => setTimeout(() => resolve(false), CLOSE_TIMEOUT_MS))
	]);
	if (!gone) throw new Error(`the browser context stayed open after SIGKILL to ${pids.join(', ')}`);
	return pids;
}

/** Response headers that describe the original body, wrong once the body changes. */
const BODY_HEADERS = new Set(['content-encoding', 'content-length', 'etag']);

/**
 * Stands in for the deployment before this one: the first fetch of the built service worker is
 * served with a comment appended, so the worker that installs differs byte for byte from what
 * the server serves, and the next update check finds the server's own script new and installs
 * it, as it would a new deployment. Later fetches go to the server untouched. Route it before
 * the context's first page loads: Chromium routes the script fetch of a worker's first install
 * but never an update check's, which its update checker makes in the browser process, outside
 * DevTools. Returns how many times the older script was served.
 */
export async function serveOlderWorker(context: BrowserContext): Promise<() => number> {
	let served = 0;
	await context.route('**/service-worker.js', async (route) => {
		if (served > 0) return route.fallback();
		served += 1;
		const response = await route.fetch();
		const headers = Object.fromEntries(
			Object.entries(response.headers()).filter(([name]) => !BODY_HEADERS.has(name.toLowerCase()))
		);
		await route.fulfill({
			status: response.status(),
			headers,
			body: `${await response.text()}\n// persistence-matrix: the deployment before this one\n`
		});
	});
	return () => served;
}
