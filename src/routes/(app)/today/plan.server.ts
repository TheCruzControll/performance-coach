/**
 * Today's plan once a program exists: the week on the WeekStrip with each day's sessions (today
 * selected), 'Up next' (the next UP_NEXT_LIMIT sessions after today, across weeks), and the
 * states a day can be in: a rest day naming the next session, a program that starts later
 * ('Starts Monday', week 1 shown), a finished first block with nothing planned yet, until M6
 * plans the next one, or a bridge week between blocks (M6's late start), which names the day the
 * next block starts instead of seven rest days. When a week or a block completes, its review
 * prompt (progress/review-prompt.server.ts) comes with the plan. Words are composed here, with the data they
 * describe, so the panel ships none of the vocabulary. Kept out of +page.server.ts so integration
 * tests can run it with an unreachable database.
 *
 * It is streamed, and it fails soft: a read that fails is recorded as a server error (kind
 * 'streamed', as Profile's are) and resolves to {failed: true}, which the panel shows as a
 * designed error with Retry.
 *
 * It reads from the program loadTodayProgram found, so the week it shows (today's, or week 1's
 * before the start) is known at once: the plan and that week are read together, each service on
 * its own pool connection (docs/architecture.md). So its `db` is the pool, never a transaction.
 * The review prompt is read once the plan is in, so a plan that fails records only its own error.
 * So is a light or special week's kind line, beside the prompt, as Train's header has it (m7/38,
 * services/periodisation/week-line.ts): a read that fails is recorded and the plan shows without.
 */
import { daysBetween, weekdayOf, type IsoDate } from '#lib/domain/calendar.ts';
import { WEEKDAY_INFO } from '#lib/domain/profile/catalog.ts';
import type { SessionView } from '#lib/domain/training/types.ts';
import { recordServerError } from '#lib/server/services/errors.ts';
import { getWeekLine } from '#lib/server/services/periodisation/week-line.ts';
import { listGoals } from '#lib/server/services/profile/index.ts';
import {
	getTodayPlan,
	getTrainingWeek,
	type CurrentProgram,
	type TodayPlan
} from '#lib/server/services/programs/index.ts';
import { completedWorkoutIds } from '#lib/server/services/workouts/history.ts';
import type { ReviewPromptView } from '#lib/ui/analytics/review-prompt.ts';
import { startLink, type StartLink } from '#lib/ui/program/start-link.ts';
import {
	cardView,
	longDate,
	shortDate,
	stripDay,
	type CardView,
	type StripDayView
} from '#lib/ui/program/words.ts';
import { loadReviewPrompt } from '../progress/review-prompt.server';
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

/** A state's card: 'Starts Monday', 'Nothing planned yet' or 'Between blocks'. */
export interface PlanNote {
	title: string;
	description: string;
}

export interface ReadyPlan {
	failed: false;
	/** The owner's today: what the coming days' kits count from (coming-kits.ts). */
	today: IsoDate;
	/** Null once the first block is complete or in a bridge week: no session is planned. */
	week: PlanWeek | null;
	starts: PlanNote | null;
	complete: PlanNote | null;
	/** In a bridge week between blocks, in place of the week: when the next block starts. */
	bridge?: PlanNote;
	/** 'Tomorrow', 'Wednesday' or 'Mon 16 Nov' says when each is, on `date`. */
	upNext: (PlanCard & { when: string; date: IsoDate })[];
	/**
	 * A week or block to review, or its review once written (review-prompt.server.ts), at the
	 * top; null with none, or when its read failed (recorded: the plan shows without it).
	 */
	review: ReviewPromptView | null;
	/**
	 * The week's kind and why, with any countdown in the why ('Deload week', 'Deload in week 4 ·
	 * Marathon in 18 days'); null for a week of another kind, or when its read failed (recorded).
	 */
	weekKind: { label: string; why: string } | null;
}

export type TodayPlanView = { failed: true } | ReadyPlan;

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
	program: CurrentProgram,
	db: SetupDeps['db']
): Promise<Omit<ReadyPlan, 'review' | 'weekKind'>> {
	const upNextOf = (plan: TodayPlan) =>
		plan.upNext.map((s) => {
			const when = dayWords(s.date, today);
			return { ...card(s, false), when: when[0]!.toUpperCase() + when.slice(1), date: s.date };
		});
	if (program.blockComplete) {
		const plan = await getTodayPlan(ownerId, today, { db });
		// loadTodayProgram found the program a moment ago; only a concurrent archive removes it.
		if (!plan) throw new Error('the active program disappeared while Today loaded');
		const { firstPlannedDay, lastPlannedDay } = program;
		return {
			failed: false,
			today,
			week: null,
			starts: null,
			complete: {
				title: 'Nothing planned yet',
				description: `You trained through every planned week, ${shortDate(firstPlannedDay)} – ${shortDate(lastPlannedDay)}. Your next block is planned from how this one went.`
			},
			upNext: upNextOf(plan)
		};
	}
	const selected = program.notStarted ? program.firstPlannedDay : today;
	// Two services together, each on its own pool connection; inside each, one query at a time.
	const [plan, week] = await Promise.all([
		getTodayPlan(ownerId, today, { db }),
		getTrainingWeek(ownerId, { date: selected }, {}, { db })
	]);
	if (!plan) throw new Error('the active program disappeared while Today loaded');
	if (!week?.planned) throw new Error(`no planned week holds ${selected}`);
	const upNext = upNextOf(plan);
	if (week.nextBlockStartsOn) {
		const description = `Your next block starts ${shortDate(week.nextBlockStartsOn)}. Nothing is planned until then: what you log counts as off-plan.`;
		const bridge = { title: 'Between blocks', description };
		return { failed: false, today, week: null, starts: null, complete: null, bridge, upNext };
	}
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
		today,
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

/** The kind line of the week shown, in words: its why, then any countdown. */
async function readWeekKind(
	ownerId: string,
	{ today, program, week }: { today: IsoDate; program: CurrentProgram; week: PlanWeek },
	{ db, line }: { db: SetupDeps['db']; line: typeof getWeekLine }
): Promise<ReadyPlan['weekKind']> {
	const goals = await listGoals(ownerId, { db });
	const at = { programId: program.id, version: program.version.number, today, goals };
	const view = await line(ownerId, { ...at, weekStartsOn: week.days[0]!.date }, { db });
	if (!view.line) return null;
	const { label, why, countdown } = view.line;
	return { label, why: countdown ? `${why} · ${countdown}` : why };
}

/**
 * Today's plan at the owner's `today` (ownerToday, read once per request by loadTodayProgram),
 * from the `program` it found, for load.server.ts to stream, with the review prompt and the
 * week's kind line read together after it. Never rejects: a failed prompt or line read is
 * recorded and the plan shows without it.
 */
export function loadTodayPlan(
	ownerId: string,
	{ today, program, origin }: { today: IsoDate; program: CurrentProgram; origin: SetupOrigin },
	{
		db,
		errorsDb,
		prompt = loadReviewPrompt,
		line = getWeekLine
	}: SetupDeps & { prompt?: typeof loadReviewPrompt; line?: typeof getWeekLine } = {}
): Promise<TodayPlanView> {
	const record = (error: unknown, kind: 'todayPlan' | 'todayReviewPrompt' | 'todayWeekLine') =>
		recordServerError(
			{ error, kind: 'streamed', status: 500, ...origin, context: { load: kind } },
			{ db: errorsDb }
		);
	return readPlan(ownerId, today, program, db).then(
		async (plan) => {
			// Each on its own pool connection, as the plan's reads are.
			const [review, weekKind] = await Promise.all([
				prompt(ownerId, today, { db }).catch(async (error: unknown) => {
					await record(error, 'todayReviewPrompt');
					return null;
				}),
				plan.week
					? readWeekKind(ownerId, { today, program, week: plan.week }, { db, line }).catch(
							async (error: unknown) => {
								await record(error, 'todayWeekLine');
								return null;
							}
						)
					: null
			]);
			return { ...plan, review, weekKind };
		},
		async (error: unknown) => {
			await record(error, 'todayPlan');
			return { failed: true } as const;
		}
	);
}
