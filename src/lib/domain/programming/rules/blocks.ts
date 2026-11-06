/**
 * The first block's shape, the outline's phases and each week's targets (PRD §5; m3-plan open
 * questions 'First block' and 'Several dated events'). blocks.ts applies them. A week's targets
 * are data that later stages and M4/M6 read: loads and sets (m3/21), running volume (m3/18).
 */
import type { WeekTargets } from '../../training/types.ts';
import type { Phase, WeekKind } from '../../training/vocabulary.ts';

/**
 * With no event shaping it: a baseline week that establishes your numbers, three weeks that
 * build on them and a deload that absorbs them. To try four weeks instead (the open question),
 * drop one accumulation week here.
 */
export const FIRST_BLOCK: readonly WeekKind[] = [
	'baseline',
	'accumulation',
	'accumulation',
	'accumulation',
	'deload'
];

/**
 * An event fewer whole weeks away than this is too close for a full block: the block builds
 * straight to it from the baseline week and tapers.
 */
export const SHORT_EVENT_WEEKS = 6;

/**
 * An event's taper is the Monday-to-Sunday week holding the day this many days before it, so
 * the taper holds most of the seven days before the event: a Saturday fight tapers in its own
 * week, a Monday race in the week before.
 */
export const TAPER_LEAD_DAYS = 4;

/**
 * The outline's phases toward the event it leads to, in order, with their weeks: the fixed ones
 * are kept from the event backwards, and `null` takes the weeks left. A marathon base already
 * planned as the first block is not repeated.
 */
export const OUTLINES = {
	// About three weeks of peak mileage and a three-week taper for a full marathon…
	marathon: [
		['marathon_base', 4],
		['marathon_build', null],
		['marathon_peak', 3],
		['marathon_taper', 3]
	],
	// …and two of each for a half.
	half: [
		['marathon_base', 4],
		['marathon_build', null],
		['marathon_peak', 2],
		['marathon_taper', 2]
	],
	// A fight, a meet or a shorter race: build, two weeks of peak, then a week's taper.
	event: [
		['intensification', null],
		['realization', 2],
		['taper', 1]
	]
} as const satisfies Record<string, readonly (readonly [Phase, number | null])[]>;

/**
 * A building week (accumulation or build) by its step in the block: +0.5 RPE a week to 8.5,
 * loads +2.5 % a week, a set more in the third week, and running at most +10 % a week.
 */
const BUILDING: readonly WeekTargets[] = [
	{ rpeCap: 7.5, volumeFactor: 1, loadStep: 0.025, runVolumeFactor: 1.1 },
	{ rpeCap: 8, volumeFactor: 1, loadStep: 0.025, runVolumeFactor: 1.2 },
	{ rpeCap: 8.5, volumeFactor: 1.1, loadStep: 0.025, runVolumeFactor: 1.3 }
];

const FIXED: Partial<Record<WeekKind, WeekTargets>> = {
	// Week 1 establishes your numbers, so nothing in it goes above RPE 7.
	baseline: { rpeCap: 7, volumeFactor: 1, loadStep: 0, runVolumeFactor: 1 },
	// 40 % fewer sets at RPE 6 at most, so the block's fatigue clears.
	deload: { rpeCap: 6, volumeFactor: 0.6, loadStep: -0.1, runVolumeFactor: 0.7 },
	// Less volume at the same intensity, so you arrive fresh and sharp.
	taper: { rpeCap: 8, volumeFactor: 0.6, loadStep: 0, runVolumeFactor: 0.6 },
	// The event's own week: little besides staying loose.
	event: { rpeCap: 7, volumeFactor: 0.4, loadStep: 0, runVolumeFactor: 0.4 }
};

/** A week's targets by its kind and, for a building week, its step from 0. */
export function weekTargets(kind: WeekKind, step: number): WeekTargets {
	return { ...(FIXED[kind] ?? BUILDING[Math.min(step, BUILDING.length - 1)]!) };
}
