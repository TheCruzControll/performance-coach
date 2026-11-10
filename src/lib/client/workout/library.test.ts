import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKOUT_DAY_IDS, workoutDayKits } from '../../../../tests/fixtures/workout-day';
import type {
	ExerciseLibrary,
	LibraryExercise,
	StrengthKit,
	WorkoutView
} from '#lib/domain/workout/index.ts';
import { strengthTable } from '#lib/domain/workout/reducers/tables.ts';
import {
	addedExercise,
	addExercise,
	LIBRARY_URL,
	RESULT_LIMIT,
	refreshLibrary,
	searchLibrary
} from './library';
import { startAdHoc, startKitUrl, startPlanned } from './start';
import { createStore, type WorkoutStore } from './store';

const T0 = Date.parse('2026-11-06T18:00:00.000Z');
const KG = { weight: 'kg', distance: 'km' } as const;
const LB = { weight: 'lb', distance: 'mi' } as const;

function exercise(name: string, aliases: string[] = [], extra: Partial<LibraryExercise> = {}) {
	const key = name.toLowerCase().replace(/\W+/g, '_');
	return {
		id: `id-${key}`,
		key,
		name,
		aliases,
		measure: 'reps',
		loadType: 'external',
		unilateral: false,
		pattern: 'squat',
		equipment: ['dumbbells'],
		tags: ['compound'],
		defaultSeconds: null,
		restClass: 'compound',
		increment: 2.5,
		...extra
	} satisfies LibraryExercise;
}

// By name, as the server lists it.
const EXERCISES: LibraryExercise[] = [
	exercise('Back squat', ['Barbell back squat']),
	exercise('Bulgarian split squat', ['BSS', 'Rear-foot-elevated split squat']),
	exercise('Dumbbell Romanian deadlift', ['Dumbbell RDL', 'DB RDL'], { pattern: 'hinge' }),
	exercise('Goblet squat', ['Dumbbell goblet squat']),
	exercise('Romanian deadlift', ['RDL', 'Barbell RDL'], { pattern: 'hinge' }),
	exercise('Squat jump', [], { loadType: 'bodyweight' })
];

const LIBRARY: ExerciseLibrary = { v: 1, digest: 'd1', units: KG, exercises: EXERCISES };

const names = (list: readonly LibraryExercise[]) => list.map((e) => e.name);

describe('searchLibrary', () => {
	it('finds an exercise by an alias, the exact alias first', () => {
		const { results } = searchLibrary(EXERCISES, 'RDL');
		expect(names(results)).toEqual(['Romanian deadlift', 'Dumbbell Romanian deadlift']);
	});

	it('ranks an exact name, then a name that starts with the query, then one that contains it', () => {
		const squats = [exercise('Back squat'), exercise('Squat jump'), exercise('Squat')];
		expect(names(searchLibrary(squats, 'squat').results)).toEqual([
			'Squat',
			'Squat jump',
			'Back squat'
		]);
		// Contains, in the library's order.
		expect(names(searchLibrary(EXERCISES, 'split').results)).toEqual(['Bulgarian split squat']);
		expect(names(searchLibrary(EXERCISES, 'squat').results)).toEqual([
			'Squat jump',
			'Back squat',
			'Bulgarian split squat',
			'Goblet squat'
		]);
	});

	it('puts an exercise’s own name before an alias that fits as well', () => {
		// 'Barbell back squat' (an alias, first in the library) and 'Barbell row' (a name) both start with it.
		const barbell = [exercise('Back squat', ['Barbell back squat']), exercise('Barbell row')];
		expect(names(searchLibrary(barbell, 'barbell').results)).toEqual(['Barbell row', 'Back squat']);
	});

	it('ignores case, accents, punctuation, spacing and plurals', () => {
		expect(names(searchLibrary(EXERCISES, '  GOBLET-squats ').results)).toEqual(['Goblet squat']);
		const upper = [exercise('Bench press'), exercise('Pull-up'), exercise('Press-up')];
		expect(names(searchLibrary(upper, 'bench presses').results)).toEqual(['Bench press']);
		expect(names(searchLibrary(upper, 'PULL UPS').results)).toEqual(['Pull-up']);
		expect(names(searchLibrary(upper, 'press').results)).toEqual(['Press-up', 'Bench press']);
		expect(names(searchLibrary(EXERCISES, 'rómanian').results)).toEqual([
			'Romanian deadlift',
			'Dumbbell Romanian deadlift'
		]);
	});

	it('lists the whole library in its order for a blank query, and nothing for no match', () => {
		expect(searchLibrary(EXERCISES, '   ')).toEqual({ results: EXERCISES, more: 0 });
		expect(searchLibrary(EXERCISES, 'zercher')).toEqual({ results: [], more: 0 });
	});

	it('lists at most RESULT_LIMIT, and counts the rest', () => {
		const many = Array.from({ length: RESULT_LIMIT + 3 }, (_, i) => exercise(`Curl ${i}`));
		const { results, more } = searchLibrary(many, 'curl');
		expect(results).toHaveLength(RESULT_LIMIT);
		expect(more).toBe(3);
		expect(searchLibrary(many, 'curl', 2).more).toBe(RESULT_LIMIT + 1);
	});
});

let store: WorkoutStore;

beforeEach(async () => {
	vi.stubGlobal('indexedDB', new IDBFactory());
	store = await createStore({ table: strengthTable, now: () => T0, channel: null });
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** A server that answers the library URL with each answer in turn, recording the requests. */
function server(...answers: (Response | Error)[]) {
	const requests: { url: string; ifNoneMatch: string | null }[] = [];
	const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		requests.push({ url: String(url), ifNoneMatch: headers.get('if-none-match') });
		const answer = answers.shift();
		if (!answer) throw new Error('no answer left');
		if (answer instanceof Error) throw answer;
		return answer;
	});
	return { fetch: fetch as unknown as typeof globalThis.fetch, requests };
}

const notModified = () => new Response(null, { status: 304 });

describe('refreshLibrary', () => {
	it('with nothing cached, downloads the library, caches it with its units, and asks no digest', async () => {
		const { fetch, requests } = server(Response.json(LIBRARY));
		expect(await refreshLibrary(store, { fetch, online: true })).toEqual(LIBRARY);
		expect(requests).toEqual([{ url: LIBRARY_URL, ifNoneMatch: null }]);
		expect(await store.getLibrary()).toEqual({
			id: 'exercises',
			digest: 'd1',
			units: KG,
			exercises: EXERCISES,
			savedAt: T0
		});
		expect(await store.getUnits()).toEqual(KG);
	});

	it('revalidates the cached copy by its digest: a 304 keeps it', async () => {
		await store.saveLibrary(LIBRARY);
		const { fetch, requests } = server(notModified());
		const library = await refreshLibrary(store, { fetch, online: true });
		expect(requests).toEqual([{ url: LIBRARY_URL, ifNoneMatch: '"d1"' }]);
		expect(library).toMatchObject({ digest: 'd1', units: KG, exercises: EXERCISES });
	});

	it('a changed library replaces the cached one, and its units the saved ones', async () => {
		await store.saveLibrary(LIBRARY);
		const changed = { ...LIBRARY, digest: 'd2', units: LB, exercises: EXERCISES.slice(0, 2) };
		const { fetch } = server(Response.json(changed));
		expect(await refreshLibrary(store, { fetch, online: true })).toEqual(changed);
		expect(await store.getLibrary()).toMatchObject({ digest: 'd2', exercises: changed.exercises });
		expect(await store.getUnits()).toEqual(LB);
	});

	it('offline, answers the cached copy without asking, or null when there is none', async () => {
		const { fetch } = server();
		expect(await refreshLibrary(store, { fetch, online: false })).toBeNull();
		await store.saveLibrary(LIBRARY);
		expect(await refreshLibrary(store, { fetch, online: false })).toMatchObject({ digest: 'd1' });
		expect(fetch).not.toHaveBeenCalled();
	});

	it('keeps the cached copy when the server fails, refuses, or answers something else', async () => {
		await store.saveLibrary(LIBRARY);
		const { fetch } = server(
			new TypeError('Failed to fetch'),
			new Response('{}', { status: 500 }),
			new Response('{}', { status: 401 }),
			Response.json({ v: 2, digest: 'd9', units: KG, exercises: [] })
		);
		for (let i = 0; i < 4; i++) {
			expect(await refreshLibrary(store, { fetch, online: true })).toMatchObject({
				digest: 'd1',
				exercises: EXERCISES
			});
		}
		expect((await store.getLibrary())?.digest).toBe('d1');
	});

	it('with nothing cached and no answer, is null', async () => {
		const { fetch } = server(new TypeError('Failed to fetch'));
		expect(await refreshLibrary(store, { fetch, online: true })).toBeNull();
	});
});

const KITS = workoutDayKits({ date: '2026-11-06' });
const { strength: STRENGTH } = WORKOUT_DAY_IDS;
const goblet = EXERCISES.find((e) => e.name === 'Goblet squat')!;

const activeView = async (): Promise<WorkoutView> => (await store.getActive())!.view!;

/** A fetch for start.ts: the strength kit, and the library unless it is `library`. */
function startServer(library: unknown = LIBRARY) {
	return async (url: string) =>
		url === LIBRARY_URL
			? Response.json(library)
			: url === startKitUrl(STRENGTH.lineage)
				? Response.json(KITS.strength)
				: new Response('{}', { status: 404 });
}

const startOptions = (fetch: ReturnType<typeof startServer>) => ({
	store,
	fetch,
	now: () => T0,
	persist: async () => true
});

describe('addExercise', () => {
	it('adds the exercise after the plan’s last one and makes it current, on this device only', async () => {
		await startPlanned(STRENGTH.lineage, startOptions(startServer()));
		const before = await activeView();
		const last = Math.max(...(KITS.strength as StrengthKit).exercises.map((e) => e.position));

		const { saved } = addExercise(store, before, goblet, KG, '2026-11-06T18:05:00.000Z');
		expect(await saved).toBe('saved');

		const view = await activeView();
		expect(view.slots.at(-1)).toMatchObject({
			position: last + 1,
			exerciseId: goblet.id,
			state: 'added',
			plannedLineage: null,
			kit: null,
			sets: []
		});
		expect(view.device.position).toBe(last + 1);
		expect(view.exercises[goblet.id]).toEqual({
			name: 'Goblet squat',
			measure: 'reps',
			loadType: 'external',
			unilateral: false
		});
		// Device state: nothing is sent until its first set is logged.
		expect((await store.outbox()).map((e) => e.envelope.type)).toEqual(['workout.start']);
	});

	it('an ad-hoc strength session starts empty, and its first exercise takes position 1', async () => {
		await startAdHoc('strength', KG, startOptions(startServer()));
		const empty = await activeView();
		expect(empty.workout.kind).toBe('strength');
		expect(empty.slots).toEqual([]);

		await addExercise(store, empty, goblet, KG).saved;
		const once = await activeView();
		expect(once.slots.map((s) => [s.position, s.exerciseId])).toEqual([[1, goblet.id]]);
		await addExercise(store, once, goblet, KG).saved;
		expect((await activeView()).slots.map((s) => s.position)).toEqual([1, 2]);
	});

	it('keeps the kit’s meta and no library-only fields; the load step follows the workout’s unit', () => {
		const view = { slots: [], kit: { units: LB }, workout: { id: 'w' } } as unknown as WorkoutView;
		const added = addedExercise(view, goblet, KG, '2026-11-06T18:05:00.000Z');
		expect(added).toEqual({
			position: 1,
			addedAt: '2026-11-06T18:05:00.000Z',
			exercise: {
				id: goblet.id,
				key: 'goblet_squat',
				name: 'Goblet squat',
				measure: 'reps',
				loadType: 'external',
				unilateral: false,
				pattern: 'squat',
				tags: ['compound'],
				restClass: 'compound',
				// The library's 2.5 is kg; this workout logs in lb.
				increment: 5,
				equipment: ['dumbbells']
			}
		});
		const sameUnit = { ...view, kit: { units: KG } } as unknown as WorkoutView;
		expect(addedExercise(sameUnit, goblet, KG, '').exercise.increment).toBe(2.5);
	});
});

describe('startAdHoc caches the library its units came with', () => {
	it('so Add exercise works offline afterwards', async () => {
		await startAdHoc('strength', LB, startOptions(startServer()));
		expect(await store.getLibrary()).toMatchObject({ digest: 'd1', exercises: EXERCISES });
		expect(await refreshLibrary(store, { online: false })).toMatchObject({ digest: 'd1' });
	});

	it('caches nothing from a body that is only units', async () => {
		await startAdHoc('run', LB, startOptions(startServer({ v: 1, units: KG, exercises: [] })));
		expect(await store.getUnits()).toEqual(KG);
		expect(await store.getLibrary()).toBeNull();
	});
});
