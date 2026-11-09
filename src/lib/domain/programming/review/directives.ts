/**
 * The next block's directives (PRD §11; M6): what a cycle review tells the generator to keep,
 * rotate and change, derived by code from the stored snapshot (cycle-snapshot.ts), the next outline
 * block and M2's goals. The same input gives the same directives.
 *
 * - directivesFrom(evaluation, outline, goals): the phase and weeks, keep and rotate with reasons,
 *   a volume change per muscle group, a target RPE range, the deload's place, the running start,
 *   the days to avoid and the progression strategy.
 * - modifiableSubset(directives): the part the owner may change, as M5's next_cycle payload
 *   (`import type` only: domain/programming never loads the coach's schemas).
 * - clampOverrides(overrides, directives): an owner's or a coach's changes held to the bounds
 *   below, each clamp recorded.
 *
 * Every judgement is a named number in DIRECTIVE_RULES. Pure and server-only at runtime, like all
 * of domain/programming.
 */
import type { ProposalPayload } from '../../coach/proposals.ts';
import { WEEKDAY_INFO } from '../../profile/catalog.ts';
import type { Weekday } from '../../profile/catalog.ts';
import { PHASE_LABEL } from '../../training/vocabulary.ts';
import type { MuscleGroup, Phase } from '../../training/vocabulary.ts';
import { cleanFloat, roundToIncrement } from '../../units.ts';
import { MAX_NEXT_BLOCK_WEEKS } from '../next-block/dates.ts';
import { FIRST_BLOCK } from '../rules/blocks.ts';
import { RESULT_RULES, RUN_RESULT_RULES } from '../rules/results.ts';
import { DELOAD_AFTER_WEEKS, racePaceTarget } from './cycle.ts';
import type { CycleGoal } from './cycle.ts';
import type { CycleReviewSnapshot } from './cycle-snapshot.ts';

/** M5's next_cycle payload: the owner-modifiable subset is exactly its fields. */
export type NextCycleSubset = ProposalPayload<'next_cycle'>;

// ---- Judgements the owner can change here ----------------------------------------------------

export const DIRECTIVE_RULES = {
	/**
	 * With no outline block left, the next block is appended by the rules with as many weeks as M3's
	 * first block (m6-plan open question 'no outline block left': the default appends, rather than
	 * suggesting a new program).
	 */
	appendWeeks: FIRST_BLOCK.length,
	/** A group's hard sets move by this share when its block mean was outside its range. */
	volumeStep: 0.1,
	/** High fatigue takes this share off every group's volume. */
	fatigueVolumeCut: -0.1,
	/** The target RPE range by the block's fatigue level. */
	rpe: { none: [7, 8.5], watch: [6.5, 8], high: [6, 8] },
	/** Running starts from the mean of the last this many weeks' actual distance. */
	runWeeks: 3,
	/** A strength week's load step while progressing, and the deepest an override may cut. */
	loadStep: 0.025,
	loadStepMin: -0.1,
	/** The lightest volume factor an override may ask for: a deload's. */
	volumeFactorMin: 0.6,
	/** The fewest weeks an appended block may have, and the most any block may (next_cycle's). */
	minWeeks: 3,
	maxWeeks: MAX_NEXT_BLOCK_WEEKS
} as const;

/** The phases a review repeats when it appends; any other phase is followed by accumulation. */
const REPEATABLE: readonly Phase[] = [
	'accumulation',
	'intensification',
	'hypertrophy',
	'maintenance',
	'marathon_base',
	'marathon_build',
	'half_base',
	'half_build'
];
/** Already light: no deload is added to them. */
const TAPERS: readonly Phase[] = ['taper', 'marathon_taper', 'half_taper'];
const RUNNING_PHASE = /^(marathon|half)_/;

// ---- Types -------------------------------------------------------------------------------------

export type DeloadPlacement = 'first' | 'last' | 'none';
/** progress: the results rules may add load and volume; hold: nothing increases. */
export type ProgressionStrategy = 'progress' | 'hold';

export interface Reasoned {
	exercise: string;
	reason: string;
}

export interface CycleDirectives {
	fromBlockLineage: string;
	phase: Phase;
	weeks: number;
	/** True when the outline dates the block: its phase and weeks are not the owner's to change. */
	fromOutline: boolean;
	keep: Reasoned[];
	rotate: Reasoned[];
	/** A share of each ranged group's hard sets (−0.1 = 10 % fewer), with why. */
	volume: { group: MuscleGroup; change: number; reason: string }[];
	rpe: readonly [number, number];
	deload: DeloadPlacement;
	running: {
		weeklyMetres: number | null;
		longRunMetres: number | null;
		/** Each running goal's target race pace, s/km. */
		paces: { goalId: string; secondsPerKm: number }[];
	} | null;
	avoidDays: Weekday[];
	progression: ProgressionStrategy;
}

/** The review as directives read it: its stored snapshot and the block's actual running. */
export interface CycleEvaluation {
	snapshot: CycleReviewSnapshot;
	/** Each block week's run distance in metres, oldest first, and the block's longest run. */
	running: { weeklyMetres: readonly number[]; longestRunMetres: number | null } | null;
}

/** The next outline block, or null when none is left. */
export interface NextOutline {
	phase: Phase;
	weeks: number;
}

export interface Clamp {
	field: string;
	asked: number | string;
	used: number | string;
}

// ---- Directives --------------------------------------------------------------------------------

const metres = (m: number) => roundToIncrement(m, RUN_RESULT_RULES.roundMetres, 'down');
/** A start under one rounding step is no start: next_cycle refuses 0 m. */
const runStart = (m: number) => metres(m) || null;

/** The next block's directives from a cycle evaluation, the next outline and M2's goals. */
export function directivesFrom(
	evaluation: CycleEvaluation,
	outline: NextOutline | null,
	goals: readonly CycleGoal[]
): CycleDirectives {
	const R = DIRECTIVE_RULES;
	const s = evaluation.snapshot;
	const withheld = s.adherence.verdictsWithheld;
	const high = s.fatigue.level === 'high';
	const phase =
		outline?.phase ?? (REPEATABLE.includes(s.block.phase) ? s.block.phase : 'accumulation');
	// A longer outline block is planned for its first maxWeeks (next-block/dates.ts).
	const weeks = Math.min(outline?.weeks ?? R.appendWeeks, R.maxWeeks);

	const keep: Reasoned[] = [];
	const rotate: Reasoned[] = [];
	for (const e of s.effectiveness) {
		const over = `${e.exposures} sessions`;
		if (e.stalled && !e.main && !withheld)
			rotate.push({ exercise: e.exercise, reason: `Stalled over ${over}: a fresh stimulus` });
		else
			keep.push({
				exercise: e.exercise,
				reason: withheld
					? 'Kept: too few sessions done to judge it'
					: e.stalled
						? `Stalled over ${over}, kept as a main lift`
						: {
								progressed: `Progressed over ${over}`,
								held: `Held over ${over}`,
								regressed: `Regressed over ${over}, kept as a main lift`,
								too_few: 'Too few sessions to judge it yet'
							}[e.verdict]
			});
	}

	const groups = [...new Set(s.volume.filter((r) => r.target).map((r) => r.group))];
	const volume = groups.map((group) => {
		const rows = s.volume.filter((r) => r.group === group && r.target);
		const mean = (pick: (r: (typeof rows)[number]) => number) =>
			rows.reduce((sum, r) => sum + pick(r), 0) / rows.length;
		const [achieved, lo, hi] = [
			mean((r) => r.achieved),
			mean((r) => r.target![0]),
			mean((r) => r.target![1])
		];
		let change = achieved < lo ? R.volumeStep : achieved > hi ? -R.volumeStep : 0;
		let reason =
			change > 0
				? 'Under its range this block'
				: change < 0
					? 'Over its range this block'
					: 'Within its range';
		if (high) [change, reason] = [R.fatigueVolumeCut, 'Fatigue is high: less volume'];
		else if (withheld && change > 0)
			[change, reason] = [0, 'Held: adherence was too low to add volume'];
		return { group, change, reason };
	});

	const deload: DeloadPlacement = TAPERS.includes(phase)
		? 'none'
		: s.deloadNeed.verdict === 'needed'
			? 'first'
			: s.deloadNeed.verdict === 'consider' || weeks >= DELOAD_AFTER_WEEKS
				? 'last'
				: 'none';

	const runningGoals = goals.flatMap((g) => {
		const pace = racePaceTarget(g);
		return pace === null ? [] : [{ goalId: g.id, secondsPerKm: pace }];
	});
	const actual = evaluation.running;
	const recent = actual?.weeklyMetres.slice(-R.runWeeks) ?? [];
	const ran = recent.some((m) => m > 0);
	const running =
		ran || runningGoals.length || RUNNING_PHASE.test(phase)
			? {
					weeklyMetres: ran ? runStart(recent.reduce((a, b) => a + b, 0) / recent.length) : null,
					longRunMetres: actual?.longestRunMetres ? runStart(actual.longestRunMetres) : null,
					paces: runningGoals
				}
			: null;

	return {
		fromBlockLineage: s.block.lineage,
		phase,
		weeks,
		fromOutline: outline !== null,
		keep,
		rotate,
		volume,
		rpe: R.rpe[s.fatigue.level],
		deload,
		running,
		avoidDays: [...s.adherence.oftenMissed],
		progression: withheld || high ? 'hold' : 'progress'
	};
}

// ---- The owner's part --------------------------------------------------------------------------

const halfStep = (n: number) => Math.round(n * 2) / 2;

/** The directives as M5's next_cycle payload: what the owner may change before it is planned. */
export function modifiableSubset(d: CycleDirectives): NextCycleSubset {
	const changes = d.volume.map((v) => v.change);
	const mean = changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : 0;
	const constraints = [
		...(d.deload === 'first' ? ['Open with a deload week'] : []),
		...(d.progression === 'hold' ? ['No load or volume increases this block'] : []),
		...d.avoidDays.map((day) => `Avoid ${WEEKDAY_INFO[day].label}s: often missed`)
	];
	const rotated = d.rotate.length ? `, ${d.rotate.length} exercises rotated` : '';
	return {
		fromBlockLineage: d.fromBlockLineage,
		focus: `${PHASE_LABEL[d.phase]}: ${d.weeks} weeks, ${d.keep.length} exercises kept${rotated}`,
		phase: d.phase,
		weeks: d.weeks,
		emphasis: d.volume.filter((v) => v.change > 0).map((v) => v.group),
		targets: {
			rpeCap: halfStep(d.rpe[1]),
			volumeFactor: cleanFloat(1 + mean, 3),
			loadStep: d.progression === 'progress' ? DIRECTIVE_RULES.loadStep : 0,
			runVolumeFactor: 1
		},
		// A rotated exercise's replacement is the generator's to choose (eligibility, likes), so the
		// brief names none; an owner's or coach's swap arrives through overrides.
		rotation: [],
		running: d.running && {
			weeklyMetres: d.running.weeklyMetres,
			longRunMetres: d.running.longRunMetres
		},
		ending: TAPERS.includes(d.phase) ? 'taper' : d.deload === 'last' ? 'deload' : 'none',
		constraints: constraints.slice(0, 10)
	};
}

/**
 * Overrides held to the directives' bounds, with each clamp recorded. An outline's phase and weeks
 * stay (its dates are fixed); RPE stays within the directed range; nothing rises past the results
 * rules (a held block adds no load or volume, running at most +10 %).
 */
export function clampOverrides(
	overrides: Partial<NextCycleSubset>,
	directives: CycleDirectives
): { subset: NextCycleSubset; clamps: Clamp[] } {
	const R = DIRECTIVE_RULES;
	const base = modifiableSubset(directives);
	const clamps: Clamp[] = [];
	const hold = directives.progression === 'hold';
	const clamp = (field: string, asked: number, lo: number, hi: number) => {
		const used = cleanFloat(Math.min(hi, Math.max(lo, asked)), 3);
		if (used !== asked) clamps.push({ field, asked, used });
		return used;
	};
	const fixed = <T extends string | number>(field: string, asked: T | undefined, used: T) => {
		if (asked !== undefined && asked !== used) clamps.push({ field, asked, used });
		return used;
	};
	const rise = 1 + RUN_RESULT_RULES.maxWeeklyRise;
	const t = { ...base.targets, ...overrides.targets };
	const targets = {
		rpeCap: clamp('targets.rpeCap', t.rpeCap, halfStep(directives.rpe[0]), base.targets.rpeCap),
		volumeFactor: clamp(
			'targets.volumeFactor',
			t.volumeFactor,
			R.volumeFactorMin,
			base.targets.volumeFactor + (hold ? 0 : R.volumeStep)
		),
		loadStep: clamp(
			'targets.loadStep',
			t.loadStep,
			R.loadStepMin,
			hold ? 0 : RESULT_RULES.maxUp / 100
		),
		runVolumeFactor: clamp('targets.runVolumeFactor', t.runVolumeFactor, R.volumeFactorMin, rise)
	};
	const runCap = (field: string, asked: number | null, start: number | null) =>
		asked === null || start === null ? asked : clamp(field, asked, 1, metres(start * rise));
	const run = overrides.running === undefined ? base.running : overrides.running;
	const running = run && {
		weeklyMetres: runCap(
			'running.weeklyMetres',
			run.weeklyMetres,
			base.running?.weeklyMetres ?? null
		),
		longRunMetres: runCap(
			'running.longRunMetres',
			run.longRunMetres,
			base.running?.longRunMetres ?? null
		)
	};
	const weeks = directives.fromOutline
		? fixed('weeks', overrides.weeks, base.weeks)
		: clamp('weeks', overrides.weeks ?? base.weeks, R.minWeeks, R.maxWeeks);
	const phase = directives.fromOutline
		? fixed('phase', overrides.phase, base.phase)
		: (overrides.phase ?? base.phase);
	const subset: NextCycleSubset = {
		...base,
		...overrides,
		fromBlockLineage: fixed('fromBlockLineage', overrides.fromBlockLineage, base.fromBlockLineage),
		phase,
		weeks,
		targets,
		running
	};
	return { subset, clamps };
}
