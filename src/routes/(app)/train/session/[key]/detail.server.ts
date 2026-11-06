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
 */
import { error } from '@sveltejs/kit';
import type { DisciplineTone } from '#lib/domain/profile/catalog.ts';
import type { AthleteProfile } from '#lib/domain/profile/types.ts';
import { describeSegments, type RunStep } from '#lib/domain/training/describe.ts';
import type { SessionKind } from '#lib/domain/training/types.ts';
import { sessionTone, type SessionStatus } from '#lib/domain/training/vocabulary.ts';
import { recordServerError, type ServerErrorInput } from '#lib/server/services/errors.ts';
import { getAthleteProfile } from '#lib/server/services/profile/index.ts';
import { getPlannedSession, type PlannedSession } from '#lib/server/services/programs/index.ts';
import { TrainingNotFoundError, type TrainingDeps } from '#lib/server/services/training/shared.ts';
import {
	BASELINE_CALLOUT,
	detailsView,
	disciplineWords,
	exerciseViews,
	whenWords,
	type BaselineCallout,
	type DetailsView,
	type ExerciseView
} from '#lib/ui/program/session-words.ts';
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
	/** A strength session in a baseline week: how to find each lift's starting point. */
	baseline: BaselineCallout | null;
	/** An older version: its number, and whether the current version still has the session. */
	older: { number: number; inCurrent: boolean } | null;
	details: DetailsView;
	/** A strength session's exercises; none for the other kinds. */
	exercises: ExerciseView[];
	/** A run's steps; none for the other kinds. */
	steps: RunStep[];
	instructions: string | null;
	notes: string | null;
}

export type SessionDetailData =
	({ state: 'session' } & SessionScreen) | { state: 'error'; error: typeof SESSION_ERROR };

export interface SessionRequest {
	/** The route's key: a session's lineage, if well formed. */
	key: string;
	/** The ?v parameter as given. */
	version: string | null;
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
): SessionScreen {
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
				? exerciseViews(session.exercises, { unit: weightUnit, oneRepMaxKg: null })
				: [],
		steps: session.kind === 'run' ? describeSegments(session.segments, { distanceUnit }) : [],
		instructions: session.instructions,
		notes: session.notes ?? (session.kind === 'other' ? session.details.notes : null)
	};
}

export async function loadSessionDetail(
	ownerId: string,
	{ key, version, origin }: SessionRequest,
	{ db, errorsDb }: SessionLoadDeps = {}
): Promise<SessionDetailData> {
	if (version !== null && !VERSION_PARAM.test(version)) error(404, 'Not found');
	try {
		const asked = version === null ? undefined : Number(version);
		const session = await getPlannedSession(ownerId, key, { version: asked }, { db });
		const profile = await getAthleteProfile(ownerId, { db });
		return { state: 'session', ...screenOf(session, profile) };
	} catch (err) {
		if (err instanceof TrainingNotFoundError) error(404, 'Not found');
		await recordServerError(
			{ error: err, kind: 'load', status: 500, ...origin, context: { load: 'session' } },
			{ db: errorsDb }
		);
		return { state: 'error', error: SESSION_ERROR };
	}
}
