/**
 * The session screen's load (src/routes/(app)/train/session/[key]/detail.server.ts) on real
 * Postgres: one planned session by lineage, in words, in the owner's units. A week-1 strength
 * session works up to its top sets and says what to record; a run is its steps; Muay Thai is its
 * class, effort and metrics. ?v=n reads an older version, read-only. A malformed or unknown key
 * or version is the 404 page; a read that fails is the designed error, recorded.
 */
import { isHttpError } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { BASELINE_INSTRUCTION } from '../../../src/lib/domain/training/describe';
import type { Executor } from '../../../src/lib/server/db';
import { findErrorsByRequestId } from '../../../src/lib/server/services/errors';
import { getAthleteProfile, saveBasics } from '../../../src/lib/server/services/profile/index';
import {
	createProgramFromPlan,
	getProgramVersion,
	skipSession,
	type ProgramVersion
} from '../../../src/lib/server/services/programs/index';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { BASELINE_CALLOUT } from '../../../src/lib/ui/program/session-words';
import {
	loadSessionDetail,
	type SessionDetailData
} from '../../../src/routes/(app)/train/session/[key]/detail.server';
import { unreachableDb, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

/** Week 1's Monday: the hybrid fixture's strength day; Tuesday and Thursday hold Muay Thai. */
const MONDAY = '2026-11-09';
/** When each request comes in: that Monday morning, in the owner's zone (UTC until set). */
const NOW = new Date(`${MONDAY}T08:00:00Z`);

const origin = (requestId = crypto.randomUUID()) => ({
	requestId,
	method: 'GET',
	path: '/train/session/x',
	routeId: '/(app)/train/session/[key]',
	appVersion: '0.1.0+test'
});

async function withProgram(db: Executor) {
	const owner = await makeOwner(db);
	const plan = programFixture('hybrid', { monday: MONDAY, today: MONDAY });
	const { programId } = await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
	return { owner, stored: await getProgramVersion(owner, programId, 1, { db }) };
}

/** A session of version 1 by its week (0 is week 1) and title. */
function lineageOf(stored: ProgramVersion, week: number, title: string) {
	const weeks = stored.blocks.flatMap((b) => b.weeks);
	return weeks[week]!.sessions.find((s) => s.title === title)!.lineage;
}

async function load(db: Executor, owner: string, key: string, version: string | null = null) {
	const data = await loadSessionDetail(owner, { key, version, now: NOW, origin: origin() }, { db });
	// Swap's stream shares the test's transaction: settled before the test's next query.
	if (data.state === 'session') await data.swaps;
	return data;
}

/** The session view (fails the test for the error state). */
function shown(data: SessionDetailData) {
	if (data.state !== 'session') throw new Error(`expected a session, got ${data.state}`);
	return data;
}

/** The HTTP status a load was refused with (fails the test if it was not refused). */
async function status(promise: Promise<unknown>): Promise<number> {
	const error = await promise.then(
		() => null,
		(err: unknown) => err
	);
	if (!isHttpError(error)) throw new Error(`expected an HTTP error, got ${String(error)}`);
	return error.status;
}

describe('the session screen’s load', () => {
	it('a week-1 strength session works up to its top sets, says what to record, and labels each load’s basis', async () => {
		await withRollback(async (db) => {
			const { owner, stored } = await withProgram(db);
			const data = shown(await load(db, owner, lineageOf(stored, 0, 'Full body')));
			expect(data).toMatchObject({
				title: 'Full body',
				when: 'Monday 9 November · Morning',
				kind: 'strength',
				discipline: 'Strength',
				tone: 'strength',
				status: 'planned',
				statusWords: null,
				baseline: BASELINE_CALLOUT,
				older: null,
				steps: []
			});
			expect(data.details.facts).toEqual([
				{ label: 'Duration', value: '60', unit: 'min', caption: null },
				{ label: 'Target RPE', value: '7', unit: null, caption: 'Moderate' }
			]);
			expect(data.exercises.map((e) => e.name)).toEqual([
				'Power clean',
				'Back squat',
				'Bench press',
				'Barbell row'
			]);
			const [, squat, bench, row] = data.exercises;
			expect(squat!.instructions).toBe('Record weight, reps and RPE for every set.');
			expect(squat!.sets).toEqual([
				{
					headline: 'Work up to a set of 5 @ RPE 7',
					load: null,
					basis: null,
					rest: 'Rest 3:00',
					tempo: null,
					instruction: BASELINE_INSTRUCTION
				},
				{
					headline: '2 × 5 @ RPE 7',
					load: null,
					basis: '72 % of your week-1 estimate',
					rest: 'Rest 2:00',
					tempo: null,
					instruction: null
				}
			]);
			// A measured 1RM gives a load, in the owner's unit (kg by default).
			expect(bench!.sets[0]).toMatchObject({
				headline: '3 × 5 @ RPE 7',
				load: '70 kg',
				basis: '70 % of your measured 1RM'
			});
			expect(row!.sets[0]).toMatchObject({
				headline: '3 × 8–10 @ RPE 7',
				load: null,
				rest: 'Rest 1:30',
				tempo: 'Tempo 2010'
			});
		});
	});

	it('a later week’s strength session is no baseline, and reads loads in the owner’s unit', async () => {
		await withRollback(async (db) => {
			const { owner, stored } = await withProgram(db);
			const { name, timeZone } = await getAthleteProfile(owner, { db });
			await saveBasics(owner, { name, weightUnit: 'lb', distanceUnit: 'km', timeZone }, { db });
			const data = shown(await load(db, owner, lineageOf(stored, 1, 'Full body')));
			expect(data).toMatchObject({ when: 'Monday 16 November · Morning', baseline: null });
			expect(data.exercises[1]!.sets[0]).toMatchObject({
				headline: '1 × 5 @ RPE 7.5',
				basis: '82.5 % of your week-1 estimate',
				instruction: null
			});
			// 72.5 % of 100 kg, in pounds to the nearest 5 lb plate.
			expect(data.exercises[2]!.sets[0]).toMatchObject({ load: '160 lb' });
		});
	});

	it('a run is its warm-up, grouped repeats and cool-down, with paces in the owner’s distance unit', async () => {
		await withRollback(async (db) => {
			const { owner, stored } = await withProgram(db);
			const { name, timeZone } = await getAthleteProfile(owner, { db });
			await saveBasics(owner, { name, weightUnit: 'kg', distanceUnit: 'mi', timeZone }, { db });
			const data = shown(await load(db, owner, lineageOf(stored, 0, 'Intervals')));
			expect(data).toMatchObject({
				when: 'Wednesday 11 November · Morning',
				kind: 'run',
				discipline: 'Intervals',
				tone: 'running',
				baseline: null,
				exercises: []
			});
			expect(data.steps).toEqual([
				{
					repeats: 1,
					headline: 'Warm-up 10:00',
					segments: [{ headline: 'Warm-up 10:00', pace: null, target: 'RPE 3' }]
				},
				{
					repeats: 6,
					headline: '6 × (Interval 400 m + Recovery 1:30)',
					segments: [
						{ headline: 'Interval 400 m', pace: '6:02–6:26 /mi', target: null },
						{ headline: 'Recovery 1:30', pace: null, target: 'RPE 2' }
					]
				},
				{
					repeats: 1,
					headline: 'Cool-down 10:00',
					segments: [{ headline: 'Cool-down 10:00', pace: null, target: 'HR zone 2' }]
				}
			]);
		});
	});

	it('a Muay Thai class is its evening, its duration, its target RPE and its metrics', async () => {
		await withRollback(async (db) => {
			const { owner, stored } = await withProgram(db);
			const data = shown(await load(db, owner, lineageOf(stored, 0, 'Muay Thai class')));
			expect(data).toMatchObject({
				when: 'Tuesday 10 November · Evening',
				kind: 'other',
				discipline: 'Muay Thai · Class',
				tone: 'combat',
				exercises: [],
				steps: []
			});
			expect(data.details).toEqual({
				facts: [
					{ label: 'Duration', value: '90', unit: 'min', caption: null },
					{ label: 'Target RPE', value: '7', unit: null, caption: 'Hard' }
				],
				metrics: [
					{ label: 'Rounds', value: '6' },
					{ label: 'Round length', value: '3 min' },
					{ label: 'Sparring', value: 'No' },
					{ label: 'Focus', value: 'Teeps and checks' }
				]
			});
		});
	});

	it('?v=n reads an older version read-only; the current version, by number or not, is not older', async () => {
		await withRollback(async (db) => {
			const { owner, stored } = await withProgram(db);
			const key = lineageOf(stored, 0, 'Full body');
			await skipSession(owner, { sessionLineage: key }, { version: 1, today: MONDAY }, { db });

			const older = shown(await load(db, owner, key, '1'));
			expect(older).toMatchObject({
				status: 'planned',
				statusWords: null,
				older: { number: 1, inCurrent: true }
			});
			for (const version of [null, '2']) {
				const current = shown(await load(db, owner, key, version));
				expect(current).toMatchObject({
					status: 'skipped',
					statusWords: 'Skipped',
					older: null
				});
			}
		});
	});

	it('a malformed or unknown session or version is the 404 page', async () => {
		await withRollback(async (db) => {
			const { owner, stored } = await withProgram(db);
			const key = lineageOf(stored, 0, 'Full body');
			expect(await status(load(db, owner, crypto.randomUUID()))).toBe(404);
			expect(await status(load(db, owner, 'sample'))).toBe(404);
			for (const version of ['abc', '0', '-1', '1.5', '', ' 1', '2', '99999999999']) {
				expect({ version, status: await status(load(db, owner, key, version)) }).toEqual({
					version,
					status: 404
				});
			}
		});
	});

	it('fails soft when the database cannot be reached, and records the failure', async () => {
		const broken = unreachableDb();
		try {
			await withRollback(async (tx) => {
				const request = origin();
				const data = await loadSessionDetail(
					crypto.randomUUID(),
					{ key: crypto.randomUUID(), version: null, now: NOW, origin: request },
					{ db: broken.db, errorsDb: tx }
				);
				expect(data).toEqual({
					state: 'error',
					error: {
						title: 'Couldn’t load this session',
						description: 'Your plan is safe. Check your connection, then try again.'
					}
				});
				const recorded = await findErrorsByRequestId(request.requestId, { db: tx });
				expect(recorded).toHaveLength(1);
				expect(recorded[0]).toMatchObject({
					kind: 'load',
					status: 500,
					routeId: '/(app)/train/session/[key]',
					context: expect.objectContaining({ load: 'session' })
				});
			});
		} finally {
			await broken.close();
		}
	});
});
