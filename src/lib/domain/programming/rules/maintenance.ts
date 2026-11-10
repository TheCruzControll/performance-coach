/**
 * Maintenance doses (M7, PRD §2 and §5): the smallest weekly dose that keeps a goal while another
 * leads, and the maintenance block that holds every goal at its dose. priority/doses.ts and
 * periodisation/maintenance.ts apply these; the rules registry (registry/maintenance.ts) lists
 * each with its why.
 *
 * Strength and muscle building at maintenance are M3's own maintenance split, read live from
 * rules/strength.ts and rules/volume.ts: there is no second band here, so the doses move only
 * where M3's constants move. Every other number is a coaching default the owner can change in one
 * line (m7-plan open question 'Maintenance doses').
 */
import { HARD_SET_RANGES } from './volume.ts';
import { LAYOUTS, STYLES } from './strength.ts';

/** What a dose is given to: rules/days.ts's streams, with strength split by its style. */
export type DoseStream = 'strength' | 'hypertrophy' | 'runs' | 'muay_thai' | 'custom';

/** Sessions a week: never fewer than one, so a dosed goal is always trained. */
export interface DoseSessions {
	min: number;
	max: number;
}

/** A [lo, hi] pair. */
type Range = readonly [lo: number, hi: number];

const keepDays = LAYOUTS.maintenance.byCount[0]!;

/**
 * Strength and muscle building at maintenance: M3's maintenance split (Keep A and Keep B, so one
 * or two sessions), its style (2 sets a slot) and its hard-set range (4–10 a major group). M7
 * adds only the cap on the main lifts' top set.
 */
const LIFTING = {
	layout: 'maintenance',
	sessions: { min: 1, max: keepDays.length },
	setsPerSlot: STYLES.maintenance.main.sets,
	hardSets: HARD_SET_RANGES.maintenance.sets,
	topSetRpeCap: 8
} as const;

export const DOSES = {
	strength: {
		...LIFTING,
		why: 'A third of the usual hard sets, with the main lifts still heavy, keeps strength for months; the top set stops at RPE 8 so it never costs the leader recovery.'
	},
	hypertrophy: {
		...LIFTING,
		why: 'About 4 hard sets a muscle a week holds the muscle you have built, as long as the sets stay hard; the rest of the volume can wait.'
	},
	runs: {
		sessions: { min: 2, max: 3 },
		/** A share of recent weekly volume. */
		volumeShare: [0.6, 0.7],
		qualityRunsMax: 1,
		longRun: 'hold_recent_longest',
		why: 'Aerobic fitness holds on 60–70 % of your recent mileage when one run stays quick and the long run stays as long as your recent longest.'
	},
	muay_thai: {
		sessions: { min: 1, max: 2 },
		formats: ['technical', 'pads'],
		/** Sparring only when it is a class the owner attends. */
		sparring: 'class_only',
		why: 'Technique and pad work keep timing and shape sharp without sparring’s knocks; a sparring class you attend still counts.'
	},
	custom: {
		sessions: { min: 1, max: 1 },
		why: 'One session a week keeps your own discipline in touch until it leads again.'
	}
} as const satisfies Record<
	DoseStream,
	{ sessions: DoseSessions; why: string } & Record<string, unknown>
>;

/** The lower half of a [lo, hi] range, in whole sets: [lo, lo + ⌊(hi − lo) / 2⌋]. */
export const lowerHalf = ([lo, hi]: Range): Range => [lo, lo + Math.floor((hi - lo) / 2)];

/**
 * A secondary strength or muscle-building goal (one that does not lead and does not conflict with
 * the leader) keeps its own layout and style (M3's OWN_LAYOUT, STYLE_OF or GENERAL_STYLE), held
 * to the lower half of its own HARD_SET_RANGES band: 8–11 for strength, 10–15 for hypertrophy.
 */
export const SECONDARY = {
	layout: 'own',
	style: 'own',
	bands: {
		strength: lowerHalf(HARD_SET_RANGES.strength.sets),
		hypertrophy: lowerHalf(HARD_SET_RANGES.hypertrophy.sets)
	},
	why: 'A goal that trains alongside the leader keeps progressing on its own split, but at the lower half of its usual sets, so the leader keeps first call on recovery.'
} as const;

/**
 * The maintenance block: every goal at its dose, for 4–8 weeks, with no scheduled deload because
 * its volume is already low. Its weeks are planned at the doses' top-set cap and the middle of the
 * run share.
 */
export const MAINTENANCE_BLOCK = {
	weeks: { min: 4, max: 8 },
	deload: false,
	rpeCap: LIFTING.topSetRpeCap,
	runVolumeFactor:
		Math.round(((DOSES.runs.volumeShare[0] + DOSES.runs.volumeShare[1]) / 2) * 100) / 100,
	why: 'Holding everything costs little, so a maintenance block needs no deload; 4–8 weeks bridges a gap, an off-season or a break without losing what you built.'
} as const;
