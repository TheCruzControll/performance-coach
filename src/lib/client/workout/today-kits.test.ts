import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKOUT_DAY_IDS, workoutDayKits } from '../../../../tests/fixtures/workout-day';
import { strengthTable } from '#lib/domain/workout/reducers/tables.ts';
import { DB_NAME } from './names';
import { saveKits, startKitUrl } from './start';
import { createStore } from './store';
import { saveTodayKits } from './today-kits';

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
