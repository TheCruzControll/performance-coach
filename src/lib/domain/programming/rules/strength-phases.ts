/**
 * The strength block's phases as numbers (m7-plan strength-phases; PRD §5): what each week of
 * accumulation, intensification, realization, the meet taper and the meet's own week asks of the
 * main lifts, and the order of phases that peaks a lifter for a meet. periodisation/strength.ts
 * applies them. Every number is a coaching default (m7-plan risk 'Each scheme is a coaching
 * default'): changing one is a one-line edit here, and each entry carries its why.
 */
import type { ExperienceLevel } from '../../profile/catalog.ts';

/**
 * A phase's main-lift targets. `[from, to]` pairs run from the phase's first week to its last,
 * in even steps (a one-week phase takes `from`); RPE is rounded to the half step.
 */
export interface PhaseScheme {
	/** Main-lift sets against the block's base, first week to last. */
	setsFactor: readonly [from: number, to: number];
	/** The main lifts' rep range. */
	reps: readonly [min: number, max: number];
	/** The top set's RPE, first week to last; nothing that week is prescribed above it. */
	topRpe: readonly [from: number, to: number];
	/** Load change on the week before, as a share of the 1RM (0.025 = +2.5 %). */
	loadStep: number;
	/**
	 * Running volume against the block's base: a strength block holds it, and the running
	 * stream's own block changes it; the taper and the meet ease it as rules/blocks.ts does.
	 */
	runVolumeFactor: number;
	why: string;
}

/** The scheme of each week a strength block holds, by its role (kinds.ts BLOCK_WEEK_KINDS). */
export const PHASE_SCHEMES = {
	accumulation: {
		setsFactor: [1, 1.15],
		reps: [6, 8],
		topRpe: [7, 8],
		loadStep: 0.025,
		runVolumeFactor: 1,
		why: 'Moderate loads for more sets each week build the work capacity and muscle the heavier phases spend.'
	},
	intensification: {
		setsFactor: [0.85, 0.8],
		reps: [3, 5],
		topRpe: [8, 9],
		loadStep: 0.025,
		runVolumeFactor: 1,
		why: 'Fewer, heavier sets turn that capacity into strength, with volume eased so the heavier loads can rise.'
	},
	realization: {
		setsFactor: [0.6, 0.5],
		reps: [1, 3],
		topRpe: [8.5, 9.5],
		loadStep: 0.025,
		runVolumeFactor: 1,
		why: 'Peak weeks: heavy singles to triples at low volume practise near-maximal lifts while fatigue falls.'
	},
	meet_taper: {
		setsFactor: [0.5, 0.5],
		reps: [1, 2],
		topRpe: [8, 8],
		loadStep: 0,
		runVolumeFactor: 0.6,
		why: 'Half the sets, singles and doubles at RPE 8: strength is kept and fatigue clears before the meet.'
	},
	meet: {
		setsFactor: [0.4, 0.4],
		reps: [1, 1],
		topRpe: [7, 7],
		loadStep: 0,
		runVolumeFactor: 0.4,
		why: 'The meet’s own week: a few light singles early in the week to stay sharp, nothing that tires.'
	}
} as const satisfies Record<string, PhaseScheme>;

/** A strength week's role, as PHASE_SCHEMES and BLOCK_WEEK_KINDS.strength name it. */
export type StrengthRole = keyof typeof PHASE_SCHEMES;

/**
 * Openers in the meet taper: one single per lift at about 90 % of the e1RM, 4–5 days before the
 * meet, so the first attempt is rehearsed at a load that is sure to go.
 */
export const OPENERS = { e1rmShare: 0.9, daysOut: [4, 5] } as const;

/** The phases of a meet sequence that hold a block's training weeks, in order. */
export const MEET_PHASES = [
	'accumulation',
	'intensification',
	'realization',
	'meet_taper'
] as const;
export type MeetPhase = (typeof MEET_PHASES)[number];

/**
 * The weeks before a meet's own week:
 * - `weeks`: 4 accumulation, 3 intensification, 2 realization and 1 taper, the usual 10 weeks
 * - `grow`: a longer run-up adds weeks in this order, repeating (accumulation and intensification
 *   to 5 and 4 at 12 weeks, the 4 ± 1 and 3 ± 1 the plan sets, then on alternately)
 * - `cut`: a shorter one gives up weeks in this order: accumulation and intensification to 3 and 2
 *   (8 weeks), then, compressed, to 1 and 2 at 6 weeks (every phase, 2 realization weeks), then
 *   on down to the taper alone at 1 week; the taper is never cut
 * - `noRealization`: these levels plan their realization weeks as intensification, since a
 *   beginner still gains from every heavier week and has no near-maximal skill to sharpen
 */
export const MEET_SEQUENCE = {
	weeks: { accumulation: 4, intensification: 3, realization: 2, meet_taper: 1 },
	grow: ['accumulation', 'intensification'],
	cut: [
		'accumulation',
		'intensification',
		'accumulation',
		'accumulation',
		'intensification',
		'realization',
		'accumulation',
		'intensification',
		'realization'
	],
	noRealization: ['new', 'novice']
} as const satisfies {
	weeks: Record<MeetPhase, number>;
	grow: readonly Exclude<MeetPhase, 'meet_taper'>[];
	cut: readonly Exclude<MeetPhase, 'meet_taper'>[];
	noRealization: readonly ExperienceLevel[];
};
