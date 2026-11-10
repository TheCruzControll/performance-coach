/**
 * Tapers (M7, PRD §5): how every event is tapered, by its kind and by the goal's priority.
 * periodisation/taper.ts applies them; the rules registry (registry/taper.ts) lists each with its
 * why. A taper cuts volume and keeps intensity. Every number is a coaching default the owner can
 * change in one line here (m7-plan open question on the coaching numbers).
 */
import type { GoalMode } from '../evaluate/types.ts';
import type { EventKind } from './priority.ts';
import { TAPER_LEAD_DAYS, weekTargets } from './blocks.ts';
import { OPENERS, PHASE_SCHEMES } from './strength-phases.ts';

/**
 * A full taper: its weeks' volume factors, first week first, against each week as it is planned.
 * Its last week is the Monday-to-Sunday week holding the day TAPER_LEAD_DAYS (M3's) before the
 * event, so a Saturday race tapers through its own week and a Monday race through the week before.
 */
export interface FullTaper {
	factors: readonly number[];
	/** An endurance taper keeps one short strength session a week, at least `daysOut` days out. */
	endurance: boolean;
	why: string;
}

export const TAPERS = {
	marathon: {
		factors: [0.8, 0.6, 0.4],
		endurance: true,
		why: 'Three weeks at 80, 60 and 40 % of your volume clear a marathon build’s fatigue while the quality sessions keep you sharp.'
	},
	half: {
		factors: [0.7, 0.5],
		endurance: true,
		why: 'A half needs less fatigue cleared than a marathon: two weeks at 70 and 50 % is enough.'
	},
	/** A 5K to 10K race. */
	other: {
		factors: [0.6],
		endurance: true,
		why: 'A 5K to 10K costs little to prepare for: one week at 60 % with the faster work kept.'
	},
	meet: {
		factors: [PHASE_SCHEMES.meet_taper.setsFactor[0]],
		endurance: false,
		why: 'One week at half the sets, with openers rehearsed 4–5 days out and nothing heavy for the legs in the last 3 days, so you lift fresh.'
	},
	/**
	 * Per fight-camp: the fight's week is the camp's technical fight week, which fight-camp plans;
	 * this is only its length and M3's taper volume.
	 */
	fight: {
		factors: [weekTargets('taper', 0).volumeFactor],
		endurance: false,
		why: 'The fight week is the camp’s technical week: little volume, timing kept sharp, nothing that leaves a mark.'
	}
} as const satisfies Record<EventKind, FullTaper>;

/** Kept intensity, and an endurance taper's one short strength session. */
export const TAPER_SESSIONS = {
	keepsIntensity: true,
	strength: { perWeek: 1, daysOut: 4 },
	/** The last taper week's Muay Thai is technical (a commitment keeps its class). */
	lastWeekMuayThai: 'technical',
	leadDays: TAPER_LEAD_DAYS,
	why: 'Volume, not intensity, carries fatigue, so a taper keeps its pace and loads and cuts the amount. One short strength session a week keeps strength through an endurance taper, and none within 4 days leaves the legs fresh.'
} as const;

/** The meet's openers and its last heavy lower-body day (OPENERS, strength-phases' own). */
export const MEET_TAPER = {
	openers: OPENERS,
	noHeavyLowerDays: 3,
	why: 'The first attempt is rehearsed at about 90 % 4–5 days out; the last 3 days carry nothing heavy for the legs so squat and deadlift are fresh.'
} as const;

/**
 * A taper by the goal's priority mode (evaluate/types.ts GoalMode): the leading goal gets its full
 * taper, a secondary event a mini-taper of the `days` days before it at `factor`, and a goal held at
 * maintenance is trained through.
 */
export const BY_PRIORITY = {
	primary: 'full',
	secondary: { days: 3, factor: 0.6 },
	maintenance: 'train_through',
	why: 'A full taper costs a week or more of training, so only the goal that leads gets one; a secondary event gets three easier days, and a low-priority event is a hard training day.'
} as const satisfies Record<GoalMode, unknown> & { why: string };
