/**
 * The season's windows (M7, PRD §2 and §5): who leads each stretch of the season. Each event gets
 * a run-up window led by its goal, overlapping windows are resolved by rank, the weeks between
 * them go to the leading undated goal, and maintenance blocks fill what nothing builds through.
 * periodisation/windows.ts applies these; the rules registry (registry/season.ts) lists each with
 * its why. Every number and choice is a default the owner can change in one line here (m7-plan
 * open questions on event proximity and on maintenance blocks).
 */
import type { Discipline } from '../../profile/catalog.ts';
import type { Phase } from '../../training/vocabulary.ts';
import { BLOCK_PHASES } from '../periodisation/kinds.ts';
import type { BlockType } from '../periodisation/kinds.ts';
import { OUTLINES } from './blocks.ts';
import { CAMP_WEEKS } from './fight-camp.ts';
import { LEAD_WEEKS } from './priority.ts';
import type { EventKind } from './priority.ts';
import { BY_PRIORITY, TAPERS } from './taper.ts';

/**
 * An event's window: the weeks before it, its own week included, that its goal leads. The length
 * is the event's lead window (rules/priority.ts), which the phase rules fill: a fight camp runs
 * at most CAMP_WEEKS.full.max weeks and a meet sequence is MEET_SEQUENCE's 10. A window shorter
 * than `taperOnlyUnder` weeks, or than its taper and one more week, holds only the taper.
 */
export const WINDOW = {
	weeks: {
		fight: LEAD_WEEKS.fight.weeks,
		marathon: LEAD_WEEKS.marathon.weeks,
		half: LEAD_WEEKS.half.weeks,
		meet: LEAD_WEEKS.meet.weeks,
		other: LEAD_WEEKS.other.weeks
	},
	/** The M7 block type a window is; null plans M3's event outline (a shorter race, say). */
	blockType: {
		fight: 'fight_camp',
		marathon: 'marathon',
		half: 'half',
		meet: 'strength',
		other: null
	},
	phases: {
		fight: BLOCK_PHASES.fight_camp,
		marathon: BLOCK_PHASES.marathon,
		half: BLOCK_PHASES.half,
		meet: BLOCK_PHASES.strength,
		other: OUTLINES.event.map(([phase]) => phase)
	},
	/** The phase a taper-only window, and the taper of a full one, is planned in. */
	taperPhase: {
		fight: 'taper',
		marathon: 'marathon_taper',
		half: 'half_taper',
		meet: 'taper',
		other: 'taper'
	},
	taperOnlyUnder: CAMP_WEEKS.min,
	why: 'Each event needs its own run-up, as long as its phases take: a fight camp 8 weeks, a marathon build 16, a half 12, meet prep 10 and a shorter race 6. Closer than 3 weeks there is nothing left to build, so only the taper is planned.'
} as const satisfies {
	weeks: Record<EventKind, number>;
	blockType: Record<EventKind, BlockType | null>;
	phases: Record<EventKind, readonly Phase[]>;
	taperPhase: Record<EventKind, Phase>;
	taperOnlyUnder: number;
	why: string;
};

/** The weeks a taper-only window is shorter than, for an event of `kind`. */
export const taperOnlyUnder = (kind: EventKind) =>
	Math.max(WINDOW.taperOnlyUnder, TAPERS[kind].factors.length + 1);

/**
 * Where two windows overlap, the higher-ranked event keeps its weeks, its peak and its taper. The
 * other goal is held at maintenance through the overlap, and an event of its own that falls inside
 * gets a mini-taper (rules/taper.ts BY_PRIORITY.secondary), unless that would put two tapers in one
 * week, when it is trained through.
 */
export const OVERLAP = {
	held: 'maintenance',
	eventInside: BY_PRIORITY.secondary,
	tapersPerWeek: 1,
	why: 'Two peaks at once means neither is a real peak, so the event you rank higher keeps its build and taper; the other is held, and its own day gets three easier days before it, never a second taper in the same week.'
} as const;

/** The recovery weeks after an event its window holds, by its kind. */
export const RECOVERY = {
	weeks: { fight: 1, marathon: 2, half: 0, meet: 0, other: 0 },
	why: 'A fight and a marathon take more out of you than a training week can see: one easy week after a fight and two after a marathon let the damage heal before anything builds again.'
} as const satisfies { weeks: Record<EventKind, number>; why: string };

/**
 * Between windows, the leading undated goal's block type, by its first discipline: a goal whose
 * discipline has no M7 block type plans M3's accumulation. A 'keep' goal (its title or focus
 * starts with keep, maintain or hold) never wants a building block.
 */
export const FILL = {
	blockType: {
		hypertrophy: 'hypertrophy',
		strength: 'strength',
		powerlifting: 'strength',
		weightlifting: 'strength'
	},
	phases: {
		hypertrophy: BLOCK_PHASES.hypertrophy,
		strength: ['accumulation', 'intensification', 'realization'],
		none: ['accumulation']
	},
	keep: /^\s*(keep|maintain|hold)\b/i,
	why: 'With no event near, your top-ranked goal without an event date sets what the block builds, and the rest train alongside or are held as their ranks allow.'
} as const satisfies {
	blockType: Partial<Record<Discipline, BlockType>>;
	phases: Record<'hypertrophy' | 'strength' | 'none', readonly Phase[]>;
	keep: RegExp;
	why: string;
};

/** Where the season is a maintenance block: every goal at its dose, none leading. */
export const MAINTENANCE = {
	paused: {
		why: 'Every goal is paused, so the whole season holds each one at its dose, as the plan always has.'
	},
	shortGap: {
		weeks: 4,
		why: 'Fewer than 4 weeks between a recovery and the next run-up is too short for a building block to pay off, so the gap holds everything at its dose.'
	},
	noBuildingGoal: {
		why: 'After the last event, or in an off-season of keep goals, no goal wants a building block, so the season holds every goal at its dose.'
	}
} as const;

/**
 * The season's first weeks, when fewer than `weeks` come before the first window and that
 * window's goal already leads on the first day, join the window rather than make a block too
 * short to build anything.
 */
export const LEAD_IN = {
	weeks: 4,
	why: 'A block of a week or two builds nothing; when the event that comes first already leads, its run-up simply starts now.'
} as const;
