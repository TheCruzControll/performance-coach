/**
 * What the session screen renders on the server: one planned session of the active program by
 * its lineage (the key in /train/session/<lineage>, which every later version keeps), in words,
 * in the owner's units. Kept out of +page.server.ts so integration tests can run it with an
 * unreachable database.
 *
 * - `?v=n` reads version n: an older one is shown read-only, with the way to the current one.
 * - A malformed or unknown key or version is the 404 page in the shell. The route has no param
 *   matcher, which would cost every route JavaScript (docs/performance.md).
 * - It fails soft: a read that fails is recorded as a server error (kind 'load') and the screen
 *   shows its designed error with Retry, inside the shell, instead of the 500 page.
 * - The current version's session carries its edits: the days Move offers (getMoveTargets),
 *   from the owner's today (ownerToday), or why it can no longer change. An older version has
 *   none, being read-only.
 * - A session that can still change carries what Adjust steps (adjustValues): its set
 *   prescriptions, run segments or length and RPE, as stored, paces in the owner's unit.
 * - The current version's session carries its way into the workout (start-link.ts): Start
 *   workout, or Done · View to its newest workout's History detail; none once skipped. The screen
 *   swaps in Resume when it is the workout in progress on the device.
 * - A strength session that can still change also streams what Swap offers for each exercise
 *   (`swaps`, alternativesForExercises): the screen renders without waiting for it. A failure
 *   there is recorded and streams null, which the Swap sheet shows with Retry.
 */
import { error } from '@sveltejs/kit';
import type { DisciplineTone } from '#lib/domain/profile/catalog.ts';
import type { AthleteProfile } from '#lib/domain/profile/types.ts';
import { describeSegments, type RunStep } from '#lib/domain/training/describe.ts';
import type { SessionKind } from '#lib/domain/training/types.ts';
import { sessionTone, type SessionStatus } from '#lib/domain/training/vocabulary.ts';
import { ownerToday } from '#lib/server/local-date.ts';
import { recordServerError, type ServerErrorInput } from '#lib/server/services/errors.ts';
import { getAthleteProfile } from '#lib/server/services/profile/index.ts';
import { completedWorkoutIds } from '#lib/server/services/workouts/history.ts';
import {
	alternativesForExercises,
	getMoveTargets,
	getPlannedSession,
	type PlannedSession,
	type SessionExercise
} from '#lib/server/services/programs/index.ts';
import { TrainingNotFoundError, type TrainingDeps } from '#lib/server/services/training/shared.ts';
import {
	adjustValues,
	BASELINE_CALLOUT,
	detailsView,
	disciplineWords,
	EDITS_LOCKED,
	exerciseViews,
	moveOption,
	SWAPPED_ONCE,
	whenWords,
	type AdjustValues,
	type BaselineCallout,
	type DetailsView,
	type SessionEdits,
	type SessionExerciseView,
	type SwapOptions
} from '#lib/ui/program/session-words.ts';
import { startLink, type StartLink } from '#lib/ui/program/start-link.ts';
import { statusWords } from '#lib/ui/program/words.ts';

/**
 * A version number in ?v: a whole number from 1, as History links to it. Decision (m3 plan):
 * anything else names no version, so it is not found, as an unknown version is.
 */
const VERSION_PARAM = /^[1-9]\d{0,9}$/;

export const SESSION_ERROR = {
	title: 'Couldn’t load this session',
	description: 'Your plan is safe. Check your connection, then try again.'
} as const;

export interface SessionScreen {
	lineage: string;
	title: string;
	/** 'Tuesday 10 November · Evening'. */
	when: string;
	kind: SessionKind;
	/** 'Strength', 'Intervals', 'Muay Thai · Class'. */
	discipline: string;
	tone: DisciplineTone;
	status: SessionStatus;
	/** 'Skipped', 'Moved from Mon', 'Done'; none while planned. */
	statusWords: string | null;
	/** Start workout or Done · View on the current version; null on an older one or once skipped. */
	start: StartLink | null;
	/** A strength session in a baseline week: how to find each lift's starting point. */
	baseline: BaselineCallout | null;
	/** An older version: its number, and whether the current version still has the session. */
	older: { number: number; inCurrent: boolean } | null;
	details: DetailsView;
	/** A strength session's exercises; none for the other kinds. */
	exercises: SessionExerciseView[];
	/** A run's steps; none for the other kinds. */
	steps: RunStep[];
	instructions: string | null;
	notes: string | null;
	/** Its edits; none on an older version, which is read-only. */
	edits: SessionEdits | null;
	/** What Adjust steps while the session can still change; otherwise null. */
	adjust: AdjustValues | null;
	/**
	 * Streamed: what Swap offers for each exercise, or null if it could not be read. Null in
	 * place of the promise when nothing can be swapped: not a strength session, or no edits.
	 */
	swaps: Promise<SwapOptions | null> | null;
}

export type SessionDetailData =
	({ state: 'session' } & SessionScreen) | { state: 'error'; error: typeof SESSION_ERROR };

export interface SessionRequest {
	/** The route's key: a session's lineage, if well formed. */
	key: string;
	/** The ?v parameter as given. */
	version: string | null;
	/** When the request came in: the owner's today, in their time zone, follows from it. */
	now: Date;
	/** What a recorded failure carries: the request's id, method, path, route and app version. */
	origin: Pick<ServerErrorInput, 'requestId' | 'method' | 'path' | 'routeId' | 'appVersion'>;
}

export interface SessionLoadDeps extends Pick<TrainingDeps, 'db'> {
	/** Where a failure is recorded (app_errors): the app's database unless given. */
	errorsDb?: TrainingDeps['db'];
}

/** The session in words, in the owner's units. */
function screenOf(
	session: PlannedSession,
	{ weightUnit, distanceUnit }: Pick<AthleteProfile, 'weightUnit' | 'distanceUnit'>
): Omit<SessionScreen, 'edits' | 'adjust' | 'swaps' | 'start'> {
	const { version, week } = session;
	return {
		lineage: session.lineage,
		title: session.title,
		when: whenWords(session.date, session.timeOfDay),
		kind: session.kind,
		discipline: disciplineWords(session),
		tone: sessionTone(session.type),
		status: session.status,
		statusWords: statusWords(session),
		baseline: week.kind === 'baseline' && session.kind === 'strength' ? BASELINE_CALLOUT : null,
		older: version.current ? null : { number: version.number, inCurrent: session.inCurrentVersion },
		details: detailsView(session),
		// A from_e1rm load reads as its basis until a logged week 1 gives the estimate: no
		// estimate is passed, so describe never invents one (describe.ts).
		exercises:
			session.kind === 'strength'
				? exerciseViews(session.exercises, { unit: weightUnit, oneRepMaxKg: null }).map(
						(view, i): SessionExerciseView => {
							const planned = session.exercises[i]!;
							const once = planned.substitutionReason === 'situational';
							return { ...view, lineage: planned.lineage, swapped: once ? SWAPPED_ONCE : null };
						}
					)
				: [],
		steps: session.kind === 'run' ? describeSegments(session.segments, { distanceUnit }) : [],
		instructions: session.instructions,
		notes: session.notes ?? (session.kind === 'other' ? session.details.notes : null)
	};
}

/**
 * The current version's edits on the owner's today: Move's days for a session dated today or
 * later, as the edit services allow it; otherwise why it stays as it is.
 */
async function editsOf(
	ownerId: string,
	session: PlannedSession,
	now: Date,
	db: TrainingDeps['db']
): Promise<SessionEdits> {
	const today = await ownerToday(ownerId, now, { db });
	const locked =
		session.status === 'completed'
			? EDITS_LOCKED.completed
			: session.status === 'skipped'
				? EDITS_LOCKED.skipped
				: session.date < today
					? EDITS_LOCKED.passed
					: null;
	const moveTo = locked ? [] : await getMoveTargets(ownerId, session.lineage, today, { db });
	return { version: session.version.number, locked, moveTo: moveTo.map(moveOption) };
}

/** Its way into the workout (start-link.ts), with the workout a completed one opens. */
async function startOf(
	ownerId: string,
	session: PlannedSession,
	db: TrainingDeps['db']
): Promise<StartLink | null> {
	if (session.status !== 'completed') return startLink(session);
	const found = await completedWorkoutIds(ownerId, [session.lineage], { db });
	return startLink(session, found[session.lineage]);
}

/**
 * What Swap offers for each of `exercises`, as the sheet needs it (no catalogue row), or null,
 * with the failure recorded, when it cannot be read.
 */
async function swapOptions(
	ownerId: string,
	exercises: readonly SessionExercise[],
	origin: SessionRequest['origin'],
	{ db, errorsDb }: SessionLoadDeps
): Promise<SwapOptions | null> {
	try {
		const found = await alternativesForExercises(ownerId, exercises, { db });
		const options: SwapOptions = {};
		for (const [lineage, { alternatives, blocked }] of found) {
			options[lineage] = {
				alternatives: alternatives.map(({ id, name, reason }) => ({ id, name, reason })),
				blocked
			};
		}
		return options;
	} catch (err) {
		await recordServerError(
			{ error: err, kind: 'load', status: 500, ...origin, context: { load: 'session-swaps' } },
			{ db: errorsDb }
		);
		return null;
	}
}

export async function loadSessionDetail(
	ownerId: string,
	{ key, version, now, origin }: SessionRequest,
	{ db, errorsDb }: SessionLoadDeps = {}
): Promise<SessionDetailData> {
	if (version !== null && !VERSION_PARAM.test(version)) error(404, 'Not found');
	try {
		const asked = version === null ? undefined : Number(version);
		const session = await getPlannedSession(ownerId, key, { version: asked }, { db });
		const profile = await getAthleteProfile(ownerId, { db });
		const edits = session.version.current ? await editsOf(ownerId, session, now, db) : null;
		const start = edits ? await startOf(ownerId, session, db) : null;
		// Started last, once the load's own reads are done: it runs while the screen streams.
		const swaps =
			edits && !edits.locked && session.kind === 'strength'
				? swapOptions(ownerId, session.exercises, origin, { db, errorsDb })
				: null;
		const adjust = edits && !edits.locked ? adjustValues(session, profile) : null;
		return { state: 'session', ...screenOf(session, profile), start, edits, adjust, swaps };
	} catch (err) {
		if (err instanceof TrainingNotFoundError) error(404, 'Not found');
		await recordServerError(
			{ error: err, kind: 'load', status: 500, ...origin, context: { load: 'session' } },
			{ db: errorsDb }
		);
		return { state: 'error', error: SESSION_ERROR };
	}
}
