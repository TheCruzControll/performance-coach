/**
 * What Train says beside its week's lines (week-lines.ts): week 1's brief, what a review changed
 * and, when it has no week of sessions to show, one statement and the one next step under it.
 * History's version week still reads each day in words here (weekWords). Composed on the server
 * with the data it describes, so the words cost the screen no JavaScript: Train is near its
 * initial-JS budget (docs/performance.md).
 */
import { weekdayOf, type IsoDate } from '#lib/domain/calendar.ts';
import { WEEKDAY_INFO } from '#lib/domain/profile/catalog.ts';
import type { DayView, WeekView } from '#lib/domain/training/types.ts';
import { PHASE_LABEL, type Phase } from '#lib/domain/training/vocabulary.ts';
import type { FindingNote } from '#lib/server/services/periodisation/evaluate.ts';
import type { PlacementWhy } from '#lib/server/services/periodisation/explain.ts';
import type { CurrentProgram, WeekChanges } from '#lib/server/services/programs/index.ts';
import { inWords, lineWhen, type WeekLine } from '#lib/ui/program/week-lines.ts';
import {
	cardView,
	longDate,
	stripDay,
	type CardView,
	type StripDayView
} from '#lib/ui/program/words.ts';

/** Where the next step goes: a screen, a week of the program, Train again (Retry), or a path. */
export type NextStep =
	'today' | 'profile' | 'this-week' | 'retry' | { week: number } | { href: string };

/** The reviews screen: the list, or one review by its key ('w-2026-11-09', 'c-<id>'). */
const reviewsHref = (key: string | null) =>
	key ? `/progress/reviews/${key}` : '/progress/reviews';

/** '16 November': a date without its weekday. */
const dayMonth = (date: IsoDate) => longDate(date).replace(/^\S+ /, '');

/**
 * A state Train shows in place of the week's lines (Instrument v2, Paper 4 · Train "No week to
 * show"): one statement, one sentence and the one thing to do, as a primary button, a quiet row
 * with a chevron, or a text button (Try again).
 */
export interface StateCard {
	/** Its test id, which names the state. */
	id: 'train-error' | 'train-empty' | 'train-block-complete' | 'train-not-planned' | 'train-bridge';
	title: string;
	description: string;
	next: { title: string; to: NextStep; style: 'primary' | 'row' | 'text' };
	/** No top line (the week's place and its arrows) above it. */
	bare: boolean;
}

export const ERROR_CARD: StateCard = {
	id: 'train-error',
	title: 'Couldn’t load your plan',
	description: 'Your plan is safe. Check your connection and try again.',
	next: { title: 'Try again', to: 'retry', style: 'text' },
	bare: true
};

/** No program: build one on Today once the training profile is complete, else finish it first. */
export function noProgramCard(profileComplete: boolean): StateCard {
	return {
		id: 'train-empty',
		title: 'No plan yet',
		description: profileComplete
			? 'Your profile is ready, so I can plan week 1.'
			: 'Finish setting up your profile, then I can plan week 1.',
		next: profileComplete
			? { title: 'Build my program', to: 'today', style: 'primary' }
			: { title: 'Finish setup', to: 'profile', style: 'primary' },
		bare: true
	};
}

type BlockSummary = Pick<CurrentProgram, 'firstPlannedDay' | 'lastPlannedDay'> & {
	/** The last planned block's name. */
	name: string;
	/** How many weeks were planned. */
	weeks: number;
};

/**
 * The planned weeks are over and only outline weeks are left, until the cycle review plans the
 * next block: a summary, never a made-up session, and the way to that review (`review`, its key;
 * null before it exists).
 */
export function blockCompleteCard(
	{ firstPlannedDay, lastPlannedDay, name, weeks }: BlockSummary,
	next: Phase | null,
	review: string | null
): StateCard {
	const plan = next
		? `I plan ${PHASE_LABEL[next]} from how it went.`
		: 'I plan your next block from how it went.';
	return {
		id: 'train-block-complete',
		title: `${name} is done`,
		description: `You trained through ${weeks === 1 ? 'the whole week' : `all ${inWords(weeks)} weeks`}, ${dayMonth(firstPlannedDay)} to ${dayMonth(lastPlannedDay)}. ${plan}`,
		next: review
			? { title: 'Open the review', to: { href: reviewsHref(review) }, style: 'row' }
			: { title: 'Review the block', to: { href: reviewsHref(null) }, style: 'primary' },
		bare: true
	};
}

/**
 * A part of the week's note (the one line under the week opens it), in words: week 1's brief, or
 * what a weekly review changed. One shape, so Train renders both with one piece of markup: each
 * point is a sentence, after an optional lead ('' for none), and each link a row.
 */
export interface AsidePanel {
	/** Its test id. */
	id: 'baseline-brief' | 'review-notice';
	title: string;
	lead: string;
	points: { lead: string; text: string }[];
	links: { id: string; href: string; label: string }[];
}

/** Week 1's brief (Paper, 4 · Train "The baseline week"): what it is for and how to train it. */
export const BASELINE_BRIEF: AsidePanel = {
	id: 'baseline-brief',
	title: 'What week 1 is for',
	lead: 'It finds your starting point. From week 2 every weight comes from what you log now.',
	points: [
		'Work up to the effort shown, then stop',
		'Log weight, reps and effort for every set',
		'Runs and classes go at the effort shown'
	].map((text) => ({ lead: '', text })),
	links: []
};

/** A day of the week shown, in words: its heading, its sessions' cards, or a rest-day line. */
export interface TrainDay {
	/** 'Monday 9 November'. */
	heading: string;
	/**
	 * By lineage; `baseline` on a strength session of a baseline week; a finding's note; why the
	 * session is on its day (whyWords).
	 */
	cards: (CardView & { lineage: string; baseline: boolean; note?: FindingNote; why?: CardWhy })[];
	/** With no sessions: recovery is part of the plan, and what comes next this week, if any. */
	rest: string | null;
}

/** 'Why Tuesday?' under a card: its title and one plain line per decision (m7/14, lever 3). */
export interface CardWhy {
	title: string;
	lines: string[];
}

/** 'Session moved (You, version 2): You moved Lower A from Friday to Monday. …' */
export const whyWords = ({ title, items }: PlacementWhy): CardWhy => ({
	title,
	lines: items.map((i) => `${i.kind} (${i.decidedBy}, version ${i.version}): ${i.why}`)
});

/** A planned week in words: WeekStrip's days, and each day's heading, cards and rest line. */
export function weekWords(
	week: Extract<WeekView, { planned: true }>,
	today: IsoDate
): { strip: StripDayView[]; days: TrainDay[] } {
	const days = week.days.map((day: DayView, i): TrainDay => {
		const next = week.days.slice(i + 1).find((d) => d.sessions.length > 0);
		return {
			heading: longDate(day.date),
			cards: day.sessions.map((session) => ({
				...cardView(session),
				lineage: session.lineage,
				baseline: week.kind === 'baseline' && session.kind === 'strength'
			})),
			rest:
				day.sessions.length > 0
					? null
					: next
						? `Recovery is part of the plan. Next: ${next.sessions[0]!.title}, ${WEEKDAY_INFO[next.weekday].label}.`
						: 'Recovery is part of the plan. Nothing else is planned this week.'
		};
	});
	return { strip: week.days.map((day) => stripDay(day, today)), days };
}

/**
 * A week past the planned weeks: its outline phase when it has one, which the review of the last
 * planned block (`block`, its name) plans.
 */
export function notPlannedCard(week: number, phase: Phase | null, block: string): StateCard {
	return {
		id: 'train-not-planned',
		title: 'Not planned yet',
		description: phase
			? `I plan ${PHASE_LABEL[phase]} after your ${block} review, from how these weeks went.`
			: `Week ${week} is past the end of your plan.`,
		next: { title: 'Back to this week', to: 'this-week', style: 'row' },
		bare: false
	};
}

/** The next block, as a bridge week names it: its first day, name and first program week. */
export interface NextBlock {
	startsOn: IsoDate;
	name: string;
	week: number;
}

/**
 * A bridge week (a late start's unplanned weeks between blocks, M6): a deliberate gap with the
 * day the next block starts, never seven rest days. Its next step opens that block's first week.
 */
export function bridgeCard({ startsOn, name, week }: NextBlock): StateCard {
	return {
		id: 'train-bridge',
		title: 'Free week',
		description: `${name} starts ${longDate(startsOn)}. Train as you like, and what you log counts as off plan.`,
		next: { title: 'See the next block', to: { week }, style: 'row' },
		bare: false
	};
}

/**
 * A workout logged in a bridge week, which no plan holds, as one of the week's lines: its day,
 * its title and its length ('Tue · Easy run · 32 min'), linking nowhere.
 */
export function offPlanLine(
	workout: { title: string; date: IsoDate; durationSeconds: number | null },
	today: IsoDate
): WeekLine {
	const minutes = workout.durationSeconds
		? `${Math.round(workout.durationSeconds / 60)} min`
		: null;
	return {
		date: workout.date,
		day: WEEKDAY_INFO[weekdayOf(workout.date)].short,
		title: workout.title,
		when: lineWhen(workout.date, today),
		end: minutes ? { text: minutes } : null,
		name: [longDate(workout.date), workout.title, minutes ?? 'off plan'].join(', ')
	};
}

/**
 * Train's notice for a week a weekly review changed: who applied what, each change with its why,
 * and its links: the version in History, then the review (the reviews list if it is gone).
 */
export function reviewNotice({ applied, changes, version, review }: WeekChanges): AsidePanel {
	return {
		id: 'review-notice',
		title: 'Updated from your weekly review',
		lead: applied,
		points: changes.map(({ summary, why }) => ({ lead: `${summary}.`, text: why })),
		links: [
			{
				id: 'review-notice-version',
				href: `/train/history/${version.number}`,
				label: 'See it in History'
			},
			review
				? {
						id: 'review-notice-review',
						href: reviewsHref(`w-${review.weekStartsOn}`),
						label: 'Open your weekly review'
					}
				: { id: 'review-notice-review', href: reviewsHref(null), label: 'See your reviews' }
		]
	};
}
