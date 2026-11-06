/**
 * What Train says: each day of the week in words (the strip, the cards, a rest day), week 1's
 * brief and, when it has no week of sessions to show, one card (an EmptyState) and the one next
 * step under it. Composed on the server with the data it describes, so the words cost the screen
 * no JavaScript: Train is near its initial-JS budget (docs/performance.md).
 */
import type { IsoDate } from '#lib/domain/calendar.ts';
import { WEEKDAY_INFO } from '#lib/domain/profile/catalog.ts';
import type { DayView, WeekView } from '#lib/domain/training/types.ts';
import { PHASE_LABEL, type Phase } from '#lib/domain/training/vocabulary.ts';
import type { CurrentProgram } from '#lib/server/services/programs/index.ts';
import type { IconName } from '#lib/ui/icons/icons.ts';
import {
	cardView,
	longDate,
	shortDate,
	stripDay,
	type CardView,
	type StripDayView
} from '#lib/ui/program/words.ts';

/** Where the next step goes: a screen, a week of the program, or Train again (Retry). */
export type NextStep = 'today' | 'profile' | 'this-week' | 'retry' | { week: number };

export interface StateCard {
	/** Its test id, which names the state. */
	id: 'train-error' | 'train-empty' | 'train-block-complete' | 'train-not-planned';
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
	next: { title: 'Retry', subtitle: 'Load your week again', icon: 'refresh', to: 'retry' }
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

type BlockSummary = Pick<CurrentProgram, 'firstPlannedDay' | 'lastPlannedDay' | 'plannedWeeks'>;

/**
 * The planned weeks are over and only outline weeks are left, until M6 plans the next block:
 * a summary, never a made-up session.
 */
export function blockCompleteCard(
	{ firstPlannedDay, lastPlannedDay, plannedWeeks }: BlockSummary,
	next: Phase | null
): StateCard {
	return {
		id: 'train-block-complete',
		icon: 'check',
		tone: 'accent',
		title: 'First block complete',
		description: `You trained through every planned week, ${shortDate(firstPlannedDay)} – ${shortDate(lastPlannedDay)}. Your next block is planned from how this one went${next ? `, starting with ${PHASE_LABEL[next]}` : ''}.`,
		next: {
			title: `Look back at week ${plannedWeeks}`,
			subtitle: 'Your last planned week',
			icon: 'clock',
			to: { week: plannedWeeks }
		}
	};
}

/** Week 1's brief, under its sessions: what a baseline week is for and how to train it. */
export const BASELINE_BRIEF = {
	eyebrow: 'Week 1',
	title: 'Your baseline week',
	lead: 'This week finds your starting point: from week 2, every load is worked out from what you log now.',
	points: [
		'Work up to the target effort (RPE) on each lift, never to failure.',
		'Record the weight, reps and RPE of every set.',
		'Runs and classes go at the effort shown: easy means you can still talk.'
	]
} as const;

/** A day of the week shown, in words: its heading, its sessions' cards, or a rest-day line. */
export interface TrainDay {
	/** 'Monday 9 November'. */
	heading: string;
	/** By lineage; `baseline` on a strength session of a baseline week. */
	cards: (CardView & { lineage: string; baseline: boolean })[];
	/** With no sessions: recovery is part of the plan, and what comes next this week, if any. */
	rest: string | null;
}

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
