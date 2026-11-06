/**
 * The plan as BlockTimeline lays it out: every block from week 1 to the end of the outline, each
 * with its phase, dates and weeks, and the week that holds today, the dated goals the plan leads
 * to and the weeks not planned yet marked. Like words.ts, it reads calendar strings, never the
 * device's clock, and is composed where the plan is read (Train's load, on the server), so the
 * sheet that shows it carries none of the vocabulary.
 */
import { addDays, daysBetween, type IsoDate } from '#lib/domain/calendar.ts';
import type { GoalStatus } from '#lib/domain/profile/catalog.ts';
import type { Goal } from '#lib/domain/profile/types.ts';
import type { BlockPlan } from '#lib/domain/training/types.ts';
import { PHASE_LABEL } from '#lib/domain/training/vocabulary.ts';
import { shortDate } from './words.ts';

/** The plan's dated blocks: a stored program's summary or a generated plan fits. */
export interface TimelinePlan {
	/** The Monday of week 1. */
	startsOn: IsoDate;
	blocks: readonly Pick<
		BlockPlan,
		'phase' | 'name' | 'startsOn' | 'endsOn' | 'outline' | 'goalRefs'
	>[];
}

/** An M2 goal, as far as the timeline reads it. */
export type TimelineGoal = Pick<Goal, 'id' | 'title' | 'eventDate' | 'status'>;

/**
 * Decision (m3/37): the timeline marks the event of every goal the plan serves (a block's
 * goalRefs) whose date falls between week 1's Monday and the outline's last Sunday, except a
 * dropped goal's, which the plan no longer leads to. A paused goal's event stays: its block was
 * built around it. An event past the outline is planned later (blocks.ts), so it is not shown.
 */
export const EVENTS_LEFT_OUT: readonly GoalStatus[] = ['dropped'];

/** A dated goal in its week: 'Fight night', 'Sat 26 Dec'. */
export interface TimelineEvent {
	title: string;
	date: string;
}

export interface TimelineWeek {
	/** Its number in the program, from 1: Train's ?week. */
	number: number;
	/** 'Mon 9 Nov – Sun 15 Nov'. */
	dates: string;
	/** Its sessions are planned (an outline week's are not, until M6 plans its phase). */
	planned: boolean;
	/** It holds today. */
	current: boolean;
	events: TimelineEvent[];
}

export interface TimelineBlock {
	/** Its first day, which no other block shares. */
	key: IsoDate;
	name: string;
	/** Its phase, where the name does not already say it: 'Realization / peak'. */
	phase: string | null;
	/** 'Mon 9 Nov – Sun 6 Dec · 4 weeks'. */
	span: string;
	/** Dated, with its weeks not planned yet. */
	outline: boolean;
	/** It holds the week that holds today. */
	current: boolean;
	weeks: TimelineWeek[];
}

const weeksIn = (from: IsoDate, to: IsoDate) => (daysBetween(from, to) + 1) / 7;
const range = (from: IsoDate, to: IsoDate) => `${shortDate(from)} – ${shortDate(to)}`;

export function timelineView(
	{ startsOn, blocks }: TimelinePlan,
	{ today, goals }: { today: IsoDate; goals: readonly TimelineGoal[] }
): TimelineBlock[] {
	const served = new Set(blocks.flatMap((block) => block.goalRefs));
	const endsOn = blocks.reduce((end, block) => (block.endsOn > end ? block.endsOn : end), startsOn);
	const events = goals.flatMap((goal) =>
		goal.eventDate !== null &&
		served.has(goal.id) &&
		!EVENTS_LEFT_OUT.includes(goal.status) &&
		startsOn <= goal.eventDate &&
		goal.eventDate <= endsOn
			? [{ date: goal.eventDate, title: goal.title }]
			: []
	);

	return blocks.map((block): TimelineBlock => {
		const count = weeksIn(block.startsOn, block.endsOn);
		const weeks = Array.from({ length: count }, (_, i): TimelineWeek => {
			const monday = addDays(block.startsOn, 7 * i);
			const sunday = addDays(monday, 6);
			const within = (date: IsoDate) => monday <= date && date <= sunday;
			return {
				number: daysBetween(startsOn, monday) / 7 + 1,
				dates: range(monday, sunday),
				planned: !block.outline,
				current: within(today),
				events: events
					.filter((event) => within(event.date))
					.map((event) => ({ title: event.title, date: shortDate(event.date) }))
			};
		});
		const phase = PHASE_LABEL[block.phase];
		return {
			key: block.startsOn,
			name: block.name,
			phase: block.name.toLowerCase().startsWith(phase.toLowerCase()) ? null : phase,
			span: `${range(block.startsOn, block.endsOn)} · ${count} ${count === 1 ? 'week' : 'weeks'}`,
			outline: block.outline,
			current: weeks.some((week) => week.current),
			weeks
		};
	});
}
