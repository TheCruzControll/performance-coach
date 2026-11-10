/**
 * The exercise library on this device (PRD §7; the offline workout sync ADR): what Add exercise
 * picks from, in any strength session, offline too. Loaded with the picker, never before.
 *
 * - IndexedDB keeps the library GET /api/exercises last gave (the store's saveLibrary), under its
 *   digest. Online, refreshLibrary revalidates it with If-None-Match: a 304 keeps it, a new
 *   library replaces it, along with the owner's units it carries. Offline, or with no answer in
 *   LIBRARY_TIMEOUT_MS, the cached copy is what the picker shows; with none, the picker says the
 *   list is not on this device yet. A 401 changes nothing here: the sync engine's next flush is
 *   what handles a lost session (sync.ts), and its purge deletes the cached library.
 * - searchLibrary matches names and aliases ('RDL') with case, accents, punctuation, spacing and
 *   plurals ignored, as the server's exercise matcher reads them (domain/exercises/match.ts, which
 *   stays on the server): an exact name or alias first, then one that starts with the query, then
 *   one that contains it; names before aliases on a tie, the library's order (by name) after that.
 * - addExercise adds a picked exercise after the session's last one and makes it current, as
 *   device state (exercise.add): nothing is sent until its first set is logged, whose set.log
 *   carries its exercise id and position.
 * Plain .ts with no runes: the store and the network are injected.
 */
import { DEFAULT_LOAD_INCREMENT } from '#lib/domain/units.ts';
import type {
	AddedExercise,
	ExerciseLibrary,
	KitExerciseMeta,
	KitUnits,
	LibraryExercise,
	WorkoutView
} from '#lib/domain/workout/index.ts';
import type { WorkoutStore } from './store.ts';

/** The live library, which also carries the owner's training-profile units. */
export const LIBRARY_URL = '/api/exercises';

/** How long the picker waits for the server before it shows the copy this device holds. */
export const LIBRARY_TIMEOUT_MS = 5_000;

/**
 * Owner decision: how many matches the picker lists at once. The rest are counted under the
 * list ('Keep typing to narrow 12 more'), so a long library never makes a long, slow sheet.
 */
export const RESULT_LIMIT = 40;

/** The library as the picker uses it: its exercises, and the units their increments are in. */
export type Library = Pick<ExerciseLibrary, 'units' | 'exercises'>;

/** Whether `units` are a weight and a distance unit the app knows. */
export const isUnits = (units: Partial<KitUnits> | undefined): units is KitUnits =>
	['kg', 'lb'].includes(units?.weight as string) &&
	['km', 'mi'].includes(units?.distance as string);

/** Whether a response body is a library, v1, as the server builds it. */
export function isLibrary(body: unknown): body is ExerciseLibrary {
	const library = body as Partial<ExerciseLibrary> | null;
	return (
		library?.v === 1 &&
		typeof library.digest === 'string' &&
		isUnits(library.units) &&
		Array.isArray(library.exercises)
	);
}

type LibraryStore = Pick<WorkoutStore, 'getLibrary' | 'saveLibrary' | 'saveUnits'>;

interface RefreshOptions {
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
	online?: boolean;
}

/**
 * The library, revalidated against the server when online: the new one (now cached), the cached
 * one (unchanged, or the server unreachable), or null when this device holds none.
 */
export async function refreshLibrary(
	store: LibraryStore,
	{
		fetch = globalThis.fetch,
		timeoutMs = LIBRARY_TIMEOUT_MS,
		online = navigator.onLine
	}: RefreshOptions = {}
): Promise<Library | null> {
	const cached = await store.getLibrary();
	if (!online) return cached;
	const headers: Record<string, string> = { accept: 'application/json' };
	if (cached) headers['if-none-match'] = `"${cached.digest}"`;
	let body: unknown;
	try {
		const response = await fetch(LIBRARY_URL, { headers, signal: AbortSignal.timeout(timeoutMs) });
		if (!response.ok) {
			// A 304 has no body; any other one unread would keep the request open.
			void response.body?.cancel().catch(() => {});
			return cached;
		}
		body = await response.json();
	} catch {
		return cached;
	}
	if (!isLibrary(body)) return cached;
	await store.saveLibrary(body);
	await store.saveUnits(body.units);
	return body;
}

/** -es after a sibilant (presses), -s after anything but s (squats, not press). */
const plural = (word: string) =>
	/(?:ch|sh|ss|x|z)es$/.test(word)
		? word.slice(0, -2)
		: word.length >= 3 && /[^s]s$/.test(word)
			? word.slice(0, -1)
			: word;

/** The form names are compared in: 'Pull-ups', 'pull ups' and 'Pullup' are one. */
const normalise = (text: string) =>
	text
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/['’]/g, '')
		.split(/[^a-z0-9]+/)
		.filter(Boolean)
		.map(plural)
		.join('');

/** An exercise's names, normalised once per library. */
const normalised = new WeakMap<LibraryExercise, string[]>();
function namesOf(exercise: LibraryExercise): string[] {
	let names = normalised.get(exercise);
	if (!names) {
		names = [exercise.name, ...exercise.aliases].map(normalise);
		normalised.set(exercise, names);
	}
	return names;
}

/** How well `query` names an exercise, lower first; null when it does not. */
function rank(exercise: LibraryExercise, query: string): number | null {
	let best: number | null = null;
	namesOf(exercise).forEach((name, i) => {
		const fit = name === query ? 0 : name.startsWith(query) ? 2 : name.includes(query) ? 4 : null;
		// The exercise's own name before an alias that fits as well.
		const score = fit === null ? null : fit + (i === 0 ? 0 : 1);
		if (score !== null && (best === null || score < best)) best = score;
	});
	return best;
}

/**
 * The exercises `query` names, best first, at most `limit` of them, and how many more match. A
 * blank query lists the whole library in its order.
 */
export function searchLibrary(
	exercises: readonly LibraryExercise[],
	query: string,
	limit = RESULT_LIMIT
): { results: LibraryExercise[]; more: number } {
	const q = normalise(query);
	const matches = q
		? exercises
				.map((exercise, order) => ({ exercise, order, score: rank(exercise, q) }))
				.filter((m): m is typeof m & { score: number } => m.score !== null)
				.sort((a, b) => a.score - b.score || a.order - b.order)
				.map((m) => m.exercise)
		: exercises;
	return { results: matches.slice(0, limit), more: Math.max(0, matches.length - limit) };
}

/**
 * `exercise` as the workout keeps it, after its last exercise: its meta as a kit carries it, its
 * load step in the workout's weight unit (the library's is in the units it was built in).
 */
export function addedExercise(
	view: WorkoutView,
	exercise: LibraryExercise,
	libraryUnits: KitUnits,
	at: string
): AddedExercise {
	const position = Math.max(0, ...view.slots.map((slot) => slot.position)) + 1;
	const unit = view.kit?.units.weight ?? libraryUnits.weight;
	const meta: KitExerciseMeta = {
		id: exercise.id,
		key: exercise.key,
		name: exercise.name,
		measure: exercise.measure,
		loadType: exercise.loadType,
		unilateral: exercise.unilateral,
		pattern: exercise.pattern,
		tags: [...exercise.tags],
		restClass: exercise.restClass,
		increment: unit === libraryUnits.weight ? exercise.increment : DEFAULT_LOAD_INCREMENT[unit],
		equipment: [...exercise.equipment]
	};
	return { position, exercise: meta, addedAt: at };
}

/** Adds `exercise` after the session's last one and makes it current, in one write. */
export function addExercise(
	store: Pick<WorkoutStore, 'dispatch'>,
	view: WorkoutView,
	exercise: LibraryExercise,
	libraryUnits: KitUnits,
	at = new Date().toISOString()
) {
	const added = addedExercise(view, exercise, libraryUnits, at);
	const workoutId = view.workout.id;
	return store.dispatch(
		{ type: 'exercise.add', workoutId, exercise: added },
		{ type: 'goTo', workoutId, position: added.position }
	);
}
