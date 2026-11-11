import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKOUT_DAY_IDS, workoutDayKits } from '../../../../tests/fixtures/workout-day';
import { strengthTable } from '#lib/domain/workout/reducers/tables.ts';
import { DB_NAME } from './names';
import type { SavedKit } from './db';
import type { PlannedRun } from './probe';
import { saveKits, startKitUrl, startPlanned } from './start';
import { createStore } from './store';
import { deviceDay, offlineSessions, saveTodayKits, savedToday } from './today-kits';

const KITS = workoutDayKits({ date: '2026-11-06' });
const { strength: STRENGTH, run: RUN, other: OTHER } = WORKOUT_DAY_IDS;

/** A fetch answering each fixture kit's URL. */
const fetch = vi.fn(async (url: string, _init: RequestInit) => {
	const kit = Object.values(KITS).find((k) => url === startKitUrl(k.plannedLineage!));
	return kit ? Response.json(kit) : new Response('{}', { status: 404 });
});

/** start.ts's saveKits through a store opened only when asked, as Today does. */
const save = async (lineages: string[]) =>
	saveKits(lineages, { store: await createStore({ table: strengthTable, channel: null }), fetch });

const databases = async () => (await indexedDB.databases()).filter((d) => d.name === DB_NAME);

beforeEach(() => {
	vi.stubGlobal('indexedDB', new IDBFactory());
	fetch.mockClear();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('saveTodayKits', () => {
	it('saves the kits of the sessions still to do, planned or moved, in order', async () => {
		const sessions = [
			{ lineage: STRENGTH.lineage, status: 'planned' as const },
			{ lineage: RUN.lineage, status: 'completed' as const },
			{ lineage: OTHER.lineage, status: 'moved' as const },
			{ lineage: 'skipped-one', status: 'skipped' as const }
		];
		const spy = vi.fn(save);
		expect(await saveTodayKits(sessions, spy)).toEqual([STRENGTH.lineage, OTHER.lineage]);
		expect(spy).toHaveBeenCalledExactlyOnceWith([STRENGTH.lineage, OTHER.lineage]);
		const store = await createStore({ table: strengthTable, channel: null });
		expect(await store.getKit(OTHER.lineage)).toEqual(KITS.other);
	});

	it('with nothing still to do today, asks for nothing and creates no database', async () => {
		for (const sessions of [
			[],
			[{ lineage: STRENGTH.lineage, status: 'completed' as const }],
			[{ lineage: RUN.lineage, status: 'skipped' as const }]
		]) {
			expect(await saveTodayKits(sessions, save)).toEqual([]);
		}
		expect(fetch).not.toHaveBeenCalled();
		expect(await databases()).toEqual([]);

		expect(await saveTodayKits([{ lineage: RUN.lineage, status: 'planned' }], save)).toEqual([
			RUN.lineage
		]);
		expect(await databases()).toHaveLength(1);
	});
});

describe('offlineSessions', () => {
	const TODAY = '2026-11-06';
	const saved = (kit: (typeof KITS)[keyof typeof KITS], savedAt = 1): SavedKit => ({
		lineage: kit.plannedLineage!,
		kit,
		savedAt
	});
	const ALL = [saved(KITS.strength), saved(KITS.run), saved(KITS.other)];
	const start = (lineage: string) => `/workout?start=${encodeURIComponent(lineage)}`;

	it("lists today's saved kits in order, each in words with Start workout", () => {
		expect(offlineSessions(ALL, [], TODAY)).toEqual([
			{
				lineage: STRENGTH.lineage,
				title: 'Lower body & pull',
				line: 'Strength · 5 exercises',
				tone: 'strength',
				action: { id: 'start-workout', label: 'Start workout', href: start(STRENGTH.lineage) }
			},
			{
				lineage: RUN.lineage,
				title: 'Intervals',
				line: 'Intervals',
				tone: 'running',
				action: { id: 'start-workout', label: 'Start workout', href: start(RUN.lineage) }
			},
			{
				lineage: OTHER.lineage,
				title: 'Muay Thai class',
				line: 'Muay Thai · 90 min',
				tone: 'combat',
				action: { id: 'start-workout', label: 'Start workout', href: start(OTHER.lineage) }
			}
		]);
	});

	it("leaves out kits saved for another day: yesterday's plan never starts today", () => {
		const yesterday = saved(workoutDayKits({ date: '2026-11-05' }).strength);
		expect(offlineSessions([yesterday, saved(KITS.run)], [], TODAY).map((s) => s.lineage)).toEqual([
			RUN.lineage
		]);
		expect(offlineSessions(ALL, [], '2026-11-07')).toEqual([]);
	});

	it('offers Resume for the workout in progress here, and no link once one was completed', () => {
		const runs: PlannedRun[] = [
			{ kind: 'run', status: 'in_progress', plannedLineage: RUN.lineage },
			{ kind: 'strength', status: 'abandoned', plannedLineage: STRENGTH.lineage },
			{ kind: 'other', status: 'completed', plannedLineage: OTHER.lineage }
		];
		const [strength, run, other] = offlineSessions(ALL, runs, TODAY);
		// An abandoned workout leaves its session to start again.
		expect(strength!.action).toEqual({
			id: 'start-workout',
			label: 'Start workout',
			href: start(STRENGTH.lineage)
		});
		expect(run!.action).toEqual({ id: 'resume-workout', label: 'Resume', href: '/workout/run' });
		expect(other!.action).toBeNull();
	});

	it("dates by the device's calendar day", () => {
		expect(deviceDay(new Date(2026, 10, 6, 23, 59).getTime())).toBe('2026-11-06');
		expect(deviceDay(new Date(2026, 0, 2, 0, 1).getTime())).toBe('2026-01-02');
	});
});

describe('savedToday', () => {
	const NOON = new Date(2026, 10, 6, 12).getTime();
	const unreachable = vi.fn(async () => {
		throw new TypeError('Failed to fetch');
	});

	it('reads none, and creates no database, on a device that never saved a kit', async () => {
		expect(await savedToday(NOON)).toEqual([]);
		expect(await databases()).toEqual([]);
	});

	it("lists the kits Today saved, in the plan's order, and Resume once one is started offline", async () => {
		expect(await save([STRENGTH.lineage, RUN.lineage, OTHER.lineage])).toHaveLength(3);
		const listed = await savedToday(NOON);
		expect(listed.map((s) => [s.lineage, s.action?.id])).toEqual([
			[STRENGTH.lineage, 'start-workout'],
			[RUN.lineage, 'start-workout'],
			[OTHER.lineage, 'start-workout']
		]);
		expect(await savedToday(new Date(2026, 10, 7, 8).getTime())).toEqual([]);

		// Started with no signal, from the saved kit, as /workout?start= does.
		const store = await createStore({ table: strengthTable, channel: null });
		const started = await startPlanned(RUN.lineage, {
			store,
			fetch: unreachable,
			now: () => NOON,
			persist: async () => true
		});
		expect(started).toEqual({
			status: 'started',
			path: '/workout/run',
			refresh: expect.any(String)
		});
		store.close();
		expect((await savedToday(NOON)).map((s) => s.action?.id)).toEqual([
			'start-workout',
			'resume-workout',
			'start-workout'
		]);
	});
});
