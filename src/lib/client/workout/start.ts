/**
 * Starting a workout (PRD §7, §9; the offline workout sync ADR, 'The start kit'). Loaded only when
 * /workout has ?start or ?new, by the start flow (src/routes/workout/StartFlow.svelte).
 *
 * - startPlanned(lineage): a kit saved on this device (Today saves them) starts the session at once,
 *   with no request: the workout page fetches the fresh kit in the background (kit-refresh.ts,
 *   through the outcome's `refresh`). With none saved, the start kit from GET
 *   /api/workouts/kit?lineage=, given UNSAVED_KIT_TIMEOUT_MS; unreachable (offline, a timeout, a
 *   5xx) says so. A 401 asks for a sign-in and a 404 says the session is not in the plan. Then the
 *   workout is created here under a new client id: workout.start, pinned to the kit's planned
 *   session, the kit and the stopwatch, in one write. Then persistent storage is asked for, and
 *   the caller goes to the kind's route (kinds.ts).
 * - startAdHoc(kind): the same, from a kit built on the device (domain adhoc.ts), in the owner's
 *   training-profile units, as GET /api/exercises gives them (owner decision: the profile wins
 *   over this device's display units, so a planned and an ad-hoc run read alike). Unreachable, the
 *   units the server last gave this device; never given, this device's own (deviceUnits). The
 *   library that answer carries is cached too (library.ts), so Add exercise works offline after.
 * - A kit or library request answering 401 is the sync engine's session loss, which is not running
 *   here: store.purgeServerCopies, then 'Sign in'. While a 401 has marked the device signed out,
 *   the server must answer as the owner before the workout held here shows, even in a conflict.
 * - A workout already in progress is answered as a conflict, before anything is fetched: Resume
 *   it, or discardInProgress and start again. Discard drops a workout whose start has not synced
 *   (the store's Discard), and abandons one the server holds (workout.abandon, sent by the next
 *   page's sync engine). Opening the start link of the workout in progress resumes it.
 * - saveKits(lineages): the coming days' kits, saved for a gym with no signal (Today and Train
 *   call it on idle, coming-kits.ts), with the owner's units. A 401 purges and stops it.
 * Plain .ts with no runes: the store, the network and the clock are injected.
 */
import type { IsoDate } from '#lib/domain/calendar.ts';
import type { SessionKind } from '#lib/domain/training/types.ts';
import { adhocKindOf, adhocKit, type AdhocKind } from '#lib/domain/workout/adhoc.ts';
import { createMutation } from '#lib/domain/workout/index.ts';
import type { ExerciseLibrary, KitUnits, StartKit } from '#lib/domain/workout/index.ts';
import { strengthTable } from '#lib/domain/workout/reducers/tables.ts';
import { workoutPath, type WorkoutPath } from './kinds.ts';
import { isLibrary, isUnits, LIBRARY_URL } from './library.ts';
import { createStore, requestPersistence, type WorkoutStore, type WriteOutcome } from './store.ts';

/** A kit or the units not answered after this long are given up on (saveKits, startAdHoc). */
export const KIT_TIMEOUT_MS = 4_000;
/** Starting with no kit saved, the owner waits on the request: the offline state comes sooner. */
export const UNSAVED_KIT_TIMEOUT_MS = 1_500;

export const startKitUrl = (lineage: string) =>
	`/api/workouts/kit?lineage=${encodeURIComponent(lineage)}`;

export { LIBRARY_URL };

/** What /workout's query asks for: ?start=<lineage> wins over ?new=run|other. */
export type StartRequest = { lineage: string } | { kind: AdhocKind };

export function startRequestOf(search: string): StartRequest | null {
	const query = new URLSearchParams(search);
	const lineage = query.get('start');
	if (lineage) return { lineage };
	const kind = adhocKindOf(query.get('new'));
	return kind ? { kind } : null;
}

export interface KitOptions {
	fetch?: (url: string, init: RequestInit) => Promise<Response>;
	setTimeout?: (run: () => void, ms: number) => unknown;
	clearTimeout?: (timer: unknown) => void;
	/** KIT_TIMEOUT_MS unless given. */
	timeoutMs?: number;
}

type Failure = { ok: false; reason: 'signed-out' | 'missing' | 'unreachable' };
/** unreachable: offline, a timeout, a 5xx or 403, or a body that is not a kit. */
export type KitAnswer = { ok: true; kit: StartKit } | Failure;
/** The library comes with the units when the body is one: the picker's copy, cached on start. */
export type UnitsAnswer = { ok: true; units: KitUnits; library?: ExerciseLibrary } | Failure;

const isKit = (body: unknown): body is StartKit => {
	const kit = body as Partial<StartKit> | null;
	return kit?.v === 1 && ['strength', 'run', 'other'].includes(kit.kind as string);
};

/** One bounded GET of a planned session's kit: the abort covers reading the body too. */
export async function fetchKit(lineage: string, options: KitOptions = {}): Promise<KitAnswer> {
	const answer = await fetchJson(startKitUrl(lineage), options);
	if (!answer.ok) return answer;
	return isKit(answer.body) ? { ok: true, kit: answer.body } : { ok: false, reason: 'unreachable' };
}

/** The owner's training-profile units, from the exercise library, bounded as a kit is. */
export async function fetchUnits(options: KitOptions = {}): Promise<UnitsAnswer> {
	const answer = await fetchJson(LIBRARY_URL, options);
	if (!answer.ok) return answer;
	const units = (answer.body as { units?: Partial<KitUnits> } | null)?.units;
	if (!isUnits(units)) return { ok: false, reason: 'unreachable' };
	const library = isLibrary(answer.body) ? { library: answer.body } : {};
	return { ok: true, units: { weight: units.weight, distance: units.distance }, ...library };
}

async function fetchJson(
	url: string,
	{
		fetch: request = (url, init) => fetch(url, init),
		setTimeout: later = (run, ms) => setTimeout(run, ms),
		clearTimeout: cancel = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
		timeoutMs = KIT_TIMEOUT_MS
	}: KitOptions = {}
): Promise<{ ok: true; body: unknown } | Failure> {
	const controller = new AbortController();
	const timer = later(() => controller.abort(), timeoutMs);
	try {
		const response = await request(url, {
			headers: { accept: 'application/json' },
			signal: controller.signal
		});
		if (!response.ok) {
			// Its body unread would keep the request open.
			void response.body?.cancel().catch(() => {});
			const reason =
				response.status === 401
					? 'signed-out'
					: response.status === 404
						? 'missing'
						: 'unreachable';
			return { ok: false, reason };
		}
		return { ok: true, body: (await response.json()) as unknown };
	} catch {
		return { ok: false, reason: 'unreachable' };
	} finally {
		cancel(timer);
	}
}

/** The workout in progress on this device, as the conflict shows it. */
export interface InProgress {
	workoutId: string;
	kind: SessionKind;
	title: string;
	startedAt: string;
	plannedLineage: string | null;
	/** Its workout.start's outbox entry while the server has not acknowledged it; null once synced. */
	startSeq: number | null;
}

export type StartOutcome =
	/** refresh: the workout started from a saved kit, whose fresh copy the workout page fetches. */
	| { status: 'started'; path: WorkoutPath; refresh?: string }
	| { status: 'conflict'; active: InProgress }
	/** not-saved: this browser refused the write (quota, private mode). */
	| { status: 'signed-out' | 'missing' | 'unreachable' | 'not-saved' };

export interface StartOptions extends KitOptions {
	store: WorkoutStore;
	/** Epoch ms on this device. */
	now?: () => number;
	persist?: () => Promise<boolean>;
}

/** The store the start flow writes through. /workout's table: every kind's start is core's. */
export const openStartStore = () => createStore({ table: strengthTable });

/** The device's calendar day at `ms`: an ad-hoc kit's date. */
export function localDay(ms: number): IsoDate {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export async function inProgress(store: WorkoutStore): Promise<InProgress | null> {
	const active = await store.getActive();
	if (!active) return null;
	const { workoutId, view } = active;
	const start = (await store.outbox()).find(
		({ envelope: m }) => m.type === 'workout.start' && m.workoutId === workoutId
	);
	const row = view?.workout;
	return {
		workoutId,
		kind: row?.kind ?? 'strength',
		title: row?.title || 'Workout',
		startedAt: row?.startedAt ?? '',
		plannedLineage: row?.plannedLineage ?? null,
		startSeq: start?.seq ?? null
	};
}

const conflicted = (active: InProgress): StartOutcome => ({ status: 'conflict', active });

/**
 * Creates the workout from its kit in one write, then asks for persistent storage. `fromSaved`: the
 * kit is this device's copy, so the outcome names the workout whose kit the workout page refreshes.
 */
async function begin(
	kit: StartKit,
	options: StartOptions,
	fromSaved = false
): Promise<StartOutcome> {
	const { store, now = Date.now, persist = () => requestPersistence() } = options;
	const workoutId = crypto.randomUUID();
	const at = now();
	const { kind, title, sessionType, discipline, plannedSessionId, plannedLineage, programId } = kit;
	const start = createMutation('workout.start', {
		workoutId,
		at: new Date(at).toISOString(),
		payload: { kind, title, sessionType, discipline, plannedSessionId, plannedLineage, programId }
	});
	let saved: Promise<WriteOutcome>;
	try {
		saved = store.dispatch(
			start,
			{ type: 'kit.attach', workoutId, kit },
			{ type: 'stopwatch.start', workoutId, at }
		).saved;
	} catch (error) {
		// Already in progress in this page's memory: the conflict, as IndexedDB holds it.
		const active = error instanceof Error && error.name === 'ActiveWorkoutError';
		const held = active ? await inProgress(store) : null;
		if (held) return conflicted(held);
		throw error;
	}
	const outcome = await saved;
	if (outcome === 'refused') {
		// Another tab started one first.
		const held = await inProgress(store);
		return held ? conflicted(held) : { status: 'not-saved' };
	}
	if (outcome !== 'saved') return { status: 'not-saved' };
	await persist();
	const path = workoutPath(kind);
	return fromSaved ? { status: 'started', path, refresh: workoutId } : { status: 'started', path };
}

/** A 401: the session is gone, so what the server holds leaves the device (sync.ts's rule). */
async function sessionLost(store: WorkoutStore): Promise<StartOutcome> {
	await store.purgeServerCopies();
	return { status: 'signed-out' };
}

/**
 * On a device a 401 marked signed out: asks the server first, so nothing held here shows before it
 * answers as the owner (any answer but a 401 or none). Null when the device is not marked.
 */
async function vouch<A extends KitAnswer | UnitsAnswer>(
	store: WorkoutStore,
	ask: () => Promise<A>
): Promise<{ answer: A; refused: StartOutcome | null } | null> {
	if (!(await store.signedOut())) return null;
	const answer = await ask();
	if (answer.ok || answer.reason === 'missing') {
		await store.signedIn();
		return { answer, refused: null };
	}
	const refused =
		answer.reason === 'signed-out' ? await sessionLost(store) : { status: 'signed-out' as const };
	return { answer, refused };
}

export async function startPlanned(lineage: string, options: StartOptions): Promise<StartOutcome> {
	const { store } = options;
	const saved = await store.getKit(lineage);
	const ask = () =>
		fetchKit(lineage, { ...options, timeoutMs: saved ? KIT_TIMEOUT_MS : UNSAVED_KIT_TIMEOUT_MS });
	const vouched = await vouch(store, ask);
	if (vouched?.refused) return vouched.refused;
	const held = await inProgress(store);
	if (held?.plannedLineage === lineage) return { status: 'started', path: workoutPath(held.kind) };
	if (held) return conflicted(held);
	// Saved: no wait on the network; the workout page refreshes it (kit-refresh.ts).
	if (saved && !vouched) return begin(saved, options, true);
	const answer = vouched?.answer ?? (await ask());
	if (!answer.ok && answer.reason === 'signed-out') return sessionLost(store);
	if (!answer.ok && answer.reason === 'missing') return { status: 'missing' };
	if (!answer.ok) return { status: 'unreachable' };
	await store.saveUnits(answer.kit.units);
	return begin(answer.kit, options);
}

/** deviceUnits: this device's display units, only when the server never gave the owner's. */
export async function startAdHoc(
	kind: AdhocKind,
	deviceUnits: KitUnits,
	options: StartOptions
): Promise<StartOutcome> {
	const { store, now = Date.now } = options;
	const vouched = await vouch(store, () => fetchUnits(options));
	if (vouched?.refused) return vouched.refused;
	const held = await inProgress(store);
	if (held) return conflicted(held);
	const answer = vouched?.answer ?? (await fetchUnits(options));
	if (!answer.ok && answer.reason === 'signed-out') return sessionLost(store);
	if (answer.ok) await store.saveUnits(answer.units);
	if (answer.ok && answer.library) await store.saveLibrary(answer.library);
	const units = answer.ok ? answer.units : ((await store.getUnits()) ?? deviceUnits);
	return begin(adhocKit(kind, units, localDay(now())), options);
}

/**
 * Discard, from the conflict: an unsynced workout leaves the device with every change in it; one
 * the server holds is abandoned. False when this browser could not save that.
 */
export async function discardInProgress(
	active: InProgress,
	{ store, now = Date.now }: Pick<StartOptions, 'store' | 'now'>
): Promise<boolean> {
	if (active.startSeq !== null) {
		await store.discard(active.startSeq);
		return true;
	}
	const abandon = createMutation('workout.abandon', {
		workoutId: active.workoutId,
		at: new Date(now()).toISOString(),
		payload: {}
	});
	return (await store.dispatch(abandon).saved) === 'saved';
}

/**
 * Saves each lineage's kit on this device, in turn, and the owner's units with it; the lineages
 * saved. A 401 is the session lost: it purges what was saved and stops.
 */
export async function saveKits(
	lineages: readonly string[],
	options: KitOptions & { store: WorkoutStore }
): Promise<string[]> {
	const saved: string[] = [];
	for (const lineage of lineages) {
		const answer = await fetchKit(lineage, options);
		if (!answer.ok && answer.reason === 'signed-out') {
			await sessionLost(options.store);
			return [];
		}
		if (!answer.ok) continue;
		await options.store.saveKit(lineage, answer.kit);
		await options.store.saveUnits(answer.kit.units);
		saved.push(lineage);
	}
	return saved;
}
