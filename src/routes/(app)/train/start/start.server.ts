/**
 * Train's Start date screen (+page.server.ts): when week 1 of the program starts, and moving it
 * (owner decision 2026-11-12; the rules are domain/programming/start-move.ts's, the move
 * services/programming/move.ts's). Kept out of +page.server.ts so integration tests can run it
 * with an unreachable database.
 *
 * - Until onboarding is complete no program can exist (a build refuses it), so the screen says
 *   what comes first and links to Today's setup card; with no program, to Today's Build.
 * - A start that can no longer move says why, with the day week 1 began.
 * - Otherwise the starts the move offers, in words: 'This week' (from today) and the next Mondays,
 *   the current one marked, and a Monday after a dated goal's event says the event would no longer
 *   be planned for. Words are composed here, so they cost the screen no JavaScript.
 * - ?/move posts the start and the version it was chosen on as plain fields, so it works before
 *   JavaScript runs. It answers the toast's words and Train's path; a refusal comes back as the
 *   program forms' failures (400 with the field's error, 409 with the conflict's reason).
 * - It fails soft: a read that fails is recorded as a server error (kind 'load') and the screen
 *   shows its designed error with Try again, inside the shell, instead of the 500 page.
 */
import type { IsoDate } from '#lib/domain/calendar.ts';
import { localDay } from '#lib/domain/dates.ts';
import { eventsSkipped, type StartChoice } from '#lib/domain/programming/start-move.ts';
import { programFieldsAction } from '#lib/server/forms/program.ts';
import { ownerToday } from '#lib/server/local-date.ts';
import { recordServerError, type ServerErrorInput } from '#lib/server/services/errors.ts';
import { getAthleteProfile, listGoals } from '#lib/server/services/profile/index.ts';
import {
	getStartMove,
	moveProgramStart,
	type ProgrammingDeps
} from '#lib/server/services/programming/index.ts';
import type { IconName } from '#lib/ui/icons/icons.ts';
import { longDate, shortDate } from '#lib/ui/program/words.ts';

/** A state the screen shows as an EmptyState, with the one next step under it. */
export interface StartCard {
	id: 'start-setup' | 'start-none' | 'start-fixed' | 'start-error';
	icon: IconName;
	tone: 'accent' | 'neutral' | 'combat';
	title: string;
	description: string;
	/** Where its next step goes; 'retry' loads the screen again. */
	next: { label: string; to: 'today' | 'train' | 'retry' };
}

export interface StartOption {
	value: StartChoice['value'];
	label: string;
	hint?: string;
}

export type StartPageData =
	| { state: 'card'; card: StartCard }
	| {
			state: 'open';
			/** The version the move is made on. */
			version: number;
			/** 'Week 1 starts Monday 23 November.' */
			current: string;
			options: StartOption[];
			/** The option keeping the current start, if one does; else none is picked. */
			chosen: StartChoice['value'] | null;
	  };

export interface StartRequest {
	now: Date;
	origin: Pick<ServerErrorInput, 'requestId' | 'method' | 'path' | 'routeId' | 'appVersion'>;
}

export interface StartLoadDeps extends Pick<ProgrammingDeps, 'db'> {
	/** Where a failure is recorded (app_errors): the app's database unless given. */
	errorsDb?: ProgrammingDeps['db'];
}

export const SETUP_CARD: StartCard = {
	id: 'start-setup',
	icon: 'profile',
	tone: 'accent',
	title: 'Finish setting up first',
	description:
		'Your program is planned from your goals, schedule and baselines, and it starts only once your setup is done.',
	next: { label: 'Finish setting up', to: 'today' }
};

export const NO_PROGRAM_CARD: StartCard = {
	id: 'start-none',
	icon: 'train',
	tone: 'accent',
	title: 'No program yet',
	description: 'Build your program on Today. You can move its start here until you begin training.',
	next: { label: 'Build my program', to: 'today' }
};

export const START_ERROR_CARD: StartCard = {
	id: 'start-error',
	icon: 'alert',
	tone: 'combat',
	title: 'Couldn’t load your start date',
	description: 'Your plan is safe. Check your connection, then try again.',
	next: { label: 'Try again', to: 'retry' }
};

/** The start can no longer move: since when week 1 has run, and why it stays. */
export function fixedCard(reason: 'started' | 'logged', firstPlannedDay: IsoDate): StartCard {
	return {
		id: 'start-fixed',
		icon: 'clock',
		tone: 'neutral',
		title: 'Your program has started',
		description:
			reason === 'logged'
				? `You’ve logged training on it, so week 1 stays on ${longDate(firstPlannedDay)}: what you did keeps its place in the plan.`
				: `Week 1 began ${longDate(firstPlannedDay)}. Its weeks hold your training so far, so the start stays where it is.`,
		next: { label: 'Back to Train', to: 'train' }
	};
}

/** The dated events of open goals: what a later start would leave out. */
async function datedEvents(ownerId: string, db: StartLoadDeps['db']) {
	const goals = await listGoals(ownerId, { db });
	return goals.flatMap((g) =>
		g.kind === 'event' && g.eventDate && g.status === 'active' && g.priority !== null
			? [{ title: g.title, date: g.eventDate }]
			: []
	);
}

export async function loadStart(
	ownerId: string,
	{ now, origin }: StartRequest,
	{ db, errorsDb }: StartLoadDeps = {}
): Promise<StartPageData> {
	try {
		const profile = await getAthleteProfile(ownerId, { db });
		if (!profile.onboarding.completedAt) return { state: 'card', card: SETUP_CARD };
		const today = localDay(now, profile.timeZone);
		const move = await getStartMove(ownerId, today, { db });
		if (!move) return { state: 'card', card: NO_PROGRAM_CARD };
		if (move.refusal) {
			return { state: 'card', card: fixedCard(move.refusal, move.current.firstPlannedDay) };
		}
		const events = await datedEvents(ownerId, db);
		const options = move.choices.map((c): StartOption => {
			const label =
				c.value === 'this_week'
					? 'This week'
					: c.startsOn === today
						? `Today, ${shortDate(c.startsOn)}`
						: shortDate(c.startsOn);
			const skipped = eventsSkipped(c, today, events);
			const hint =
				c.value === move.currentValue
					? 'Your current start'
					: skipped.length
						? `After ${skipped.map((e) => `${e.title} (${shortDate(e.date)})`).join(', ')}: no longer planned for`
						: c.value === 'this_week'
							? `From today, ${shortDate(today)}`
							: undefined;
			return { value: c.value, label, ...(hint && { hint }) };
		});
		return {
			state: 'open',
			version: move.version,
			current: `Week 1 starts ${longDate(move.current.firstPlannedDay)}.`,
			options,
			chosen: move.currentValue
		};
	} catch (error) {
		await recordServerError(
			{ error, kind: 'load', status: 500, ...origin, context: { load: 'trainStart' } },
			{ db: errorsDb }
		);
		return { state: 'card', card: START_ERROR_CARD };
	}
}

/** What a move answers: the toast's words and where to go next (Train). */
export interface MovedAnswer {
	words: string;
	href: string;
	firstPlannedDay: IsoDate;
}

/** The Start date screen's actions, on the app's database unless `deps` says. */
export function startActions(deps: Pick<ProgrammingDeps, 'db' | 'now' | 'catalogue'> = {}) {
	return {
		/** Move the start to the posted one, as the next version of the version posted. */
		move: programFieldsAction(async (owner, form): Promise<MovedAnswer> => {
			const today = await ownerToday(owner, deps.now?.() ?? new Date(), { db: deps.db });
			const version = Number(form.get('version'));
			const moved = await moveProgramStart(
				owner,
				{ today, baseVersionNumber: version, start: form.get('start') ?? undefined },
				deps
			);
			return {
				words: `Start moved to ${shortDate(moved.firstPlannedDay)} · version ${moved.number}`,
				href: '/train',
				firstPlannedDay: moved.firstPlannedDay
			};
		})
	};
}
