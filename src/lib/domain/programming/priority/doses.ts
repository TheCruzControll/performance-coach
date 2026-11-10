/**
 * Maintenance doses on a date (M7, PRD §2 and §5): for every goal held at maintenance, the
 * smallest dose of each of its streams that keeps it, and why, from rules/maintenance.ts. The
 * leader and secondary goals get no dose: they train as their own block plans them.
 *
 * doseBand is the one function that turns a goal's mode into a weekly hard-set band; the
 * generator, M6's muscle-group targets and the reviews all call it, so they cannot disagree.
 *
 * Pure and deterministic.
 */
import type { IsoDate } from '../../calendar.ts';
import type { Discipline, NutritionPhase } from '../../profile/catalog.ts';
import type { BlockPlan } from '../../training/types.ts';
import type { GoalMode } from '../evaluate/types.ts';
import type { ProgrammingInput } from '../input.ts';
import { SESSIONS_WANTED } from '../rules/days.ts';
import { DOSES, lowerHalf } from '../rules/maintenance.ts';
import type { DoseSessions, DoseStream } from '../rules/maintenance.ts';
import { chooseSplit } from '../splits.ts';
import type { Split } from '../splits.ts';
import { hardSetBand } from '../volume.ts';
import { effectivePriorities } from './weights.ts';
import type { GoalPriority } from './weights.ts';

type Range = readonly [lo: number, hi: number];

/**
 * The weekly hard sets a major group gets for a goal in `mode`, on hardSetBand:
 * - primary: hardSetBand unchanged
 * - secondary: the lower half of its own style's band, even where M3 would choose maintenance
 * - maintenance: the maintenance split's band
 */
export function doseBand(split: Split, phase: NutritionPhase | null, mode: GoalMode): Range {
	if (mode === 'primary') return hardSetBand(split, phase).sets;
	const held = hardSetBand({ ...split, maintenance: mode === 'maintenance' }, phase).sets;
	return mode === 'secondary' ? lowerHalf(held) : held;
}

interface LiftingDose {
	stream: 'strength' | 'hypertrophy';
	sessions: DoseSessions;
	layout: 'maintenance';
	setsPerSlot: number;
	/** doseBand's maintenance band. */
	hardSets: Range;
	topSetRpeCap: number;
}
interface RunsDose {
	stream: 'runs';
	sessions: DoseSessions;
	/** The share of recent weekly volume, in metres; null with no recent volume told. */
	weeklyMetres: Range | null;
	/** The recent longest run, held; null when not told. */
	longRunMetres: number | null;
	qualityRunsMax: number;
}
interface MuayThaiDose {
	stream: 'muay_thai';
	sessions: DoseSessions;
	formats: readonly string[];
	sparring: 'class_only';
}
interface CustomDose {
	stream: 'custom';
	sessions: DoseSessions;
}
export type Dose = (LiftingDose | RunsDose | MuayThaiDose | CustomDose) & {
	/** The dose in words, as a maintenance_dose decision reads it. */
	words: string;
};

/** A goal held at its dose. */
export interface GoalDose {
	stream: DoseStream;
	goal: { id: string; title: string };
	/** The goal that leads while this one is held; null when none does. */
	leader: { id: string; title: string } | null;
	dose: Dose;
	/** Why the goal is held, naming the goals, then why this dose keeps it. */
	reason: string;
}

/** The stream a discipline's dose is for. */
export function streamOf(discipline: Discipline): DoseStream {
	if (discipline === 'hypertrophy') return 'hypertrophy';
	return SESSIONS_WANTED[discipline].stream;
}

const span = ({ min, max }: DoseSessions) => (min === max ? `${min}` : `${min}–${max}`);
const km = (metres: number) => `${Math.round(metres / 100) / 10} km`;

function doseOf(stream: DoseStream, input: ProgrammingInput): Dose {
	switch (stream) {
		case 'strength':
		case 'hypertrophy': {
			const { layout, sessions, setsPerSlot, topSetRpeCap } = DOSES[stream];
			const [lo, hi] = doseBand(chooseSplit(input, 1), input.nutritionPhase, 'maintenance');
			const words = `${span(sessions)} Keep sessions, ${lo}–${hi} hard sets a group, top sets at RPE ${topSetRpeCap} at most`;
			return { stream, sessions, layout, setsPerSlot, hardSets: [lo, hi], topSetRpeCap, words };
		}
		case 'runs': {
			const { sessions, volumeShare, qualityRunsMax } = DOSES.runs;
			const recent = input.running?.weeklyMetres ?? null;
			const longest = input.running?.longestRunMetres ?? null;
			const weeklyMetres = recent === null ? null : volumeShare.map((s) => Math.round(s * recent));
			const share = `${volumeShare[0] * 100}–${volumeShare[1] * 100} %`;
			const words = [
				`${span(sessions)} runs at ${share} of your recent volume${weeklyMetres ? ` (${km(weeklyMetres[0]!)} to ${km(weeklyMetres[1]!)})` : ''}`,
				`${qualityRunsMax} quality run at most`,
				`the long run held${longest === null ? ' at your recent longest' : ` at ${km(longest)}`}`
			].join(', ');
			return {
				stream,
				sessions,
				weeklyMetres: weeklyMetres && [weeklyMetres[0]!, weeklyMetres[1]!],
				longRunMetres: longest,
				qualityRunsMax,
				words
			};
		}
		case 'muay_thai': {
			const { sessions, formats, sparring } = DOSES.muay_thai;
			const words = `${span(sessions)} technique or pads sessions, no sparring beyond your classes`;
			return { stream, sessions, formats, sparring, words };
		}
		case 'custom': {
			const { sessions } = DOSES.custom;
			return { stream, sessions, words: `${span(sessions)} session` };
		}
	}
}

/**
 * The doses for every goal held at maintenance in `priorities` (effectivePriorities' verdicts), in
 * their order, one per stream each goal trains. A single goal, or goals that all lead or train
 * alongside, get none.
 */
export function dosesFor(priorities: readonly GoalPriority[], input: ProgrammingInput): GoalDose[] {
	const leader = priorities.find((p) => p.mode === 'primary');
	return priorities
		.filter((p) => p.mode === 'maintenance')
		.flatMap((p) =>
			[...new Set(p.disciplines.map(streamOf))].map((stream) => ({
				stream,
				goal: { id: p.goalId, title: p.title },
				leader: leader ? { id: leader.goalId, title: leader.title } : null,
				dose: doseOf(stream, input),
				reason: `${p.why} ${DOSES[stream].why}`
			}))
		);
}

/** Why a goal sits at its dose in a maintenance block, where no goal leads. */
export const HELD_IN_BLOCK = 'A maintenance block holds every goal at its dose.';

/**
 * `priorities` as a maintenance block holds them: every goal at maintenance, none leading. With
 * none leading already (every goal paused), each keeps its own reason.
 */
export function holdEveryGoal(priorities: readonly GoalPriority[]): GoalPriority[] {
	if (!priorities.some((p) => p.mode === 'primary')) return [...priorities];
	return priorities.map((p) => ({ ...p, mode: 'maintenance', why: HELD_IN_BLOCK }));
}

/** Every shaping goal's dose for a maintenance block starting `on`. */
export const maintenanceDoses = (input: ProgrammingInput, on: IsoDate): GoalDose[] =>
	dosesFor(holdEveryGoal(effectivePriorities(input, on, { phase: 'maintenance' })), input);

type DatedBlock = Pick<BlockPlan, 'phase' | 'startsOn' | 'endsOn'>;

/**
 * The doses of each block, set from the priorities at its first day and its phase, so they change
 * only at block boundaries: an event that passes mid-block moves nothing until the next block. A
 * maintenance-phase block holds every goal at its dose.
 */
export function dosesByBlock(
	input: ProgrammingInput,
	blocks: readonly DatedBlock[]
): { startsOn: IsoDate; endsOn: IsoDate; doses: GoalDose[] }[] {
	return blocks.map(({ phase, startsOn, endsOn }) => ({
		startsOn,
		endsOn,
		doses:
			phase === 'maintenance'
				? maintenanceDoses(input, startsOn)
				: dosesFor(effectivePriorities(input, startsOn, { phase }), input)
	}));
}
