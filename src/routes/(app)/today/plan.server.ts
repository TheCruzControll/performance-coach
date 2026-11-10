/**
 * Today's plan once a program exists: the week on the WeekStrip with each day's sessions (today
 * selected), 'Up next' (the next UP_NEXT_LIMIT sessions after today, across weeks), and the
 * states a day can be in: a rest day naming the next session, a program that starts later
 * ('Starts Monday', week 1 shown), or a finished first block with nothing planned yet, until M6
 * plans the next one. Words are composed here, with the data they describe, so the panel ships
 * none of the vocabulary. Kept out of +page.server.ts so integration tests can run it with an
 * unreachable database.
 *
 * It is streamed, and it fails soft: a read that fails is recorded as a server error (kind
 * 'streamed', as Profile's are) and resolves to {failed: true}, which the panel shows as a
 * designed error with Retry.
 */
import { daysBetween, weekdayOf, type IsoDate } from '#lib/domain/calendar.ts';
import { WEEKDAY_INFO } from '#lib/domain/profile/catalog.ts';
import type { SessionView } from '#lib/domain/training/types.ts';
import { recordServerError } from '#lib/server/services/errors.ts';
import {
	getCurrentProgram,
	getTodayPlan,
	getTrainingWeek
} from '#lib/server/services/programs/index.ts';
import { completedWorkoutIds } from '#lib/server/services/workouts/history.ts';
import { startLink, type StartLink } from '#lib/ui/program/start-link.ts';
import {
	cardView,
	longDate,
	shortDate,
	stripDay,
	type CardView,
	type StripDayView
} from '#lib/ui/program/words.ts';
import type { SetupDeps, SetupOrigin } from './setup.server';

/**
 * A session as a card, by lineage; `baseline` on a strength session of a baseline week. Today's
 * sessions carry their way into the workout (start-link.ts): Start workout, or Done · View to
 * the History detail of the workout done; every other day's, none.
 */
export type PlanCard = CardView & {
	lineage: string;
	baseline: boolean;
	start: StartLink | null;
};

export interface PlanDay {
	date: IsoDate;
	/** 'Thursday 5 November'. */
	heading: string;
	cards: PlanCard[];
	/** With no sessions: recovery is part of the plan, and the next session, across weeks. */
	rest: string | null;
}

export interface PlanWeek {
	/** The strip's accessible name: 'Week 1'. */
	label: string;
	/** The owner's today when it is in this week (the strip rings it), else null. */
	today: IsoDate | null;
	/** The day selected at first: today, or the program's first day before it starts. */
	selected: IsoDate;
	strip: StripDayView[];
	days: PlanDay[];
}

/** A state's card: 'Starts Monday', or 'Nothing planned yet'. */
export interface PlanNote {
	title: string;
	description: string;
}

export type TodayPlanView =
	| { failed: true }
	| {
			failed: false;
			/** Null once the first block is complete: no week is planned. */
			week: PlanWeek | null;
			starts: PlanNote | null;
			complete: PlanNote | null;
			/** 'Tomorrow', 'Wednesday' or 'Mon 16 Nov' says when each is. */
			upNext: (PlanCard & { when: string })[];
	  };

/** 'tomorrow', a weekday within the coming six days ('Wednesday'), else 'Mon 16 Nov'. */
function dayWords(date: IsoDate, from: IsoDate): string {
	const ahead = daysBetween(from, date);
	if (ahead === 1) return 'tomorrow';
	return ahead > 1 && ahead < 7 ? WEEKDAY_INFO[weekdayOf(date)].label : shortDate(date);
}

const card = (session: SessionView, baselineWeek: boolean): PlanCard => ({
	...cardView(session),
	lineage: session.lineage,
	baseline: baselineWeek && session.kind === 'strength',
	start: null
});

async function readPlan(
	ownerId: string,
	today: IsoDate,
	db: SetupDeps['db']
): Promise<TodayPlanView> {
	// One query at a time on the one handle (docs/architecture.md).
	const plan = await getTodayPlan(ownerId, today, { db });
	// loadTodayProgram found the program a moment ago; only a concurrent archive removes it.
	if (!plan) throw new Error('the active program disappeared while Today loaded');
	const upNext = plan.upNext.map((s) => {
		const when = dayWords(s.date, today);
		return { ...card(s, false), when: when[0]!.toUpperCase() + when.slice(1) };
	});
	if (plan.blockComplete) {
		const program = await getCurrentProgram(ownerId, today, { db });
		if (!program) throw new Error('the active program disappeared while Today loaded');
		const { firstPlannedDay, lastPlannedDay } = program;
		return {
			failed: false,
			week: null,
			starts: null,
			complete: {
				title: 'Nothing planned yet',
				description: `You trained through every planned week, ${shortDate(firstPlannedDay)} – ${shortDate(lastPlannedDay)}. Your next block is planned from how this one went.`
			},
			upNext
		};
	}
	const selected = plan.startsOn ?? today;
	const week = await getTrainingWeek(ownerId, { date: selected }, {}, { db });
	if (!week?.planned) throw new Error(`no planned week holds ${selected}`);
	const baseline = week.kind === 'baseline';
	const later = [...week.days.flatMap((d) => d.sessions), ...plan.upNext];
	const inWeek = week.startsOn <= today && today <= week.endsOn ? today : null;
	const todays = week.days.find((d) => d.date === inWeek)?.sessions ?? [];
	const done = await completedWorkoutIds(
		ownerId,
		todays.filter((s) => s.status === 'completed').map((s) => s.lineage),
		{ db }
	);
	return {
		failed: false,
		week: {
			label: `Week ${week.number}`,
			today: inWeek,
			selected,
			strip: week.days.map((day) => stripDay(day, inWeek)),
			days: week.days.map((day) => {
				const next = later.find((s) => s.date > day.date);
				return {
					date: day.date,
					heading: longDate(day.date),
					cards: day.sessions.map((s) => ({
						...card(s, baseline),
						start: day.date === inWeek ? startLink(s, done[s.lineage]) : null
					})),
					rest: day.sessions.length
						? null
						: next
							? `Recovery is part of the plan. Next: ${next.title}, ${dayWords(next.date, day.date)}.`
							: 'Recovery is part of the plan. Nothing else is planned yet.'
				};
			})
		},
		starts: plan.startsOn
			? {
					title: `Starts ${WEEKDAY_INFO[weekdayOf(plan.startsOn)].label}`,
					description: `Week 1 begins ${longDate(plan.startsOn)}${upNext[0] ? `. First up: ${upNext[0].title}` : ''}.`
				}
			: null,
		complete: null,
		upNext
	};
}

/**
 * Today's plan at the owner's `today` (ownerToday, read once per request by loadTodayProgram),
 * for +page.server.ts to stream. Never rejects.
 */
export function loadTodayPlan(
	ownerId: string,
	{ today, origin }: { today: IsoDate; origin: SetupOrigin },
	{ db, errorsDb }: SetupDeps = {}
): Promise<TodayPlanView> {
	return readPlan(ownerId, today, db).catch(async (error: unknown) => {
		await recordServerError(
			{ error, kind: 'streamed', status: 500, ...origin, context: { load: 'todayPlan' } },
			{ db: errorsDb }
		);
		return { failed: true } as const;
	});
}
