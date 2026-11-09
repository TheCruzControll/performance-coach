/**
 * The concurrent-training rules beyond M3's (PRD §2 and §5; m7/20 concurrent-load-rules): what the
 * load model and goal priorities make possible. evaluate/concurrent.ts applies them inside
 * evaluateWeek; the rules registry lists them (registry/concurrent.ts).
 *
 * Every number is a coaching judgement and a default (m7-plan open question on the coaching
 * numbers), so each carries its reason and a change is one edit here.
 */
import type { ExperienceLevel, TimeOfDay } from '../../profile/catalog.ts';
import type { Phase, WeekKind } from '../../training/vocabulary.ts';
import type { LoadSystem } from '../evaluate/types.ts';
import type { SessionDemand } from '../interference.ts';
import { weekTargets } from './blocks.ts';
import type { EventKind } from './priority.ts';
import { HARD_SET_RANGES } from './volume.ts';

/**
 * The clock hour each time of day stands for, to judge the gap between two sessions on one day.
 * 'varies' has none: a session at no set time is never judged on its gap.
 */
export const SLOT_HOURS = {
	early_morning: 5,
	morning: 7,
	midday: 12,
	afternoon: 16,
	evening: 19
} as const satisfies Readonly<Partial<Record<TimeOfDay, number>>>;

/**
 * Two hard sessions on one day need this many hours between them: about what the legs and the
 * nervous system need to give the second session a fair start.
 */
export const SEPARATION_HOURS = 6;

/** The most days a week with a hard session, by experience: recovery grows with training age. */
export const HARD_DAYS_CAP = {
	new: 2,
	novice: 3,
	intermediate: 4,
	advanced: 5
} as const satisfies Record<ExperienceLevel, number>;

/**
 * The most sessions a week that tax the nervous system (heavy lifting, intervals or sparring),
 * and the most hard sparring sessions a week (fight camp's cap).
 */
export const CNS_SESSIONS_MAX = 3;
export const SPARRING_MAX = 2;

/**
 * When a week's running is high, so leg lifting is held to maintenance: an aerobic acute:chronic
 * ratio of at least `aerobicRatio` (M1's, which exists after 28 days of history), or any week of a
 * marathon or half marathon build or peak phase, whatever the history.
 */
export const RUN_LOAD_HIGH = {
	aerobicRatio: 1.3,
	phases: ['marathon_build', 'marathon_peak', 'half_build', 'half_peak'],
	/** The leg lifting allowed in such a week: M3's maintenance band, read live. */
	band: HARD_SET_RANGES.maintenance.sets
} as const satisfies { aerobicRatio: number; phases: readonly Phase[]; band: readonly number[] };

/**
 * How close to an event each kind of session may come, in days: heavy lower body at least 5 days
 * before a race, sparring at least 7 before a fight, and nothing heavier than openers (RPE 8, 90 %
 * of a 1RM) in the 4 days before a meet.
 */
export const EVENT_LEAD_DAYS = {
	race: { days: 5, kinds: ['marathon', 'half', 'other'] },
	fight: { days: 7, kinds: ['fight'] },
	meet: { days: 4, kinds: ['meet'], openerRpe: 8, openerFraction: 0.9 }
} as const satisfies Record<
	string,
	{ days: number; kinds: readonly EventKind[]; openerRpe?: number; openerFraction?: number }
>;

/**
 * The most a light week's sessions may ask: no set above `rpeCap`, the week's own targets when the
 * caller passes them. The deload and taper caps are M3's own week targets, read live. A cutback
 * week limits only its running, to its planned running minutes: strength and Muay Thai train
 * through it.
 */
export const LIMITED_WEEKS = {
	deload: { rpeCap: weekTargets('deload', 0).rpeCap },
	taper: { rpeCap: weekTargets('taper', 0).rpeCap },
	recovery: { rpeCap: 6 },
	maintenance: { rpeCap: 8 }
} as const satisfies Partial<Record<WeekKind, { rpeCap: number }>>;
export const CUTBACK_KIND = 'cutback' satisfies WeekKind;

/** The demands M3 calls hard and the systems whose fatigue matters before each. */
export type HardDemand = Extract<
	keyof SessionDemand,
	'heavyLower' | 'heavyUpper' | 'intervals' | 'longRun' | 'hardCombat'
>;
export const INTERFERES_WITH = {
	heavyLower: ['lower', 'cns'],
	intervals: ['lower', 'aerobic', 'cns'],
	longRun: ['lower', 'aerobic'],
	hardCombat: ['combat', 'lower', 'cns'],
	heavyUpper: ['upper', 'cns']
} as const satisfies Record<HardDemand, readonly LoadSystem[]>;

/** The rules, in the order they are listed within a day, each with its severity and reason. */
export const CONCURRENT_RULES = {
	residual_fatigue_before_hard: {
		severity: 'avoid',
		headline: 'A hard session on an overloaded system',
		why: 'A system still carrying more than its usual fatigue cannot give a hard session its best, and pushing it again raises the injury risk.'
	},
	three_hard_days: {
		severity: 'avoid',
		headline: 'Three hard days in a row',
		why: 'Fatigue stacks over three hard days with no easier day between, so the third is done badly and recovery falls behind. Fixed commitments alone are left as they are.'
	},
	hard_days_cap: {
		severity: 'prefer',
		headline: 'More hard days than your experience recovers from',
		why: 'Recovery grows with training age: a newer athlete gains most from fewer hard days, each done well.'
	},
	weekly_cns_cap: {
		severity: 'prefer',
		headline: 'Many sessions that tax the nervous system',
		why: 'Heavy lifting, intervals and sparring all draw on the nervous system, which recovers slowly when they pile up.'
	},
	run_volume_vs_leg_strength: {
		severity: 'prefer',
		headline: 'Leg lifting above maintenance in a high-running week',
		why: 'High running volume already loads the legs, so lower-body lifting is held to its maintenance dose until the mileage comes down.'
	},
	same_day_priority_order: {
		severity: 'prefer',
		headline: 'The higher-priority session comes second',
		why: 'When one day holds two hard sessions, the first is done fresh: it goes to the goal that ranks higher. This replaces M3’s fixed order when priorities are known.'
	},
	same_day_separation: {
		severity: 'avoid',
		headline: 'Two sessions too close together',
		why: 'Two hard sessions need about six hours between them, so the second starts recovered; a hard and a moderate one are better apart too.'
	},
	event_protection: {
		severity: 'avoid',
		headline: 'Too close to your event',
		why: 'The days before an event are for arriving fresh: no heavy legs before a race, no sparring the week before a fight, nothing heavier than openers before a meet.'
	},
	recovery_week_limits: {
		severity: 'avoid',
		headline: 'Harder than this light week allows',
		why: 'A deload, taper, recovery or maintenance week is light on purpose, so the fatigue clears; a cutback week lightens only the running.'
	},
	sparring_cap: {
		severity: 'avoid',
		headline: 'More hard sparring than a week allows',
		why: 'Hard sparring is the most damaging session in Muay Thai: two a week is the most a camp can recover from.'
	}
} as const satisfies Record<
	string,
	{ severity: 'avoid' | 'prefer'; headline: string; why: string }
>;
export type ConcurrentRule = keyof typeof CONCURRENT_RULES;

/** same_day_separation is a preference, not a rule, when only one of the two sessions is hard. */
export const SEPARATION_MODERATE_SEVERITY = 'prefer' as const;
