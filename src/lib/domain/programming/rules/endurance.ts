/**
 * Marathon and half-marathon blocks as numbers (m7-plan endurance-blocks; PRD §5): how long each
 * phase runs, how fast the weekly mileage and the long run grow, the cutbacks, the race-specific
 * work by phase, and strength in the last weeks. periodisation/endurance.ts applies them; the
 * rules registry (registry/endurance.ts) lists each with its why. Every number is a coaching
 * default the owner can change in one line here (m7-plan open question 'Marathon defaults').
 *
 * The weekly growth, quality sessions and long-run share of each phase are its hooks: M3's
 * MARATHON_HOOKS for a marathon, read live, and HALF_HOOKS below for a half, both through
 * hooksFor. The taper's factors are rules/taper.ts's, and the peak's length is M3's OUTLINES.
 */
import type { Phase } from '../../training/vocabulary.ts';
import { MARATHON_HOOKS, RUN_WEEKLY_INCREASE_MAX } from './running.ts';

/** The endurance events a block prepares for. */
export type EnduranceEvent = 'marathon' | 'half';

/** A race-specific workout, as WeekTargets.running.raceSpecific names it. */
export type RaceWork = 'marathon_pace' | 'threshold' | 'intervals';

/** A phase's hooks: its growth cap, quality sessions a week and long-run share (MARATHON_HOOKS). */
export type PhaseHooks = Readonly<Record<string, number>>;

/**
 * A half's own phases, in MARATHON_HOOKS' shape: the same growth and long-run share as a
 * marathon, a second quality session in build, and a taper at 60 % of its volume.
 */
export const HALF_HOOKS: Readonly<Partial<Record<Phase, Record<string, number>>>> = {
	// Base: easy volume climbs, with one quality session a week.
	half_base: { runWeeklyIncreaseMax: 0.1, qualityPerWeek: 1, longRunShareMax: 0.3 },
	// Build: a threshold run and 10K-pace intervals every week.
	half_build: { runWeeklyIncreaseMax: 0.1, qualityPerWeek: 2, longRunShareMax: 0.3 },
	// Peak: the biggest weeks are held, with both quality sessions kept.
	half_peak: { runWeeklyIncreaseMax: 0, qualityPerWeek: 2, longRunShareMax: 0.3 },
	// Taper: volume falls to race day while one quality session stays.
	half_taper: { runVolumeFactor: 0.6, qualityPerWeek: 1, longRunShareMax: 0.3 }
};

/**
 * A phase's hooks: a marathon_* phase reads M3's MARATHON_HOOKS, a half_* phase HALF_HOOKS, and
 * any other phase has none.
 */
export function hooksFor(phase: Phase): PhaseHooks | undefined {
	if (phase.startsWith('marathon_')) return MARATHON_HOOKS[phase];
	if (phase.startsWith('half_')) return HALF_HOOKS[phase];
	return undefined;
}

/** The endurance rules, one entry per rule key (rules/registry/endurance.ts). */
export const ENDURANCE = {
	/**
	 * Base and build weeks, [fewest, most], before the peak (OUTLINES' length) and the taper
	 * (TAPERS' weeks). A short runway takes weeks from the base first, then the build; the taper
	 * is always kept.
	 */
	phases: {
		marathon: { base: [4, 6], build: [6, 8] },
		half: { base: [3, 4], build: [4, 6] },
		why: 'Base builds the mileage, build adds the race-specific work and peak holds the biggest weeks; when time is short the base gives way first, because the taper and the race-specific weeks matter most on race day.'
	},
	/** Each week grows at most its phase's runWeeklyIncreaseMax over the biggest week before. */
	increase: {
		max: RUN_WEEKLY_INCREASE_MAX,
		why: 'Mileage that grows by a tenth a week at most gives tendons and bones time to adapt, which is where running injuries start.'
	},
	/**
	 * The one recorded exception: a weekly level held in the last `withinWeeks` weeks may be
	 * regained at up to `max` a week, never above that level.
	 */
	regain: {
		max: 0.2,
		withinWeeks: 8,
		why: 'Mileage you ran in the last two months comes back faster than new mileage builds, so regaining it may go up to a fifth a week.'
	},
	/** Every `every`th week of base and build is a cutback at `factor` of the biggest week. */
	cutback: {
		every: 4,
		factor: 0.8,
		why: 'A lighter week every fourth lets the body absorb three weeks of growth, so the build stays sustainable.'
	},
	/**
	 * The long run grows `stepMetres` a week over the longest so far, within its phase's
	 * longRunShareMax of the week and the event's cap: the shorter of `metres` and `minutes`.
	 */
	long_run: {
		stepMetres: 1500,
		cap: { marathon: { metres: 32_000, minutes: 180 }, half: { metres: 22_000, minutes: 180 } },
		why: 'A kilometre and a half more a week builds endurance without a long run outgrowing the week; past 32 km or three hours a long run costs more recovery than it adds fitness.'
	},
	/**
	 * A week's mileage never passes `maxFactor` of the block's first week, which also keeps it
	 * inside the stored targets' range.
	 */
	ceiling: {
		maxFactor: 2,
		why: 'Doubling your mileage in one block is already a big build; more than that belongs in the next block.'
	},
	/** Race-specific work by event and phase, the week's main workout first. */
	race_work: {
		marathon: {
			base: [],
			build: ['marathon_pace', 'threshold'],
			peak: ['marathon_pace', 'threshold'],
			taper: ['marathon_pace']
		},
		half: {
			base: [],
			build: ['threshold', 'intervals'],
			peak: ['intervals', 'threshold'],
			taper: ['threshold']
		},
		why: 'Race pace is trained once the base is built: a marathon at marathon pace and threshold, a half at threshold and 10K pace, with one session kept in the taper to stay sharp.'
	},
	/**
	 * Marathon-pace work: steady segments at M pace (m7-contract: no new segment kind), labelled,
	 * for a share of the long run that climbs over the build and stays at the top in peak; in the
	 * taper, the build's first share.
	 */
	marathon_pace: {
		segment: 'steady',
		label: 'at marathon pace',
		share: [0.2, 0.4],
		rpe: 6,
		why: 'Running part of the long run at marathon pace teaches race rhythm on tired legs; a fifth to two fifths of it is enough without turning the long run into a race.'
	},
	/** Threshold runs are tempo segments; 10K-pace intervals run between T's fast end and I's slow end. */
	quality: {
		threshold: { segment: 'tempo', label: 'at threshold pace' },
		intervals: { segment: 'interval', label: 'at 10K pace' },
		why: 'Threshold running raises the pace a half is raced at, and 10K-pace repeats make that pace feel controlled.'
	},
	/**
	 * In peak and taper, strength is held at its maintenance dose, at most `rpeCap`, with nothing
	 * heavy for the lower body in the `noHeavyLowerDays` days before the race.
	 */
	strength: {
		maintenanceIn: ['peak', 'taper'],
		rpeCap: 8,
		noHeavyLowerDays: 5,
		why: 'Once the running is at its biggest, strength only needs keeping; heavy leg work in the last five days would leave the legs sore on race day.'
	}
} as const satisfies Record<string, { why: string; [value: string]: unknown }>;
