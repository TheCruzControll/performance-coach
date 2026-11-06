/**
 * Strength days (PRD §5): which split the strength days get, the slots each day fills, how each
 * slot is prescribed, and how long a session takes. splits.ts, selection.ts and timefit.ts apply
 * these numbers; a coaching change is a row here, not code.
 *
 * - The number of strength days is the day rule's (demand.ts). The split follows it and the top
 *   strength discipline (LAYOUTS); when a goal of another kind ranks first, it is maintenance.
 * - A day lists its slots in training order: power, the main lifts, secondary work, accessories.
 *   A main slot may name the baseline lift it prefers; it takes the slot when the discipline
 *   calls for baseline lifts (DisciplineStyle.lifts), so week 1 measures it and later weeks load
 *   from it. At maintenance the sets are STYLES.maintenance, whatever the discipline.
 * - From two days a week, every layout trains squat, hinge, push and pull, and pulls at least as
 *   often as it pushes (splits.test.ts).
 * - Until loads and progression (m3/21) set them, sets are RPE-based: the top set at the week's
 *   RPE cap, back-offs a point under it, other work at RPE 7 or the cap if lower.
 */
import type { Discipline } from '../../profile/catalog.ts';
import type {
	ExerciseTag,
	MovementPattern,
	Muscle,
	SessionIntensity,
	SessionType
} from '../../training/vocabulary.ts';
import type { ExerciseKey } from '../input.ts';

export type SlotRole = 'power' | 'main' | 'secondary' | 'accessory';

export interface SlotKind {
	/** The slot as decisions name it: 'the {label} slot'. */
	label: string;
	patterns: readonly MovementPattern[];
	/** For isolation work: the primary muscles that fill it. */
	muscles?: readonly Muscle[];
}

export const SLOT_KINDS = {
	squat: { label: 'squat', patterns: ['squat'] },
	hinge: { label: 'hinge', patterns: ['hinge'] },
	lunge: { label: 'single-leg', patterns: ['lunge'] },
	hpush: { label: 'horizontal push', patterns: ['horizontal_push'] },
	vpush: { label: 'vertical push', patterns: ['vertical_push'] },
	hpull: { label: 'horizontal pull', patterns: ['horizontal_pull'] },
	vpull: { label: 'vertical pull', patterns: ['vertical_pull'] },
	core: { label: 'core', patterns: ['anti_extension', 'anti_rotation', 'trunk_flexion'] },
	// Jumps or a fast lift: the skill cap puts jumps first for anyone new to Olympic lifts.
	power: { label: 'power', patterns: ['plyometric', 'olympic'] },
	olympic: { label: 'Olympic lift', patterns: ['olympic'] },
	carry: { label: 'carry', patterns: ['carry'] },
	biceps: { label: 'biceps', patterns: ['isolation'], muscles: ['biceps'] },
	triceps: { label: 'triceps', patterns: ['isolation'], muscles: ['triceps'] },
	side_delts: { label: 'side delts', patterns: ['isolation'], muscles: ['side_delts'] },
	rear_delts: { label: 'rear delts', patterns: ['horizontal_pull'], muscles: ['rear_delts'] },
	quads: { label: 'quads', patterns: ['isolation'], muscles: ['quads'] },
	hamstrings: { label: 'hamstrings', patterns: ['isolation'], muscles: ['hamstrings'] },
	calves: { label: 'calves', patterns: ['isolation'], muscles: ['calves'] }
} as const satisfies Record<string, SlotKind>;
export type SlotKindKey = keyof typeof SLOT_KINDS;

/** A slot: its role, its kind and, for a main slot, the baseline lift it prefers. */
export type SlotSpec = readonly [role: SlotRole, kind: SlotKindKey, lift?: ExerciseKey];

/** A day of a split. Days sharing a name are lettered in the week: Upper A, Upper B. */
export interface DayTemplate {
	name: string;
	slots: readonly SlotSpec[];
}

// One day per line, so Prettier leaves the table as written.
// prettier-ignore
export const DAYS = {
	fullA: { name: 'Full body', slots: [['main', 'squat', 'back_squat'], ['main', 'hpush', 'bench_press'], ['secondary', 'hpull'], ['secondary', 'hinge'], ['accessory', 'core']] },
	fullB: { name: 'Full body', slots: [['main', 'hinge', 'deadlift'], ['main', 'vpush', 'overhead_press'], ['secondary', 'vpull'], ['secondary', 'lunge'], ['accessory', 'rear_delts']] },
	fullC: { name: 'Full body', slots: [['main', 'squat', 'back_squat'], ['secondary', 'hpush'], ['secondary', 'vpull'], ['secondary', 'lunge'], ['accessory', 'core']] },
	upperA: { name: 'Upper', slots: [['main', 'hpush', 'bench_press'], ['secondary', 'hpull'], ['secondary', 'vpush'], ['secondary', 'vpull'], ['accessory', 'biceps'], ['accessory', 'triceps']] },
	lowerA: { name: 'Lower', slots: [['main', 'squat', 'back_squat'], ['secondary', 'hinge'], ['secondary', 'lunge'], ['accessory', 'hamstrings'], ['accessory', 'core']] },
	upperB: { name: 'Upper', slots: [['main', 'vpush', 'overhead_press'], ['secondary', 'hpull'], ['secondary', 'hpush'], ['secondary', 'vpull'], ['accessory', 'rear_delts'], ['accessory', 'side_delts']] },
	lowerB: { name: 'Lower', slots: [['main', 'hinge', 'deadlift'], ['secondary', 'squat'], ['secondary', 'lunge'], ['accessory', 'calves'], ['accessory', 'core']] },
	push: { name: 'Push', slots: [['main', 'hpush', 'bench_press'], ['secondary', 'vpush'], ['secondary', 'hpush'], ['accessory', 'side_delts'], ['accessory', 'triceps']] },
	pull: { name: 'Pull', slots: [['main', 'hpull'], ['secondary', 'vpull'], ['secondary', 'hpull'], ['accessory', 'rear_delts'], ['accessory', 'biceps']] },
	legs: { name: 'Legs', slots: [['main', 'squat', 'back_squat'], ['secondary', 'hinge'], ['secondary', 'lunge'], ['accessory', 'quads'], ['accessory', 'calves']] },
	squat: { name: 'Squat', slots: [['main', 'squat', 'back_squat'], ['secondary', 'hpush'], ['secondary', 'hpull'], ['accessory', 'hamstrings'], ['accessory', 'core']] },
	bench: { name: 'Bench', slots: [['main', 'hpush', 'bench_press'], ['secondary', 'vpull'], ['secondary', 'vpush'], ['accessory', 'triceps'], ['accessory', 'rear_delts']] },
	deadlift: { name: 'Deadlift', slots: [['main', 'hinge', 'deadlift'], ['secondary', 'squat'], ['secondary', 'hpull'], ['accessory', 'core']] },
	benchB: { name: 'Bench', slots: [['main', 'hpush', 'bench_press'], ['secondary', 'hinge'], ['secondary', 'hpull'], ['accessory', 'triceps']] },
	sbdAll: { name: 'Squat, bench & deadlift', slots: [['main', 'squat', 'back_squat'], ['main', 'hpush', 'bench_press'], ['main', 'hinge', 'deadlift'], ['secondary', 'hpull'], ['accessory', 'core']] },
	squatBench: { name: 'Squat & bench', slots: [['main', 'squat', 'back_squat'], ['main', 'hpush', 'bench_press'], ['secondary', 'hpull'], ['accessory', 'hamstrings'], ['accessory', 'core']] },
	deadliftBench: { name: 'Deadlift & bench', slots: [['main', 'hinge', 'deadlift'], ['main', 'hpush', 'bench_press'], ['secondary', 'vpull'], ['secondary', 'hpull'], ['accessory', 'triceps']] },
	snatch: { name: 'Snatch', slots: [['main', 'olympic', 'snatch'], ['main', 'squat', 'back_squat'], ['secondary', 'vpush'], ['secondary', 'hpull'], ['accessory', 'core']] },
	cleanJerk: { name: 'Clean & jerk', slots: [['main', 'olympic', 'clean_and_jerk'], ['main', 'squat', 'front_squat'], ['secondary', 'hinge'], ['secondary', 'vpull'], ['accessory', 'core']] },
	athleticA: { name: 'Athletic', slots: [['power', 'power'], ['main', 'squat', 'back_squat'], ['secondary', 'hpush'], ['secondary', 'hpull'], ['accessory', 'core']] },
	athleticB: { name: 'Athletic', slots: [['power', 'power'], ['main', 'hinge', 'deadlift'], ['secondary', 'vpush'], ['secondary', 'vpull'], ['secondary', 'lunge'], ['accessory', 'carry']] },
	keepA: { name: 'Strength', slots: [['main', 'squat', 'back_squat'], ['secondary', 'hpush'], ['secondary', 'hpull'], ['accessory', 'core']] },
	keepB: { name: 'Strength', slots: [['main', 'hinge', 'deadlift'], ['secondary', 'vpush'], ['secondary', 'vpull'], ['secondary', 'lunge']] }
} as const satisfies Record<string, DayTemplate>;
export type DayKey = keyof typeof DAYS;

export interface Layout {
	/** As 'a {name} split' reads it. */
	name: string;
	/** Why it suits the week, read after 'a {name} split'. `{goal}` names the top goal. */
	reason: string;
	/** The days for 1, 2, 3… strength days; beyond the last row, its days repeat in turn. */
	byCount: readonly (readonly DayKey[])[];
}

export const LAYOUTS = {
	full_body: {
		name: 'full-body',
		reason: 'trains every main movement each session, so each is practised several times a week',
		byCount: [['fullA'], ['fullA', 'fullB'], ['fullA', 'fullB', 'fullC']]
	},
	upper_lower: {
		name: 'upper/lower',
		reason: 'gives the upper and the lower body two sessions each, with room for more work in each',
		byCount: [['upperA', 'lowerA', 'upperB', 'lowerB']]
	},
	ppl_upper_lower: {
		name: 'push/pull/legs and upper/lower',
		reason: 'gives pushing, pulling and legs a day each, then an upper and a lower day',
		byCount: [['push', 'pull', 'legs', 'upperA', 'lowerB']]
	},
	ppl: {
		name: 'push/pull/legs',
		reason: 'gives pushing, pulling and legs a day each, twice a week',
		byCount: [['push', 'pull', 'legs']]
	},
	sbd: {
		name: 'squat, bench and deadlift',
		reason: 'builds the week around the three competition lifts as they are tested',
		// Each row has all three as main lifts, two or three a day when there are fewer days.
		byCount: [
			['sbdAll'],
			['squatBench', 'deadliftBench'],
			['squat', 'bench', 'deadlift'],
			['squat', 'bench', 'deadlift', 'benchB']
		]
	},
	weightlifting: {
		name: 'snatch and clean & jerk',
		reason:
			'alternates the two competition lifts, each with a squat, as they are learnt by repetition',
		byCount: [['snatch', 'cleanJerk']]
	},
	athletic: {
		name: 'athletic',
		reason: 'opens every session with jumps or a fast lift for power, then builds strength',
		byCount: [['athleticA', 'athleticB']]
	},
	maintenance: {
		name: 'maintenance',
		reason: 'keeps the strength you have with fewer hard sets, leaving your energy for {goal}',
		byCount: [['keepA', 'keepB']]
	}
} as const satisfies Record<string, Layout>;
export type LayoutKey = keyof typeof LAYOUTS;

/** Without a split of their own, the days go by number: the first row whose most covers them. */
export const LAYOUT_BY_DAYS: readonly (readonly [maxDays: number, layout: LayoutKey])[] = [
	[3, 'full_body'],
	[4, 'upper_lower'],
	[5, 'ppl_upper_lower'],
	[Infinity, 'ppl']
];

/** The strength disciplines that have a split of their own. */
export const OWN_LAYOUT: Partial<Record<Discipline, LayoutKey>> = {
	powerlifting: 'sbd',
	weightlifting: 'weightlifting',
	athletic: 'athletic'
};

/** A slot role's sets, reps and rest seconds. A main lift is one top set, then `sets` back-offs. */
export interface RoleSets {
	sets: number;
	/** Clamped into each exercise's own range; an accessory uses its own range when it has one. */
	reps: readonly [number, number];
	rest: number;
}
export type Prescription = Readonly<Record<SlotRole, RoleSets>>;

/** By style: heavy sets with long rests for strength, more reps for size, fewer sets to keep. */
export const STYLES = {
	strength: {
		power: { sets: 3, reps: [3, 3], rest: 120 },
		main: { sets: 3, reps: [5, 5], rest: 150 },
		secondary: { sets: 3, reps: [6, 8], rest: 90 },
		accessory: { sets: 3, reps: [8, 12], rest: 60 }
	},
	hypertrophy: {
		power: { sets: 3, reps: [3, 3], rest: 120 },
		main: { sets: 3, reps: [8, 8], rest: 120 },
		secondary: { sets: 3, reps: [8, 12], rest: 75 },
		accessory: { sets: 3, reps: [10, 15], rest: 60 }
	},
	// Fewer hard sets keep strength while another goal comes first.
	maintenance: {
		power: { sets: 2, reps: [3, 3], rest: 120 },
		main: { sets: 2, reps: [5, 5], rest: 120 },
		secondary: { sets: 2, reps: [6, 10], rest: 75 },
		accessory: { sets: 2, reps: [8, 12], rest: 60 }
	}
} as const satisfies Record<string, Prescription>;
export type StyleKey = keyof typeof STYLES;

/** How a strength discipline trains: its style, its session type, and whether lifts lead. */
export interface DisciplineStyle {
	style: StyleKey;
	type: SessionType;
	/** Whether baseline lifts take the main slots they prefer. */
	lifts: boolean;
}

/** Every strength discipline trains this way unless STYLE_OF says otherwise. */
export const GENERAL_STYLE: DisciplineStyle = { style: 'strength', type: 'strength', lifts: true };

/** Hypertrophy fills its main slots with the best fit, machines included, not a baseline lift. */
export const STYLE_OF: Partial<Record<Discipline, DisciplineStyle>> = {
	hypertrophy: { style: 'hypertrophy', type: 'hypertrophy', lifts: false }
};

/** Work other than the top and back-off sets is held to this RPE, or the week's cap if lower. */
export const WORKING_RPE = 7;

/** A strength session's intensity from its week's RPE cap: the first bound the cap is under. */
export const INTENSITY_BY_RPE: readonly (readonly [under: number, SessionIntensity])[] = [
	[6.5, 'easy'],
	[7.5, 'moderate'],
	[9, 'hard'],
	[Infinity, 'very_hard']
];

/**
 * An accessory supports the main work: an exercise that is neither compound nor explosive, such
 * as isolation, trunk work and carries. Time fit trims accessories first.
 */
export const isAccessory = (exercise: { tags: readonly ExerciseTag[] }) =>
	!exercise.tags.includes('compound') && !exercise.tags.includes('explosive');

/** Metres for a carry or sled set, which the catalogue gives no default for. */
export const DEFAULT_METRES = 40;

/**
 * What a session's time is estimated from (timefit.ts): a warm-up that includes the main lifts'
 * ramp-up sets, then each set's work and its rest. A rep takes about four seconds, a metre of a
 * carry one; a unilateral set is done once per side.
 */
export const TIME = { warmUpMinutes: 10, secondsPerRep: 4, secondsPerMetre: 1 } as const;

/**
 * Session types the session length does not cap. The long run follows the running rules and may
 * run longer, with a decision saying so (m3-plan open question 'Session length'); to cap it as
 * well, empty this list. Commitments always keep their own length.
 */
export const BEYOND_SESSION_LENGTH: readonly SessionType[] = ['long_run'];

/** The slots whose preferred lift is the discipline's competition lift. */
export const COMPETITION_SLOTS: Partial<Record<LayoutKey, readonly SlotKindKey[]>> = {
	sbd: ['squat', 'hpush', 'hinge'],
	weightlifting: ['olympic']
};

/** Why an exercise fills a main or power slot, read after '{exercise} fills the … slot:'. */
export const SELECTED_BECAUSE = {
	competition: 'it is the competition lift, practised as it is tested',
	measured: 'it is a baseline lift, so its loads come from the 1RM you gave',
	baseline: 'it is a baseline lift, which week 1 measures so the weeks after can load from it',
	liked: 'you said you like it',
	best: 'it is the best match for your equipment and experience'
} as const;
