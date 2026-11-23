/**
 * What the resume line (ResumeBar.svelte) offers, and its words (lineFor), decided in plain .ts so
 * they are unit-tested:
 * - active: the workout in progress on this device (the probe), 'Resume {title}'
 * - waiting: no workout in progress, but changes of a finished one still to sync,
 *   'N changes waiting to sync'
 * - remote: on Today only, online, with nothing held on this device: the newest workout in
 *   progress on another device (GET /api/workouts/active), '{title} is in progress on another
 *   device' and 'Continue here'
 * - none: nothing to offer
 * The probe never creates 'pc-offline', so a device that never started a workout keeps none.
 * Everything else here (the store, reconcile, the sync engine) loads only when it is needed: the
 * engine while changes are pending, the store and reconcile on 'Continue here'.
 */
import { activeSummary, pendingCount, type ActiveSummary } from '#lib/client/workout/probe.ts';
import type { ActiveWorkout, ActiveWorkouts } from '#lib/domain/workout/index.ts';

/**
 * Owner decision: the one screen that asks the server for a workout started on another device.
 * Today is where a session begins, and every other tab stays free of the request; add paths here
 * to offer 'Continue here' elsewhere.
 */
export const REMOTE_CHECK_PATHS: readonly string[] = ['/today'];

export const ACTIVE_WORKOUTS_URL = '/api/workouts/active';

/** The remote check gives up after this long and offers nothing: Today never waits on it. */
export const REMOTE_TIMEOUT_MS = 10_000;

export type Resume =
	| { type: 'none' }
	| { type: 'active'; workout: ActiveSummary }
	| { type: 'waiting'; pending: number }
	| { type: 'remote'; workout: ActiveWorkout };

export const NOTHING: Resume = Object.freeze({ type: 'none' });

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ResumeOptions {
	fetch?: Fetch;
	/** navigator.onLine by default. */
	online?: () => boolean;
	setTimeout?: (run: () => void, ms: number) => unknown;
	clearTimeout?: (timer: unknown) => void;
}

const defaults = ({
	fetch: request = (url, init) => fetch(url, init),
	online = () => globalThis.navigator?.onLine ?? true,
	setTimeout: later = (run, ms) => setTimeout(run, ms),
	clearTimeout: cancel = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
}: ResumeOptions) => ({ request, online, later, cancel });

/** Whether a resume offer has changes for the sync engine to send from this screen. */
export const hasPending = (resume: Resume): boolean =>
	resume.type === 'waiting' || (resume.type === 'active' && resume.workout.pending > 0);

/** The newest workout in progress on the server; null offline, on a failure or a timeout. */
async function newestRemote(options: ResumeOptions): Promise<ActiveWorkout | null> {
	const { request, later, cancel } = defaults(options);
	const controller = new AbortController();
	const timer = later(() => controller.abort(), REMOTE_TIMEOUT_MS);
	try {
		const response = await request(ACTIVE_WORKOUTS_URL, {
			headers: { accept: 'application/json' },
			signal: controller.signal
		});
		if (!response.ok) {
			void response.body?.cancel().catch(() => {});
			return null;
		}
		const body = (await response.json()) as Partial<ActiveWorkouts> | null;
		return body?.v === 1 && Array.isArray(body.workouts) ? (body.workouts[0] ?? null) : null;
	} catch {
		return null;
	} finally {
		cancel(timer);
	}
}

/** What the bar offers on `pathname`: one IndexedDB read or two, and on Today one request. */
export async function findResume(pathname: string, options: ResumeOptions = {}): Promise<Resume> {
	const active = await activeSummary();
	if (active) return { type: 'active', workout: active };
	const pending = await pendingCount();
	if (pending > 0) return { type: 'waiting', pending };
	if (!REMOTE_CHECK_PATHS.includes(pathname) || !defaults(options).online()) return NOTHING;
	const workout = await newestRemote(options);
	return workout ? { type: 'remote', workout } : NOTHING;
}

/**
 * 'Continue here': the other device's workout is built on this one from its rows and pinned kit
 * (reconcile.ts adoptRemote), so its page opens with its sets.
 * - opened: it is here now, or another workout already is (its page shows that one)
 * - gone: it was finished or abandoned meanwhile
 * - failed: offline, a failed request, or a browser that cannot keep a workout
 */
export type ContinueOutcome = 'opened' | 'gone' | 'failed';

export async function continueHere(
	workoutId: string,
	options: Omit<ResumeOptions, 'setTimeout' | 'clearTimeout'> = {}
): Promise<ContinueOutcome> {
	try {
		const { createStore } = await import('#lib/client/workout/store.ts');
		const { createReconciler } = await import('#lib/client/workout/reconcile.ts');
		const { strengthTable } = await import('#lib/domain/workout/reducers/tables.ts');
		// The workout records the store writes are the same whatever the table: it projects only
		// to read their headers, which every table's core reducers give (as the start flow does).
		const store = await createStore({ table: strengthTable });
		const { fetch, online } = options;
		const outcome = await createReconciler({ store, fetch, online }).adoptRemote(workoutId);
		if (outcome === 'adopted' || outcome === 'held' || outcome === 'refused') return 'opened';
		return outcome === 'missing' || outcome === 'ended' ? 'gone' : 'failed';
	} catch {
		return 'failed';
	}
}

/** Where 'Continue here' stands: on the way, or failed (the line says so and offers Try again). */
export interface Continuing {
	continuing: boolean;
	failed: boolean;
}

/**
 * The 'Continue here' button, for the line and for Today's hero (v2/06): builds the workout here,
 * then opens `href` (its kind's page); `flags` follow it. Resolves to the outcome, or null when
 * one was already on its way.
 */
export async function continueHereFlow(
	workoutId: string,
	href: string,
	{
		goto,
		flags,
		adopt = continueHere
	}: { goto: (href: string) => Promise<unknown>; flags: Continuing; adopt?: typeof continueHere }
): Promise<ContinueOutcome | null> {
	if (flags.continuing) return null;
	flags.continuing = true;
	flags.failed = false;
	const outcome = await adopt(workoutId);
	flags.continuing = false;
	if (outcome === 'opened') await goto(href);
	else if (outcome === 'failed') flags.failed = true;
	return outcome;
}

/**
 * The resume line's words, in three parts: the workout's title, where the line names one, sits
 * between `before` and `after`. The line draws the title from its position, never by searching
 * for it, so a title that repeats words of the line (a workout named "Resume") lands where it is.
 */
export interface ResumeLine {
	/** The words before the title; all of the line where it names no workout. */
	before: string;
	/** The workout's title, where the line names one. */
	title: string | null;
	/** The words after the title. */
	after: string;
	/** The line is the one red on the screen: 'Continue here' failed. */
	danger: boolean;
}

/** What the line says for `resume` (none: nothing); `failed` after a failed 'Continue here'. */
export function lineFor(resume: Resume, failed = false): ResumeLine {
	switch (resume.type) {
		case 'active':
			return { before: 'Resume ', title: resume.workout.title, after: '', danger: false };
		case 'waiting': {
			const changes = resume.pending === 1 ? 'change' : 'changes';
			return {
				before: `${resume.pending} ${changes} waiting to sync`,
				title: null,
				after: '',
				danger: false
			};
		}
		case 'remote':
			return failed
				? { before: 'Couldn’t continue it here', title: null, after: '', danger: true }
				: {
						before: '',
						title: resume.workout.title,
						after: ' is in progress on another device',
						danger: false
					};
		default:
			return { before: '', title: null, after: '', danger: false };
	}
}

/**
 * What the line shows on `pathname`: a screen that claims the workout in progress (Today's hero,
 * v2/06) draws it itself, so there the line keeps only changes waiting to sync.
 */
export const shownFor = (resume: Resume, claimed: string | null, pathname: string): Resume =>
	claimed === pathname && resume.type !== 'waiting' ? NOTHING : resume;

/**
 * Starts this screen's sync engine (online.ts), so changes waiting sync from whichever tab the
 * owner is on; resolves to its stop, or to nothing when the browser cannot keep a workout.
 */
export async function syncFromHere(): Promise<(() => void) | null> {
	try {
		const { goOnline } = await import('#lib/client/workout/online.ts');
		const { strengthTable } = await import('#lib/domain/workout/reducers/tables.ts');
		return (await goOnline({ table: strengthTable })).stop;
	} catch {
		return null;
	}
}
