/**
 * The next block (PRD §11; M6): M3's generator extended with progression from actual results,
 * without editing it. generateNextBlock runs M3's exported STAGES with three changes: blocks is
 * replaced by nextShape (the review's dates, phase and deload), carryover (kept and rotated
 * exercises) runs once the strength days are filled, and results runs after progression (each
 * lift's start from its sessions). A stage M3 adds later is inherited. The input is
 * nextBlockInput's: loads start from the latest e1RM and running from the actual mileage.
 *
 * - CARRYOVER_AFTER: the strength days are filled by M3's strength stage and then by its volume
 *   stage, which adds accessories to reach each group's hard sets. A rotated exercise held only in
 *   a slot the volume stage added (a powerlifter's sissy squat) would be missed after strength, so
 *   carryover runs after volume, before loads, progression and timefit.
 * - Deterministic byte for byte: the same arguments give the same block, decisions and
 *   fingerprint, with no clock, randomness or I/O.
 * - The block is checked by programPlanSchema as a plan of its own, starting on its Monday and
 *   planning from firstPlannedDay, so no session falls before it; the bridge and the block are
 *   checked as whole, contiguous weeks first. Decision refs name the block as `blocks.0`.
 * - next_block_planned says what the block is, from when, and what a late start cost.
 * - significantChanges lists what changed enough to say so (SIGNIFICANT), each with the index of
 *   the decision that explains it.
 *
 * Pure and server-only at runtime, like all of domain/programming.
 */
import { addDays, daysBetween, mondayOf } from '../../calendar.ts';
import { programPlanSchema } from '../../training/schemas.ts';
import type { BlockPlan, DecisionPlan, WeekPlan } from '../../training/types.ts';
import { exerciseRefKey, plannedHardSets } from '../../training/metrics.ts';
import type { ExerciseMuscles } from '../../training/metrics.ts';
import { MUSCLE_GROUP_LABEL, PHASE_LABEL } from '../../training/vocabulary.ts';
import type { MuscleGroup } from '../../training/vocabulary.ts';
import type { WeightUnit } from '../../units.ts';
import { validate } from '../../validation.ts';
import { DecisionLog } from '../decisions.ts';
import { clip } from '../demand.ts';
import { GeneratedPlanError, STAGES } from '../generate.ts';
import { canonicalJson, compareText, fingerprint, fnv1a64 } from '../random.ts';
import type { CycleDirectives } from '../review/directives.ts';
import { exerciseOf } from '../selection.ts';
import type { Draft, Stage } from '../stage.ts';
import { carryover } from '../stages/carryover.ts';
import { bridgeBlock, nextShape } from '../stages/next-shape.ts';
import { results } from '../stages/results.ts';
import type { LiftResults } from '../stages/results.ts';
import type { NextBlockDates } from './dates.ts';
import type { NextBlockInput } from './input.ts';

/** The generator a version planned by this module stores (next-block-store). */
export const GENERATOR_ID = 'next-block/1';

/** The M3 stage carryover follows: the last that fills strength days with exercises. */
export const CARRYOVER_AFTER = 'volume';

/**
 * What counts as a significant change (m6-plan): a load moved this many percent or more by results
 * (a start moved by a new e1RM or 1RM is the load_basis decision's, not listed here), a muscle
 * group this many hard sets a week, the weekly run volume this share. A swap, a phase change, a
 * deload and a bridge always count.
 */
export const SIGNIFICANT = { loadPct: 5, hardSets: 2, runVolume: 0.1 } as const;

/** The reviewed block and what its sessions showed. */
export interface PreviousBlock {
	/** As it was planned. */
	block: BlockPlan;
	/** Each lift's exposures and e1RM trend, by exercise key. */
	results: readonly LiftResults[];
	unit: WeightUnit;
}

export interface NextBlockOptions {
	dates: NextBlockDates;
	/** The outline block planned, as the current version holds it; null when appended. */
	outline: BlockPlan | null;
	previous: PreviousBlock;
	directives: CycleDirectives;
	/** M3's catalogueDigest for the library the input was built from. */
	catalogueDigest?: string;
}

export type SignificantKind =
	'swap' | 'load' | 'hard_sets' | 'run_volume' | 'phase' | 'deload' | 'bridge';

export interface SignificantChange {
	kind: SignificantKind;
	/** The exercise, muscle group or block it is about. */
	subject: string;
	from: number | string | null;
	to: number | string | null;
	/** The index in `decisions` of the decision that explains it. */
	decision: number;
}

export interface NextBlock {
	block: BlockPlan;
	bridge?: BlockPlan;
	decisions: DecisionPlan[];
	fingerprint: string;
	significantChanges: SignificantChange[];
}

/** M3's stage list with the three changes; a renamed M3 stage fails here, never silently. */
export function nextStages(
	next: NextBlockInput,
	o: NextBlockOptions
): { name: string; run: Stage }[] {
	const { directives: d, previous, dates, outline } = o;
	const hold = d.progression === 'hold';
	const added: Record<string, { name: string; run: Stage }> = {
		[CARRYOVER_AFTER]: { name: 'carryover', run: carryover({ previous: previous.block, ...d }) },
		progression: {
			name: 'results',
			run: results({ results: previous.results, unit: previous.unit, hold, deload: d.deload })
		}
	};
	const shape = { dates, outline, phase: next.subset.phase, deload: d.deload, hold };
	const list = STAGES.flatMap((stage) => {
		const run =
			stage.name === 'blocks'
				? { name: 'nextShape', run: nextShape({ ...shape, targets: next.subset.targets }) }
				: stage;
		return added[stage.name] ? [run, added[stage.name]!] : [run];
	});
	for (const name of ['nextShape', 'carryover', 'results'])
		if (!list.some((s) => s.name === name))
			throw new Error(`M3's stage list has no place for ${name}`);
	return list;
}

/** The bridge and block skeleton: whole weeks from a Monday, contiguous, week 1 holding the first day. */
function checkDates({ bridge, block, firstPlannedDay }: NextBlockDates) {
	const whole = (b: { startsOn: string; endsOn: string; weeks: number }, what: string) => {
		if (mondayOf(b.startsOn) !== b.startsOn || b.weeks < 1)
			throw new RangeError(`The ${what} starts on a Monday, with a week at least`);
		if (daysBetween(b.startsOn, b.endsOn) + 1 !== 7 * b.weeks)
			throw new RangeError(`The ${what} is ${b.weeks} whole weeks`);
	};
	whole(block, 'block');
	if (bridge) {
		whole(bridge, 'bridge');
		if (addDays(bridge.endsOn, 1) !== block.startsOn)
			throw new RangeError('The bridge ends the day before the block');
	}
	const offset = daysBetween(block.startsOn, firstPlannedDay);
	if (offset < 0 || offset > 6) throw new RangeError(`Not a day of week 1: ${firstPlannedDay}`);
}

const BUILDING = ['accumulation', 'build'];
/** The weeks a block's volume is compared by: its full building weeks, else its full weeks. */
function compared(block: BlockPlan, from: string): WeekPlan[] {
	const full = block.weeks.filter((w) => w.startsOn >= from);
	const building = full.filter((w) => BUILDING.includes(w.kind));
	return building.length ? building : full;
}
const mean = (values: readonly number[]) =>
	values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

/** Each group's mean weekly hard sets over `weeks`, to the half set; unknown exercises left out. */
function groupSets(weeks: readonly WeekPlan[], next: NextBlockInput) {
	const muscles = new Map<string, ExerciseMuscles>();
	const known = weeks.map((week) => ({
		...week,
		sessions: week.sessions.map((s) => {
			if (s.kind !== 'strength') return s;
			const exercises = s.exercises.filter((e) => {
				const key = exerciseRefKey(e.exercise);
				const found = exerciseOf(next.input, key);
				if (found) muscles.set(key, found);
				return found !== undefined;
			});
			return { ...s, exercises };
		})
	}));
	const tallies = known.map((w) => plannedHardSets(w, muscles).groups);
	const groups = new Set(tallies.flatMap((t) => Object.keys(t) as MuscleGroup[]));
	return new Map(
		[...groups].map((g) => [g, Math.round(mean(tallies.map((t) => t[g] ?? 0)) * 2) / 2])
	);
}

/** A week's planned run distance in metres. */
const runMetres = (week: WeekPlan) =>
	week.sessions.reduce(
		(sum, s) =>
			s.kind === 'run' ? s.segments.reduce((m, seg) => m + (seg.distanceMetres ?? 0), sum) : sum,
		0
	);

/** The previous block's digest, and what its sessions showed, as the fingerprint reads them. */
function previousDigest({ block, results: lifts, unit }: PreviousBlock) {
	const shown = lifts
		.map((r) => ({
			exercise: r.exercise,
			trend: r.trend
				? `${r.trend.verdict}:${'direction' in r.trend ? r.trend.direction : ''}`
				: null,
			exposures: r.exposures.map((e) => [
				e.day,
				e.substituted,
				e.missedReps,
				e.meanRpeDeviation,
				e.kg,
				e.hit,
				e.sets.prescribed,
				e.sets.completed
			])
		}))
		.sort((a, b) => compareText(a.exercise, b.exercise));
	return fnv1a64(canonicalJson({ block, results: shown, unit }));
}

export function generateNextBlock(next: NextBlockInput, options: NextBlockOptions): NextBlock {
	const { dates, directives, previous } = options;
	checkDates(dates);
	const { startsOn } = dates.block;
	const { firstPlannedDay } = dates;
	const log = new DecisionLog();
	const context = { input: next.input, options: { startsOn, firstPlannedDay }, log };
	let draft: Draft = { demand: null, blocks: [] };
	for (const stage of nextStages(next, options)) draft = stage.run(draft, context);
	const block = draft.blocks[0]!;
	const bridge = dates.bridge && bridgeBlock(dates.bridge);
	const k = dates.bridge?.weeks ?? 0;

	const phase = PHASE_LABEL[block.phase].toLowerCase();
	const reason = [
		directives.fromOutline
			? `It is the ${phase} phase your plan outlined.`
			: `The rules plan a ${phase} block after your last one.`,
		k === 1 ? ' The week since your last block is left unplanned, between blocks.' : '',
		k > 1 ? ` The ${k} weeks since your last block are left unplanned, between blocks.` : ''
	].join('');
	const lost = dates.lostWeeks
		? ` Starting late costs ${dates.lostWeeks} ${dates.lostWeeks === 1 ? 'week' : 'weeks'} of the build before your event.`
		: '';
	const planned = log.add('next_block_planned', 'next_block.planned', ['blocks.0'], {
		block: block.name,
		startsOn,
		weeks: block.weeks.length,
		reason,
		lost,
		lostWeeks: dates.lostWeeks,
		bridgeWeeks: k
	});

	// Significant changes, each tied to the decision that explains it.
	const changes: { change: Omit<SignificantChange, 'decision'>; by: DecisionPlan }[] = [];
	const by = (kind: string) => log.list().filter((d) => d.kind === kind);
	for (const d of by('exercise_rotated')) {
		const { previous: from, exercise: to } = d.evidence;
		changes.push({
			change: { kind: 'swap', subject: String(from), from: String(from), to: String(to) },
			by: d
		});
	}
	for (const d of by('results_progression')) {
		const pct = Number(d.evidence.pct ?? 0);
		if (Math.abs(pct) >= SIGNIFICANT.loadPct) {
			const subject = String(d.evidence.exercise);
			changes.push({ change: { kind: 'load', subject, from: null, to: pct }, by: d });
		}
	}
	// A partial week 1 ('this week' from a Wednesday) is left out of the comparison.
	const full = addDays(startsOn, firstPlannedDay > startsOn ? 7 : 0);
	const [was, now] = [compared(previous.block, previous.block.startsOn), compared(block, full)];
	const before = groupSets(was, next);
	const after = groupSets(now, next);
	for (const group of Object.keys(MUSCLE_GROUP_LABEL) as MuscleGroup[]) {
		const [from, to] = [before.get(group) ?? 0, after.get(group) ?? 0];
		if (Math.abs(to - from) < SIGNIFICANT.hardSets) continue;
		const directed = directives.volume.find((v) => v.group === group)?.reason;
		const subject = MUSCLE_GROUP_LABEL[group];
		const d = log.add('results_progression', 'next_block.hard_sets', ['blocks.0'], {
			exercise: subject,
			change: `${from} to ${to} hard sets a week`,
			reason: `${directed ? `${directed}.` : 'The new block’s exercises and phase set it.'} It moves from ${from} to ${to} hard sets a week.`
		});
		changes.push({ change: { kind: 'hard_sets', subject, from, to }, by: d });
	}
	const [runBefore, runAfter] = [mean(was.map(runMetres)), mean(now.map(runMetres))];
	const runVolume = by('run_volume')[0];
	if (
		runBefore > 0 &&
		runVolume &&
		Math.abs(runAfter - runBefore) / runBefore >= SIGNIFICANT.runVolume
	) {
		const [from, to] = [Math.round(runBefore), Math.round(runAfter)];
		changes.push({ change: { kind: 'run_volume', subject: 'Running', from, to }, by: runVolume });
	}
	if (previous.block.phase !== block.phase) {
		const change = {
			kind: 'phase' as const,
			subject: block.name,
			from: previous.block.phase,
			to: block.phase
		};
		changes.push({ change, by: planned });
	}
	for (const d of by('deload_scheduled'))
		changes.push({
			change: { kind: 'deload', subject: block.name, from: null, to: Number(d.evidence.week) },
			by: d
		});
	if (bridge)
		changes.push({
			change: { kind: 'bridge', subject: bridge.name, from: null, to: k },
			by: planned
		});

	const decisions = log.list();
	const checked = validate(programPlanSchema, {
		title: clip(block.name, 80),
		startsOn,
		firstPlannedDay,
		blocks: [block],
		decisions
	});
	if (!checked.ok) throw new GeneratedPlanError(checked.errors);
	const digest = fnv1a64(
		canonicalJson({
			catalogue: options.catalogueDigest ?? null,
			directives,
			subset: next.subset,
			dates,
			outline: options.outline,
			previous: previousDigest(previous)
		})
	);
	return {
		block: checked.data.blocks[0]!,
		...(bridge && { bridge }),
		decisions: checked.data.decisions,
		fingerprint: fingerprint(next.input, digest, GENERATOR_ID),
		significantChanges: changes.map(({ change, by: d }) => ({
			...change,
			decision: decisions.indexOf(d)
		}))
	};
}
