/**
 * Goal priority (M7, PRD §2 and §5): which goal leads on a date, which trains alongside it and
 * which is held at maintenance. priority/weights.ts applies these; the rules registry
 * (registry/priority.ts) lists each with its why. Every number is a default the owner can change
 * here (m7-plan open questions on event proximity and on the coaching numbers).
 */
import type { Phase } from '../../training/vocabulary.ts';
import { BLOCK_PHASES } from '../periodisation/kinds.ts';

/**
 * A goal's weight by its place on a date, the leader first: findings that harm a goal cost its
 * weight, so the leader's sessions are protected first. Places past the last share its weight.
 */
export const RANK_WEIGHTS = [1, 0.6, 0.4, 0.25, 0.15] as const;

/** What an event goal is, for its lead window. */
export type EventKind = 'fight' | 'marathon' | 'half' | 'meet' | 'other';

/**
 * How many weeks before its event an event goal takes the lead. With 0, an event never leads by
 * proximity and rank always wins.
 */
export const LEAD_WEEKS = {
	fight: { weeks: 8, why: 'A fight camp runs 6 to 8 weeks, and it needs the week’s best days.' },
	marathon: {
		weeks: 16,
		why: 'A marathon build needs about 16 weeks of rising mileage before race day.'
	},
	half: { weeks: 12, why: 'A half marathon’s build is about 12 weeks.' },
	meet: {
		weeks: 10,
		why: 'Meet prep peaks the competition lifts over about 10 weeks of heavier, more specific work.'
	},
	other: {
		weeks: 6,
		why: 'A shorter race or any other event needs about 6 weeks of specific work.'
	}
} as const satisfies Record<EventKind, { weeks: number; why: string }>;

/**
 * Who leads. Inside its lead window, an event goal leads over every goal whose own event is
 * outside its window; two in-window events go by rank. A passed event drops out of the window,
 * so rank order returns. With windowBeatsRank false, rank always wins (the open question's other
 * answer).
 */
export const LEAD = {
	windowBeatsRank: true,
	inWindowTieBreak: 'rank',
	passedEvent: 'drops_out'
} as const;

/**
 * A goal trains alongside the leader, as secondary, when its weight is at least this share of the
 * leader's and it does not conflict with it; any other goal is held at maintenance.
 */
export const SECONDARY_SHARE = 0.5;

/** What a goal emphasises, as a conflict reads it. */
export type Emphasis = 'hypertrophy' | 'strength';

/**
 * Pairs that cannot both progress: while the leader is an event of `leader` kind in one of
 * `phases`, a goal with `against` emphasis is held at maintenance. With no phase known,
 * `inWindow` says whether the conflict holds while the leader is inside its lead window.
 */
export const CONFLICTS = [
	{
		id: 'fight_camp_hypertrophy',
		leader: 'fight',
		phases: ['fight_camp'],
		inWindow: true,
		against: 'hypertrophy',
		why: 'Fight camp’s sparring and conditioning leave no recovery for building muscle, and new mass fights the weight class.'
	},
	{
		id: 'marathon_build_hypertrophy',
		leader: 'marathon',
		phases: ['marathon_build', 'marathon_peak'],
		inWindow: true,
		against: 'hypertrophy',
		why: 'A marathon build’s mileage takes the recovery that building muscle needs, and the extra mass slows the run.'
	},
	{
		id: 'marathon_peak_strength',
		leader: 'marathon',
		phases: ['marathon_peak', 'marathon_taper'],
		inWindow: false,
		against: 'strength',
		why: 'Peak mileage and the taper need fresh legs, so heavy lifting only holds what you have.'
	},
	{
		id: 'meet_prep_hypertrophy',
		leader: 'meet',
		phases: BLOCK_PHASES.strength,
		inWindow: true,
		against: 'hypertrophy',
		why: 'Meet prep trains the competition lifts heavy and specific; high-rep volume for size would blunt the peak.'
	}
] as const satisfies readonly {
	id: string;
	leader: EventKind;
	phases: readonly Phase[];
	inWindow: boolean;
	against: Emphasis;
	why: string;
}[];

/** With every open goal paused (M3's input.maintenance), each is at maintenance and none leads. */
export const ALL_PAUSED = {
	mode: 'maintenance',
	leads: false,
	reason: 'Every goal is paused, so each is kept at maintenance.'
} as const;
