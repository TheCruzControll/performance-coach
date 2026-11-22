/**
 * Swap in a run, as the device sends it (SessionActionsSheet.svelte, session-actions.ts), on real
 * Postgres: the run ends where it is and a zone 2 bike starts in its place, both pinned to the
 * run's planned session, through the sync dispatcher (services/workouts/sync.ts) in two batches.
 * A contract guard: it uses only the existing mutation types and passes without the client change,
 * since it pins what the device relies on. The bike is its own workout (counted as one, with its
 * minutes and load, never as running distance), and the planned run completes once.
 *
 * Batches go through applySyncBatch as the endpoint calls it, with a test transaction as its db.
 */
import { describe, expect, it } from 'vitest';
import {
	createMutation,
	type Mutation,
	type SyncResult
} from '../../../src/lib/domain/workout/index';
import type { Executor } from '../../../src/lib/server/db';
import { getWeeklyTrainingSummary } from '../../../src/lib/server/services/analytics/index';
import {
	createProgramFromPlan,
	getProgramVersion,
	type StoredSession
} from '../../../src/lib/server/services/programs/index';
import { applySyncBatch } from '../../../src/lib/server/services/workouts/sync';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

/** The week of the workout-day plan, and the day its interval run is planned (a Wednesday). */
const TODAY = '2026-11-11';
const RUN_DAY = '2026-11-11';

/** An instant on the run's day, `minute` minutes after 07:00 UTC. */
const at = (minute = 0) => new Date(`${RUN_DAY}T07:00:00Z`).getTime() + minute * 60_000;
const iso = (minute = 0) => new Date(at(minute)).toISOString();
const deviceId = () => crypto.randomUUID();

const sync = (db: Executor, owner: string, mutations: readonly Mutation[]) =>
	applySyncBatch(owner, JSON.parse(JSON.stringify(mutations)) as Record<string, unknown>[], {
		db
	});

const statuses = (results: readonly SyncResult[]) => results.map((r) => r.status);

/** The run as the device ends it: started, one segment, its totals, and the finish. */
function endedRun(workoutId: string, pinned: PinnedRun): Mutation[] {
	return [
		createMutation('workout.start', {
			workoutId,
			at: iso(),
			payload: {
				kind: 'run',
				title: 'Intervals',
				sessionType: 'interval_run',
				discipline: 'running',
				...pinned
			}
		}),
		createMutation('run.segment', {
			workoutId,
			at: iso(10),
			payload: {
				position: 1,
				kind: 'warm_up',
				distanceMetres: 1000,
				durationSeconds: 360,
				avgHr: null,
				rpe: null
			}
		}),
		createMutation('run.log', {
			workoutId,
			at: iso(10),
			payload: { distanceMetres: 1000, durationSeconds: 360 }
		}),
		createMutation('workout.finish', {
			workoutId,
			at: iso(11),
			payload: { durationSeconds: 360, sessionRpe: null, notes: null }
		})
	];
}

/** The zone 2 bike that replaces the rest of it: started, logged as a session, and finished. */
function bike(workoutId: string, pinned: PinnedRun): Mutation[] {
	return [
		createMutation('workout.start', {
			workoutId,
			at: iso(12),
			payload: {
				kind: 'other',
				title: 'Zone 2 bike',
				sessionType: 'conditioning',
				discipline: 'running',
				...pinned
			}
		}),
		createMutation('other.log', {
			workoutId,
			at: iso(12),
			payload: { kind: 'conditioning', durationMinutes: 20, rpe: 4, metrics: [], notes: null }
		}),
		createMutation('workout.finish', {
			workoutId,
			at: iso(33),
			payload: { durationSeconds: 1200, sessionRpe: 4, notes: null }
		})
	];
}

interface PinnedRun {
	plannedSessionId: string;
	plannedLineage: string;
	programId: string;
}

describe('Swap in a run, as the device sends it', () => {
	it('ends the run and starts a zone 2 bike on the same planned session, each applied once', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const plan = programFixture('workout-day', { monday: '2026-11-09', today: TODAY });
			const { programId } = await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
			const v1 = await getProgramVersion(owner, programId, 1, { db });
			const run = (v1.blocks[0]!.weeks[0]!.sessions as StoredSession[]).find(
				(s) => s.kind === 'run'
			)!;
			const pinned: PinnedRun = {
				plannedSessionId: run.id,
				plannedLineage: run.lineage,
				programId
			};

			const runEnd = endedRun(deviceId(), pinned);
			const bikeStart = bike(deviceId(), pinned);

			const ended = await sync(db, owner, runEnd);
			expect(statuses(ended.results)).toEqual(runEnd.map(() => 'applied'));
			const started = await sync(db, owner, bikeStart);
			expect(statuses(started.results)).toEqual(bikeStart.map(() => 'applied'));

			// The run's distance is the run's alone; the bike is a second workout in the week.
			const summary = await getWeeklyTrainingSummary(owner, { today: TODAY }, { db });
			expect(summary).toMatchObject({
				status: 'ok',
				runningDistance: { value: 1 },
				workouts: { value: 2 },
				completed: { value: 1 }
			});

			// Replaying both batches answers every mutation as a duplicate: each applied once.
			const replay = await sync(db, owner, [...runEnd, ...bikeStart]);
			expect(statuses(replay.results)).toEqual([...runEnd, ...bikeStart].map(() => 'duplicate'));
		});
	});
});
