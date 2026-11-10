/**
 * Muay Thai fight camps (M7, PRD §5): the run-up to a fight as week plans, with sparring load
 * that builds and then stops in time, conditioning, strength at maintenance and a technical fight
 * week. periodisation/fight-camp.ts applies these; the rules registry (registry/fight-camp.ts)
 * lists each with its why. Every number is a coaching default the owner can change in one line
 * here (m7-plan open question on the coaching numbers).
 *
 * Weight cutting is out of scope: the camp plans training only (WEIGHT_CUT).
 */
import type { ExperienceLevel } from '../../profile/catalog.ts';
import { EVENT_LEAD_DAYS, SPARRING_MAX } from './concurrent.ts';
import { DOSES } from './maintenance.ts';
import { MUAY_THAI } from './running.ts';

/** A rising number: `from` in a stretch's first week, `to` in its last, evenly between. */
export interface Ramp {
	from: number;
	to: number;
}

/**
 * How long a camp runs, the fight week included: 6–8 weeks, by experience when the fight is far
 * enough away (an experienced fighter's body absorbs a longer build), and down to `min` weeks as a
 * short camp when it is closer. With less than `min` weeks there is no camp to plan.
 */
export const CAMP_WEEKS = {
	min: 3,
	full: { min: 6, max: 8 },
	byLevel: { new: 6, novice: 6, intermediate: 7, advanced: 8 },
	why: 'Six to eight weeks is long enough to build fight fitness and sparring sharpness and short enough to hold them; three weeks is the least that still builds before it tapers.'
} as const satisfies {
	min: number;
	full: { min: number; max: number };
	byLevel: Record<ExperienceLevel, number>;
	why: string;
};

/**
 * Muay Thai sessions a week across the camp's building weeks, never more than the owner's
 * available sessions. A hard class the owner attends counts toward the hard sparring below.
 */
export const MUAY_THAI_SESSIONS = {
	ramp: { from: 3, to: 5 },
	minutes: 60,
	hardClassCountsAsSparring: true,
	why: 'Fight-specific skill and fitness come from Muay Thai itself, so it rises from 3 to 5 sessions as the camp builds; a hard class hits like sparring, so it counts as sparring.'
} as const satisfies {
	ramp: Ramp;
	minutes: number;
	hardClassCountsAsSparring: boolean;
	why: string;
};

/** Hard sparring a week, and rounds a session, across the building weeks; at most SPARRING_MAX. */
export const HARD_SPARRING = {
	ramp: { from: 1, to: SPARRING_MAX },
	max: SPARRING_MAX,
	rounds: { from: 4, to: 8 },
	why: 'Hard sparring is the most damaging session in Muay Thai: it builds from one session of 4 rounds to two of 8, and never goes past two a week.'
} as const satisfies { ramp: Ramp; max: number; rounds: Ramp; why: string };

/** The last hard sparring is at least this many days before the fight (concurrent's own lead). */
export const LAST_HARD_SPARRING = {
	daysOut: EVENT_LEAD_DAYS.fight.days,
	why: 'A week without hard sparring lets bruises and small knocks heal, so you walk out fresh and unhurt.'
} as const;

/**
 * Conditioning: `sessions` a week of `roundMinutes`-minute rounds, rising from 6 to 10 rounds a
 * session, in weeks 2 to n − 1 only (the first week settles in, the fight week sharpens).
 */
export const CONDITIONING = {
	sessions: 2,
	roundMinutes: MUAY_THAI.roundMinutes,
	rounds: { from: 6, to: 10 },
	fromWeek: 2,
	why: 'Rounds as long as a fight’s build the fitness to last five of them; the first week eases in and the fight week leaves them out so you arrive fresh.'
} as const satisfies {
	sessions: number;
	roundMinutes: number;
	rounds: Ramp;
	fromWeek: number;
	why: string;
};

/**
 * Strength at its maintenance dose (rules/maintenance.ts DOSES.strength), biased to power, and
 * none in the last `noneInLastDays` days before the fight.
 */
export const STRENGTH = {
	sessions: 2,
	bias: 'power',
	dose: DOSES.strength,
	noneInLastDays: 4,
	why: 'Two short, fast strength sessions keep the strength and snap you have without the soreness that would cost sparring; the last four days are left clear so your legs are fresh.'
} as const;

/** The fight week: technique and light pads, no hard sparring and no conditioning. */
export const FIGHT_WEEK = {
	sessions: 3,
	formats: ['technical', 'pad_work'],
	rpe: 5,
	minutes: 45,
	why: 'The fight week keeps timing sharp with technique and light pads; the fitness is built, and anything hard now only leaves a mark.'
} as const;

/** Weight cutting is not planned, advised or tracked: a camp plans training only. */
export const WEIGHT_CUT = {
	inScope: false,
	why: 'Making weight safely needs a coach and often a dietitian who can see you; the app plans your training and leaves your weight to them.'
} as const;
