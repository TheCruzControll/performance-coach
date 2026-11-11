import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKOUT_DAY_IDS, workoutDayKits } from '../../../../tests/fixtures/workout-day';
import { strengthTable } from '#lib/domain/workout/reducers/tables.ts';
import { comingLineages, KITS_AHEAD_DAYS, saveComingKits, type DatedSession } from './coming-kits';
import { DB_NAME } from './names';
import { saveKits, startKitUrl, startPlanned } from './start';
import { createStore } from './store';
import { savedToday } from './today-kits';

/** The workout day's three sessions are planned on Friday 6 November. */
const FRIDAY = '2026-11-06';
const KITS = workoutDayKits({ date: FRIDAY });
const { strength: STRENGTH, run: RUN, other: OTHER } = WORKOUT_DAY_IDS;

/** A fetch answering each fixture kit's URL. */
const fetch = vi.fn(async (url: string, _init: RequestInit) => {
	const kit = Object.values(KITS).find((k) => url === startKitUrl(k.plannedLineage!));
	return kit ? Response.json(kit) : new Response('{}', { status: 404 });
});

/** start.ts's saveKits through a store opened only when asked, as Today and Train do. */
const save = async (lineages: string[]) =>
	saveKits(lineages, { store: await createStore({ table: strengthTable, channel: null }), fetch });

const databases = async () => (await indexedDB.databases()).filter((d) => d.name === DB_NAME);

const on = (date: string, lineage: string, status: DatedSession['status'] = 'planned') => ({
	lineage,
	status,
	date
});

beforeEach(() => {
	vi.stubGlobal('indexedDB', new IDBFactory());
	fetch.mockClear();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('comingLineages', () => {
	it('keeps today and the next two days ready, by day, in plan order within a day', () => {
		expect(KITS_AHEAD_DAYS).toBe(2);
		const sessions = [
			on('2026-11-03', 'yesterday'),
			on('2026-11-06', 'day-after-tomorrow'),
			on('2026-11-05', 'tomorrow-am'),
			on('2026-11-04', 'today'),
			on('2026-11-05', 'tomorrow-pm'),
			on('2026-11-07', 'three-days-on')
		];
		expect(comingLineages(sessions, '2026-11-04')).toEqual([
			'today',
			'tomorrow-am',
			'tomorrow-pm',
			'day-after-tomorrow'
		]);
	});

	it('keeps only the sessions still to do, planned or moved, each once', () => {
		const sessions = [
			on('2026-11-04', 'planned'),
			on('2026-11-04', 'done', 'completed'),
			on('2026-11-05', 'skipped', 'skipped'),
			on('2026-11-05', 'moved', 'moved'),
			// Today lists a session of this week on its day and again in Up next.
			on('2026-11-05', 'planned')
		];
		expect(comingLineages(sessions, '2026-11-04')).toEqual(['planned', 'moved']);
	});

	it('crosses a month and a year', () => {
		const sessions = [on('2027-01-02', 'in-two-days'), on('2027-01-03', 'too-far')];
		expect(comingLineages(sessions, '2026-12-31')).toEqual(['in-two-days']);
	});
});

describe('saveComingKits', () => {
	it('with nothing to save, asks for nothing and creates no database', async () => {
		const later = [on('2026-11-09', STRENGTH.lineage), on('2026-11-05', RUN.lineage, 'completed')];
		expect(await saveComingKits([], '2026-11-05', save)).toEqual([]);
		expect(await saveComingKits(later, '2026-11-05', save)).toEqual([]);
		expect(fetch).not.toHaveBeenCalled();
		expect(await databases()).toEqual([]);
	});

	it("by default, saves through start.ts's store, creating the device's database", async () => {
		vi.stubGlobal('fetch', fetch);
		expect(await saveComingKits([on(FRIDAY, OTHER.lineage)], FRIDAY)).toEqual([OTHER.lineage]);
		expect(fetch).toHaveBeenCalledOnce();
		const store = await createStore({ table: strengthTable, channel: null });
		expect(await store.getKit(OTHER.lineage)).toEqual(KITS.other);
		store.close();
	});

	it('saves the night before what starts with no signal the next day', async () => {
		// Thursday evening: Friday's sessions are tomorrow, and Today or Train shows them.
		const thursday = '2026-11-05';
		const sessions = [
			on(FRIDAY, STRENGTH.lineage),
			on(FRIDAY, RUN.lineage),
			on(FRIDAY, OTHER.lineage, 'skipped')
		];
		const spy = vi.fn(save);
		expect(await saveComingKits(sessions, thursday, spy)).toEqual([STRENGTH.lineage, RUN.lineage]);
		expect(spy).toHaveBeenCalledExactlyOnceWith([STRENGTH.lineage, RUN.lineage]);

		// Friday, in a gym with no signal: the offline screen lists them and Start starts one.
		const fridayNoon = new Date(2026, 10, 6, 12).getTime();
		expect((await savedToday(fridayNoon)).map((s) => s.lineage)).toEqual([
			STRENGTH.lineage,
			RUN.lineage
		]);
		const store = await createStore({ table: strengthTable, channel: null });
		const started = await startPlanned(RUN.lineage, {
			store,
			fetch: async () => {
				throw new TypeError('Failed to fetch');
			},
			now: () => fridayNoon,
			persist: async () => true
		});
		expect(started).toEqual({ status: 'started', path: '/workout/run' });
		store.close();
	});
});
