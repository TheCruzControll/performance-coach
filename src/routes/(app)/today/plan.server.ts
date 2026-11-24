/**
 * Today once a program exists (Instrument v2, v2/06b): the day as one statement (its title, when,
 * one sentence from the coach and one Start), the one line under it, and the week as seven dots,
 * with every other day of the week composed too, so a tap on a dot shows that day with no request.
 * The states a day can be in, in order: every planned week trained ('Nothing yet'), a bridge week
 * between blocks ('Free week'), before week 1 (the start's day), a block to review ('Done', with
 * the review's create form as its button; it also takes the place of 'Nothing yet'), then today's
 * sessions: one to start, rest, all done, or all skipped. A week to review is the one line under
 * today's day ('Last week · Review ready', to Progress → Reviews). Words are composed here
 * (day-words.ts), with the data they describe, so the panel ships none of the vocabulary. Kept
 * out of +page.server.ts so integration tests can run it with an unreachable database.
 *
 * It is streamed, and it fails soft: a read that fails is recorded as a server error (kind
 * 'streamed', as Profile's are) and resolves to {failed: true}, which the panel shows as one
 * statement with Try again.
 *
 * It reads from the program loadTodayProgram found, so the week it shows (today's, or week 1's
 * before the start) is known at once: the plan and that week are read together, each service on
 * its own pool connection (docs/architecture.md). So its `db` is the pool, never a transaction.
 * Once the plan is in, the review prompt (progress/review-prompt.server.ts: a block's review as
 * the day, a week's as its line), the goals (the one line's goal), the week's kind (the coach's
 * sentence on a light or special week, services/periodisation/week-line.ts) and the week's
 * completed workouts (their History page and length) are read together: a read that fails is
 * recorded and the day composes without it.
 */
import { resolve } from '$app/paths';
import { daysBetween, mondayOf, type IsoDate } from '#lib/domain/calendar.ts';
import type { Goal } from '#lib/domain/profile/types.ts';
import { BRIDGE_PHASE } from '#lib/domain/programming/next-block/dates.ts';
import type { SessionView } from '#lib/domain/training/types.ts';
import { WEEKDAY_INFO } from '#lib/domain/weekdays.ts';
import { recordServerError } from '#lib/server/services/errors.ts';
import { getWeekLine } from '#lib/server/services/periodisation/week-line.ts';
import { listGoals } from '#lib/server/services/profile/index.ts';
import {
	getTodayPlan,
	getTrainingWeek,
	type CurrentProgram,
	type TodayPlan,
	type TrainingWeek
} from '#lib/server/services/programs/index.ts';
import { completedWorkouts } from '#lib/server/services/workouts/history.ts';
import type { ReviewPromptView } from '#lib/ui/analytics/review-prompt.ts';
import { leadLineage, startLink, type StartLink } from '#lib/ui/program/start-link.ts';
import { dayName } from '#lib/ui/program/words.ts';
import { loadReviewPrompt } from '../progress/review-prompt.server';
import {
	blockEndWords,
	bridgeLead,
	coachLine,
	completeLead,
	doneLabel,
	doneLine,
	dotMark,
	goalEnd,
	lineLabel,
	restLine,
	skippedLine,
	startsTitle,
	STARTS_LEAD,
	whenLine,
	type DaySession,
	type DotMark
} from './day-words';
import type { SetupDeps, SetupOrigin } from './setup.server';

/** One line under the day. */
export interface DayLine {
	kind: 'later' | 'goal' | 'review' | 'done';
	/** 'Tomorrow', 'Goal', 'Last week', 'Morning'. */
	label: string;
	/** 'Long run', 'None set yet', 'Review ready', 'Full body'. */
	title: string;
	/** '45 min', 'Add one', '21 weeks to go'; null with a tick or nothing. */
	end: string | null;
	/** A done session's tick (the quiet done line under a session). */
	tick: boolean;
	/** Label and title tertiary (that same done line). */
	quiet: boolean;
	/** The session's page, /profile/goals, /progress/reviews, or the workout done. */
	href: string | null;
	/** The goal's and the review's line, and the done day's lines, which open something. */
	chevron: boolean;
}

/** A 60 px row: another day's 'Open the session' and 'Back to today'; nothing yet's two rows. */
export interface DayRow {
	title: string;
	/** Null for 'Back to today', a button. */
	href: string | null;
	secondary: boolean;
	testId: string;
}

/** The day, as one statement. */
export interface DayView {
	state:
		| 'session'
		| 'rest'
		| 'done'
		| 'skipped'
		| 'starts'
		| 'bridge'
		| 'complete'
		| 'block-end'
		| 'other-day';
	date: IsoDate;
	title: string;
	/** 17/26 secondary under the title; a rest, skipped, starts, bridge or complete day's sentence. */
	when: string | null;
	/** 17/26 text: the coach's one sentence. */
	coach: string | null;
	/** The one button: a session's way in (start-link.ts); the device's Resume is swapped in on
	 * the client (resumeLink). */
	lead: { lineage: string; link: StartLink } | null;
	/** A block's end only: its review to create, whose form is the day's button. */
	review: ReviewPromptView | null;
	lines: DayLine[];
	rows: DayRow[];
	/** The quiet link to /workout: 'Log something anyway', 'Log something', or none. */
	log: 'anyway' | 'plain' | null;
}

/** A day of the week's dots. */
export interface Dot {
	date: IsoDate;
	letter: string;
	/** Its accessible name (words.ts dayName): 'Thursday 5 November, today, 2 sessions, 1 done'. */
	name: string;
	mark: DotMark;
}

export interface ReadyPlan {
	failed: false;
	/** The owner's today: what the coming days' kits count from (coming-kits.ts). */
	today: IsoDate;
	/** The week's seven days, Monday first; null before week 1, between blocks, and once the
	 * planned weeks are over. */
	dots: Dot[] | null;
	/** The day for today, and for each other day of `dots` (a tap shows it; no request). */
	day: DayView;
	others: DayView[];
	/** The sessions still to come, for the coming-kits pass (coming-kits.ts DatedSession). */
	coming: { lineage: string; date: IsoDate; status: SessionView['status'] }[];
}

export type TodayPlanView = { failed: true } | ReadyPlan;

/** What the plan's reads came to, before the prompt, the goals and the week's kind. */
type PlanRead =
	| { blockComplete: true; plan: TodayPlan }
	| {
			blockComplete: false;
			plan: TodayPlan;
			week: Extract<TrainingWeek, { planned: true }>;
			/** The week's completed sessions' lineages: their workouts are read beside the plan. */
			completed: string[];
	  };

/** What the day reads beside the plan; any of them null (`done` empty) when its read failed. */
interface Extras {
	/** A week or block to review, or its review once written (review-prompt.server.ts). */
	review: ReviewPromptView | null;
	goals: Goal[] | null;
	weekKind: { label: string; why: string } | null;
	/** The week's completed sessions' workouts, by lineage: their History page and length. */
	done: Record<string, { id: string; seconds: number | null }>;
}

const sessionHref = (lineage: string) => resolve('/(app)/train/session/[key]', { key: lineage });
const isOpen = (s: Pick<SessionView, 'status'>) => s.status === 'planned' || s.status === 'moved';

async function readPlan(
	ownerId: string,
	today: IsoDate,
	program: CurrentProgram,
	db: SetupDeps['db']
): Promise<PlanRead> {
	if (program.blockComplete) {
		const plan = await getTodayPlan(ownerId, today, { db });
		// loadTodayProgram found the program a moment ago; only a concurrent archive removes it.
		if (!plan) throw new Error('the active program disappeared while Today loaded');
		return { blockComplete: true, plan };
	}
	const selected = program.notStarted ? program.firstPlannedDay : today;
	// Two services together, each on its own pool connection; inside each, one query at a time.
	const [plan, week] = await Promise.all([
		getTodayPlan(ownerId, today, { db }),
		getTrainingWeek(ownerId, { date: selected }, {}, { db })
	]);
	if (!plan) throw new Error('the active program disappeared while Today loaded');
	if (!week?.planned) throw new Error(`no planned week holds ${selected}`);
	const completed = week.days
		.flatMap((d) => d.sessions)
		.filter((s) => s.status === 'completed')
		.map((s) => s.lineage);
	return { blockComplete: false, plan, week, completed };
}

/** The kind line of the week shown, in words: its why, then any countdown. */
async function readWeekKind(
	ownerId: string,
	{
		today,
		program,
		week,
		goals
	}: { today: IsoDate; program: CurrentProgram; week: IsoDate; goals: Goal[] },
	{ db, line }: { db: SetupDeps['db']; line: typeof getWeekLine }
): Promise<Extras['weekKind']> {
	const at = { programId: program.id, version: program.version.number, today, goals };
	const view = await line(ownerId, { ...at, weekStartsOn: week }, { db });
	if (!view.line) return null;
	const { label, why, countdown } = view.line;
	return { label, why: countdown ? `${why} · ${countdown}` : why };
}

/** A session still to come, as the line under the day: 'Tomorrow · Long run · 45 min'. */
const later = (s: DaySession, today: IsoDate): DayLine => ({
	kind: 'later',
	label: lineLabel(s.date, today),
	title: s.title,
	end: `${s.estMinutes} min`,
	tick: false,
	quiet: false,
	href: sessionHref(s.lineage),
	chevron: false
});

/** The goal's line: none set ('Add one'), or the top goal's weeks to go. */
const goalLine = (title: string, end: string): DayLine => ({
	kind: 'goal',
	label: 'Goal',
	title,
	end,
	tick: false,
	quiet: false,
	href: resolve('/(app)/profile/[section]', { section: 'goals' }),
	chevron: true
});

/**
 * The one line under a session to start (D11), the first that applies: no open goal, the next
 * session within six days, the top goal with a date to come, else the next session at any
 * distance. Goals that could not be read add no goal line.
 */
function oneLine(next: DaySession | undefined, goals: Goal[] | null, today: IsoDate): DayLine[] {
	const open = goals?.filter((g) => g.priority !== null) ?? null;
	if (open && open.length === 0) return [goalLine('None set yet', 'Add one')];
	if (next && daysBetween(today, next.date) <= 6) return [later(next, today)];
	const top = open
		?.filter((g) => g.status !== 'paused')
		.sort((a, b) => a.priority! - b.priority!)[0];
	const end = top ? goalEnd(top.eventDate ?? top.targetDate, today) : null;
	if (top && end) return [goalLine(top.title, end)];
	return next ? [later(next, today)] : [];
}

/**
 * A week to review, as the one line under today's day (D11, first; D12): to Progress → Reviews,
 * which creates it. 'This week' when the week is written early, once every session is resolved.
 */
function reviewLine(review: ReviewPromptView, today: IsoDate): DayLine {
	const week = review.create?.fields.weekStartsOn;
	return {
		kind: 'review',
		label: week === mondayOf(today) ? 'This week' : 'Last week',
		title: 'Review ready',
		end: null,
		tick: false,
		quiet: false,
		href: resolve('/(app)/progress/reviews/[[key]]', {}),
		chevron: true
	};
}

/**
 * A block to review, as the day (rule 4, D10): 'Done', the block's weeks and name, and the
 * coach's sentence naming the block after it; its button is the review's create form. The block
 * is the one the review would cover (its lineage in the form), so a block that ends this Sunday,
 * its last week done, reads the same as one that has ended.
 */
function blockEnd(
	review: ReviewPromptView,
	{ program, today, lines }: { program: CurrentProgram; today: IsoDate; lines: DayLine[] }
): DayView {
	const at = program.blocks.findIndex((b) => b.lineage === review.create?.fields.blockLineage);
	const ended = at < 0 ? undefined : program.blocks[at]!;
	const next = ended && program.blocks.slice(at + 1).find((b) => b.phase !== BRIDGE_PHASE);
	const weeks = ended ? Math.ceil((daysBetween(ended.startsOn, ended.endsOn) + 1) / 7) : 0;
	const words = blockEndWords({
		weeks,
		name: ended?.name ?? '',
		next: next?.name ?? null
	});
	return {
		...blank(),
		state: 'block-end',
		date: today,
		title: words.title,
		when: ended ? words.when : null,
		coach: words.coach,
		review,
		lines
	};
}

/** What a day has until its rule gives it more: no sentence, no button, no lines or rows. */
const blank = (): Pick<DayView, 'coach' | 'lead' | 'review' | 'lines' | 'rows' | 'log'> => ({
	coach: null,
	lead: null,
	review: null,
	lines: [],
	rows: [],
	log: null
});

/** A day of the week but today, as a tap on its dot shows it (rule 6). */
function otherDay(
	day: { date: IsoDate; sessions: readonly SessionView[] },
	ctx: {
		today: IsoDate;
		baseline: boolean;
		weekKind: Extras['weekKind'];
		done: Record<string, { seconds: number | null }>;
	}
): DayView {
	const back: DayRow = {
		title: 'Back to today',
		href: null,
		secondary: true,
		testId: 'today-back'
	};
	const { sessions } = day;
	if (!sessions.length)
		return {
			...blank(),
			state: 'other-day',
			date: day.date,
			title: 'Rest day',
			when: 'Nothing planned.',
			rows: [back]
		};
	const rows: DayRow[] = sessions.map((s) => ({
		title: sessions.length > 1 ? `Open ${s.title}` : 'Open the session',
		href: sessionHref(s.lineage),
		secondary: false,
		testId: 'open-session'
	}));
	rows.push(back);
	if (sessions.every((s) => s.status === 'completed')) {
		const lengths = sessions.map((s) => ({ ...s, seconds: ctx.done[s.lineage]?.seconds ?? null }));
		return {
			...blank(),
			state: 'other-day',
			date: day.date,
			title: sessions[0]!.title,
			when: doneLine(lengths, ctx.today),
			rows
		};
	}
	// A past day with nothing done: each session was skipped or missed, so no sentence to train by.
	if (day.date < ctx.today && sessions.every((s) => s.status !== 'completed'))
		return {
			...blank(),
			state: 'other-day',
			date: day.date,
			title: sessions[0]!.title,
			when: skippedLine(sessions.map((s) => s.title)),
			rows
		};
	const s = sessions.find((x) => x.status !== 'completed') ?? sessions[0]!;
	const coach = coachLine(s, { baseline: ctx.baseline, first: false, weekKind: ctx.weekKind });
	return {
		...blank(),
		state: 'other-day',
		date: day.date,
		title: s.title,
		when: whenLine(s, ctx.today),
		coach,
		rows
	};
}

/** The day, its dots and the other days, from what was read (section 3.4.2's rules, in order). */
function composeDay(
	read: PlanRead,
	{
		today,
		program,
		review,
		goals,
		weekKind,
		done
	}: Extras & { today: IsoDate; program: CurrentProgram }
): ReadyPlan {
	const { plan } = read;
	const coming = [
		...(read.blockComplete ? [] : read.week.days.flatMap((d) => d.sessions)),
		...plan.upNext
	].map(({ lineage, date, status }) => ({ lineage, date, status }));
	const cycle = review?.kind === 'cycle' && review.state === 'due' && review.create ? review : null;
	const weekly = review?.kind === 'weekly' && review.state === 'due' ? review : null;
	/**
	 * A week to review is today's one line, first of all (D11): it takes the place of the next
	 * session's or the goal's line, after any done lines, so it shows on every day it is due.
	 */
	const withReview = (day: DayView): DayView =>
		weekly
			? {
					...day,
					lines: [...day.lines.filter((l) => l.kind === 'done'), reviewLine(weekly, today)]
				}
			: day;
	const ready = (day: DayView, dots: Dot[] | null = null, others: DayView[] = []): ReadyPlan => ({
		failed: false,
		today,
		dots,
		day: withReview(day),
		others,
		coming
	});
	const nextAfter = plan.upNext.find(isOpen);

	// 1. Every planned week trained: nothing is planned until the next block is, unless the block
	// is still to review, which leads (rule 4), with no session to name under it.
	if (read.blockComplete && cycle) return ready(blockEnd(cycle, { program, today, lines: [] }));
	if (read.blockComplete) {
		const { firstPlannedDay: first, lastPlannedDay: last } = program;
		const weeks = Math.ceil((daysBetween(first, last) + 1) / 7);
		return ready({
			...blank(),
			state: 'complete',
			date: today,
			title: 'Nothing yet',
			when: completeLead(weeks, first, last),
			rows: [
				{
					title: 'Look back at every week',
					href: resolve('/(app)/train'),
					secondary: false,
					testId: 'today-train-link'
				},
				{
					title: 'Log something',
					href: resolve('/workout'),
					secondary: false,
					testId: 'log-something-else'
				}
			]
		});
	}
	const { week } = read;

	// 2. A bridge week between blocks: the day the next block starts.
	if (week.nextBlockStartsOn) {
		const startsOn = week.nextBlockStartsOn;
		const name = program.blocks.find((b) => b.startsOn === startsOn)?.name ?? null;
		return ready({
			...blank(),
			state: 'bridge',
			date: today,
			title: 'Free week',
			when: bridgeLead(name, startsOn),
			lines: nextAfter ? [later(nextAfter, today)] : [],
			log: 'plain'
		});
	}

	// 3. Before week 1: the day it starts.
	if (plan.startsOn) {
		return ready({
			...blank(),
			state: 'starts',
			date: today,
			title: startsTitle(plan.startsOn, today),
			when: STARTS_LEAD,
			lines: nextAfter ? [later(nextAfter, today)] : [],
			log: 'anyway'
		});
	}

	// 4 and 5 read the week that holds today.
	const baseline = week.kind === 'baseline';
	const dots = week.days.map((d) => ({
		date: d.date,
		letter: WEEKDAY_INFO[d.weekday].letter,
		name: dayName(d, today),
		mark: dotMark(
			d.sessions.map((s) => s.status),
			d.date,
			today
		)
	}));
	const others = week.days
		.filter((d) => d.date !== today)
		.map((d) => otherDay(d, { today, baseline, weekKind, done }));
	const todays = week.days.find((d) => d.date === today)?.sessions ?? [];
	const ways = todays.map((s) => ({ lineage: s.lineage, link: startLink(s, done[s.lineage]?.id) }));
	const leadId = leadLineage(ways);
	const completed = todays.filter((s) => s.status === 'completed');
	const weekLater = week.days.filter((d) => d.date > today).flatMap((d) => d.sessions);
	/** The next session to do after `s` (today's later ones first), or after today. */
	const after = (s?: SessionView) =>
		(s && todays.slice(todays.indexOf(s) + 1).find(isOpen)) ?? weekLater.find(isOpen) ?? nextAfter;
	const doneOf = (s: SessionView) => startLink(s, done[s.lineage]?.id)!.href;
	const day = { ...blank(), date: today };

	// 4. A block to review: the review leads, and today's session waits as its line.
	if (cycle) {
		const open = todays.find(isOpen);
		const next = open ?? after();
		const lines = next ? [{ ...later(next, today), ...(open && { label: 'Today' }) }] : [];
		return ready(blockEnd(cycle, { program, today, lines }), dots, others);
	}

	// 5. Today's sessions.

	if (!todays.length) {
		const doneThisWeek = week.days
			.filter((d) => d.date <= today)
			.flatMap((d) => d.sessions)
			.filter((s) => s.status === 'completed').length;
		const next = after();
		return ready(
			{
				...day,
				state: 'rest',
				title: 'Rest day',
				when: restLine(doneThisWeek),
				lines: next ? [later(next, today)] : [],
				log: 'anyway'
			},
			dots,
			others
		);
	}

	if (leadId) {
		const s = todays.find((x) => x.lineage === leadId)!;
		const first =
			week.number === 1 &&
			!week.days.some((d) => d.date <= today && d.sessions.some((x) => x.status === 'completed'));
		const lines = completed.length
			? completed.map((c): DayLine => ({
					kind: 'done',
					label: doneLabel(c),
					title: c.title,
					end: null,
					tick: true,
					quiet: true,
					href: doneOf(c),
					chevron: false
				}))
			: oneLine(after(s), goals, today);
		return ready(
			{
				...day,
				state: 'session',
				title: s.title,
				when: whenLine(s, today, first),
				coach: coachLine(s, { baseline, first, weekKind }),
				lead: { lineage: s.lineage, link: ways.find((w) => w.lineage === leadId)!.link! },
				lines
			},
			dots,
			others
		);
	}

	if (completed.length) {
		const next = after();
		const lines: DayLine[] = todays.map((s) =>
			s.status === 'completed'
				? {
						kind: 'done',
						label: doneLabel(s),
						title: s.title,
						end: null,
						tick: false,
						quiet: false,
						href: doneOf(s),
						chevron: true
					}
				: {
						kind: 'done',
						label: doneLabel(s),
						title: s.title,
						end: 'Skipped',
						tick: false,
						quiet: false,
						href: null,
						chevron: false
					}
		);
		if (next) lines.push(later(next, today));
		const lengths = completed.map((s) => ({ ...s, seconds: done[s.lineage]?.seconds ?? null }));
		return ready(
			{
				...day,
				state: 'done',
				title: completed.length === 1 ? 'Done' : 'All done',
				when: doneLine(lengths, today),
				lines
			},
			dots,
			others
		);
	}

	const next = after();
	return ready(
		{
			...day,
			state: 'skipped',
			title: 'Skipped',
			when: skippedLine(todays.map((s) => s.title)),
			lines: next ? [later(next, today)] : [],
			log: 'anyway'
		},
		dots,
		others
	);
}

/**
 * Today's plan at the owner's `today` (ownerToday, read once per request by loadTodayProgram),
 * from the `program` it found, for load.server.ts to stream, with the review prompt, the goals,
 * the week's kind and its completed workouts read together after it. Never rejects: a failed
 * prompt, goals, kind or workouts read is recorded and the day composes without it.
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
	type Load =
		'todayPlan' | 'todayReviewPrompt' | 'todayGoals' | 'todayWeekLine' | 'todayCompletedWorkouts';
	const record = (error: unknown, kind: Load) =>
		recordServerError(
			{ error, kind: 'streamed', status: 500, ...origin, context: { load: kind } },
			{ db: errorsDb }
		);
	/** A read beside the plan that fails: recorded, and the day composes without it. */
	const soft = (kind: Load) => async (error: unknown) => {
		await record(error, kind);
		return null;
	};
	return readPlan(ownerId, today, program, db).then(
		async (read) => {
			// Each on its own pool connection, as the plan's reads are.
			const goals = listGoals(ownerId, { db }).catch(soft('todayGoals'));
			const week = read.blockComplete ? null : read.week;
			const [review, readGoals, weekKind, done] = await Promise.all([
				prompt(ownerId, today, { db }).catch(soft('todayReviewPrompt')),
				goals,
				week && !week.nextBlockStartsOn && !program.notStarted
					? goals
							.then((g) =>
								readWeekKind(
									ownerId,
									{ today, program, week: week.startsOn, goals: g ?? [] },
									{ db, line }
								)
							)
							.catch(soft('todayWeekLine'))
					: null,
				read.blockComplete
					? null
					: completedWorkouts(ownerId, read.completed, { db }).catch(soft('todayCompletedWorkouts'))
			]);
			return composeDay(read, {
				today,
				program,
				review,
				goals: readGoals,
				weekKind,
				done: done ?? {}
			});
		},
		async (error: unknown) => {
			await record(error, 'todayPlan');
			return { failed: true } as const;
		}
	);
}
