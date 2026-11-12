/**
 * What Train says: each day of the week in words (the strip, the cards, a rest day), week 1's
 * brief and, when it has no week of sessions to show, one card (an EmptyState) and the one next
 * step under it. Composed on the server with the data it describes, so the words cost the screen
 * no JavaScript: Train is near its initial-JS budget (docs/performance.md).
 */
import type { IsoDate } from '#lib/domain/calendar.ts';
import { WEEKDAY_INFO } from '#lib/domain/profile/catalog.ts';
import type { DayView, WeekView } from '#lib/domain/training/types.ts';
import {
	PHASE_LABEL,
	sessionTone,
	type Phase,
	type SessionType
} from '#lib/domain/training/vocabulary.ts';
import type { FindingNote } from '#lib/server/services/periodisation/evaluate.ts';
import type { PlacementWhy } from '#lib/server/services/periodisation/explain.ts';
import type { CurrentProgram, WeekChanges } from '#lib/server/services/programs/index.ts';
import type { IconName } from '#lib/ui/icons/icons.ts';
import {
	cardView,
	longDate,
	shortDate,
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

export interface StateCard {
	/** Its test id, which names the state. */
	id: 'train-error' | 'train-empty' | 'train-block-complete' | 'train-not-planned' | 'train-bridge';
	icon: IconName;
	tone: 'accent' | 'neutral' | 'combat';
	title: string;
	description: string;
	next: { title: string; subtitle: string; icon: IconName; to: NextStep };
}

export const ERROR_CARD: StateCard = {
	id: 'train-error',
	icon: 'alert',
	tone: 'combat',
	title: 'Couldn’t load your program',
	description: 'Your plan is safe. Check your connection, then try again.',
	next: { title: 'Try again', subtitle: 'Load your week again', icon: 'refresh', to: 'retry' }
};

/** No program: build one on Today once the training profile is complete, else finish it first. */
export function noProgramCard(profileComplete: boolean): StateCard {
	return {
		id: 'train-empty',
		icon: 'train',
		tone: 'accent',
		title: 'No program yet',
		description: profileComplete
			? 'Your training profile is ready: build one plan across every discipline, adapted to each session you log.'
			: 'Your coach plans every discipline from your goals, schedule and baselines. Finish your training profile first, then build your program on Today.',
		next: profileComplete
			? { title: 'Build my program', subtitle: 'On Today', icon: 'today', to: 'today' }
			: {
					title: 'Set up my profile',
					subtitle: 'Goals, schedule and baselines',
					icon: 'profile',
					to: 'profile'
				}
	};
}

type BlockSummary = Pick<CurrentProgram, 'firstPlannedDay' | 'lastPlannedDay'>;

/**
 * The planned weeks are over and only outline weeks are left, until the cycle review plans the
 * next block: a summary, never a made-up session, and the way to that review (`review`, its key;
 * null before it exists).
 */
export function blockCompleteCard(
	{ firstPlannedDay, lastPlannedDay }: BlockSummary,
	next: Phase | null,
	review: string | null
): StateCard {
	return {
		id: 'train-block-complete',
		icon: 'check',
		tone: 'accent',
		title: 'First block complete',
		description: `You trained through every planned week, ${shortDate(firstPlannedDay)} – ${shortDate(lastPlannedDay)}. Your next block is planned from how this one went${next ? `, starting with ${PHASE_LABEL[next]}` : ''}.`,
		next: {
			title: review ? 'Open your cycle review' : 'Review this block',
			subtitle: 'How it went, and your next block',
			icon: 'progress',
			to: { href: reviewsHref(review) }
		}
	};
}

/**
 * A part of the week's side column (beside the day on desktop, under it on a phone), in words:
 * week 1's brief, or what a weekly review changed. One shape, so Train renders both with one
 * piece of markup: each point is a sentence, after an optional bold lead ('' for none).
 */
export interface AsidePanel {
	/** Its test id, which also names its heading. */
	id: 'baseline-brief' | 'review-notice';
	tone: 'accent' | 'default';
	eyebrow: string;
	title: string;
	lead: string;
	points: { lead: string; text: string }[];
	links: { id: string; href: string; label: string }[];
}

/** Week 1's brief, under its sessions: what a baseline week is for and how to train it. */
export const BASELINE_BRIEF: AsidePanel = {
	id: 'baseline-brief',
	tone: 'accent',
	eyebrow: 'Week 1',
	title: 'Your baseline week',
	lead: 'This week finds your starting point: from week 2, every load is worked out from what you log now.',
	points: [
		'Work up to the target effort (RPE) on each lift, never to failure.',
		'Record the weight, reps and RPE of every set.',
		'Runs and classes go at the effort shown: easy means you can still talk.'
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

/** A week past the planned weeks: its outline phase when it has one. */
export function notPlannedCard(week: number, phase: Phase | null): StateCard {
	return {
		id: 'train-not-planned',
		icon: 'clock',
		tone: 'neutral',
		title: 'Not planned yet',
		description: phase
			? `Week ${week} is in the ${PHASE_LABEL[phase]} phase. Its sessions are planned closer to the time, from how your training goes.`
			: `Week ${week} is past the end of your plan.`,
		next: {
			title: 'Back to this week',
			subtitle: 'The week you are in',
			icon: 'today',
			to: 'this-week'
		}
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
		icon: 'clock',
		tone: 'neutral',
		title: 'Unplanned week · between blocks',
		description: `Your next block starts ${shortDate(startsOn)}. Nothing is planned until then: train as you like, and what you log counts as off-plan.`,
		next: {
			title: 'See your next block',
			subtitle: `${name} · Week ${week}`,
			icon: 'train',
			to: { week }
		}
	};
}

/** A workout logged in a bridge week, which no plan holds, as a card: 'Easy run', 'Off-plan'. */
export type OffPlanWorkout = CardView & { id: string };

/** The card of a workout logged in a bridge week: its day and length, and 'Off-plan'. */
export function offPlanCard(workout: {
	id: string;
	title: string;
	sessionType: SessionType;
	date: IsoDate;
	durationSeconds: number | null;
}): OffPlanWorkout {
	const minutes = workout.durationSeconds
		? ` · ${Math.round(workout.durationSeconds / 60)} min`
		: '';
	return {
		id: workout.id,
		title: workout.title,
		status: 'completed',
		statusWords: 'Off-plan',
		line: `${shortDate(workout.date)}${minutes}`,
		tone: sessionTone(workout.sessionType)
	};
}

/**
 * Train's notice for a week a weekly review changed: who applied what, each change with its why,
 * and its links: the version in History, then the review (the reviews list if it is gone).
 */
export function reviewNotice({ applied, changes, version, review }: WeekChanges): AsidePanel {
	return {
		id: 'review-notice',
		tone: 'default',
		eyebrow: `Version ${version.number}`,
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
