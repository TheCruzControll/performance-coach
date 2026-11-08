/**
 * Strength blocks as week plans (m7-plan strength-phases; PRD §5): the weeks of one strength
 * phase, and the sequence of phases that peaks a lifter for a meet. Each week is a skeleton, its
 * kind (kinds.ts BLOCK_WEEK_KINDS.strength), its phase and its targets, from
 * rules/strength-phases.ts; the generator fills in dates and sessions. Deloads are not placed
 * here: the deload cadence is its own rule, applied over every block. Pure and deterministic.
 */
import type { ExperienceLevel } from '../../profile/catalog.ts';
import type { WeekTargets } from '../../training/types.ts';
import type { WeekKind } from '../../training/vocabulary.ts';
import { MEET_PHASES, MEET_SEQUENCE, PHASE_SCHEMES } from '../rules/strength-phases.ts';
import type { MeetPhase, StrengthRole } from '../rules/strength-phases.ts';
import { BLOCK_WEEK_KINDS } from './kinds.ts';
import type { BLOCK_PHASES } from './kinds.ts';

/** A strength block's phases: accumulation, intensification, realization and taper. */
export type StrengthPhase = (typeof BLOCK_PHASES.strength)[number];

/** One week of a strength block, before it has dates and sessions. */
export interface StrengthWeek {
	kind: WeekKind;
	phase: StrengthPhase;
	targets: WeekTargets & { mainLifts: NonNullable<WeekTargets['mainLifts']> };
}

const PHASE_OF: Readonly<Record<MeetPhase, StrengthPhase>> = {
	accumulation: 'accumulation',
	intensification: 'intensification',
	realization: 'realization',
	meet_taper: 'taper'
};
const ROLE_OF: Readonly<Record<StrengthPhase, MeetPhase>> = {
	accumulation: 'accumulation',
	intensification: 'intensification',
	realization: 'realization',
	taper: 'meet_taper'
};

const halfStep = (n: number) => Math.round(n * 2) / 2;
const hundredths = (n: number) => Math.round(n * 100) / 100;
const between = ([from, to]: readonly [number, number], at: number) => from + (to - from) * at;

/** Week `i` of `count` weeks in `role`, in phase `phase`. */
function weekOf(role: StrengthRole, phase: StrengthPhase, i: number, count: number): StrengthWeek {
	const scheme = PHASE_SCHEMES[role];
	const at = count > 1 ? i / (count - 1) : 0;
	const setsFactor = hundredths(between(scheme.setsFactor, at));
	const topRpe = halfStep(between(scheme.topRpe, at));
	return {
		kind: BLOCK_WEEK_KINDS.strength[role],
		phase,
		targets: {
			rpeCap: topRpe,
			volumeFactor: setsFactor,
			loadStep: scheme.loadStep,
			runVolumeFactor: scheme.runVolumeFactor,
			mainLifts: { repsMin: scheme.reps[0], repsMax: scheme.reps[1], topRpe, setsFactor }
		}
	};
}

/** The role a phase is planned as at `level`: a beginner's realization is intensification. */
function roleAt(phase: StrengthPhase, level: ExperienceLevel): MeetPhase {
	const role = ROLE_OF[phase];
	const beginner = (MEET_SEQUENCE.noRealization as readonly ExperienceLevel[]).includes(level);
	return role === 'realization' && beginner ? 'intensification' : role;
}

function checkWeeks(weeks: number, name: string): void {
	if (!Number.isInteger(weeks) || weeks < 0) {
		throw new RangeError(`${name} must be a whole number of weeks, 0 or more`);
	}
}

/** `weeks` weeks of one strength phase at `level`, its first week first. */
export function strengthWeeks(
	phase: StrengthPhase,
	weeks: number,
	level: ExperienceLevel
): StrengthWeek[] {
	checkWeeks(weeks, 'weeks');
	const role = roleAt(phase, level);
	return Array.from({ length: weeks }, (_, i) => weekOf(role, PHASE_OF[role], i, weeks));
}

/** How many weeks each phase holds when `weeksToMeet` weeks come before the meet's week. */
function meetPhaseWeeks(weeksToMeet: number, level: ExperienceLevel) {
	checkWeeks(weeksToMeet, 'weeksToMeet');
	const counts: Record<MeetPhase, number> = { ...MEET_SEQUENCE.weeks };
	const total = () => MEET_PHASES.reduce((sum, phase) => sum + counts[phase], 0);
	for (let i = 0; total() < weeksToMeet; i++) {
		counts[MEET_SEQUENCE.grow[i % MEET_SEQUENCE.grow.length]!] += 1;
	}
	for (const phase of MEET_SEQUENCE.cut) {
		if (total() <= weeksToMeet) break;
		counts[phase] -= 1;
	}
	if (weeksToMeet === 0) counts.meet_taper = 0;
	if (roleAt('realization', level) !== 'realization') {
		counts.intensification += counts.realization;
		counts.realization = 0;
	}
	return counts;
}

/**
 * The weeks from a strength block's first week to the meet's own week: `weeksToMeet` weeks of
 * accumulation, intensification, realization (none for a new or novice lifter) and a taper,
 * always ending in the taper, then the meet's week (kind event). With the meet this week
 * (`weeksToMeet` 0) only the meet's week is planned.
 */
export function meetSequence(weeksToMeet: number, level: ExperienceLevel): StrengthWeek[] {
	const counts = meetPhaseWeeks(weeksToMeet, level);
	return [
		...MEET_PHASES.flatMap((role) =>
			Array.from({ length: counts[role] }, (_, i) => weekOf(role, PHASE_OF[role], i, counts[role]))
		),
		weekOf('meet', 'taper', 0, 1)
	];
}
