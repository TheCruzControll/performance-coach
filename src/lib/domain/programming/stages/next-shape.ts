/**
 * The next block's shape (M6), in place of M3's blocks stage when generateNextBlock runs the stage
 * list: one planned block on the dates nextBlockDates gave, with its phase, its week kinds (the
 * directed deload first or last) and each week's targets held to the cycle review's.
 *
 * - The block is dates.block, named and goal-linked as the outline block it plans, or by its
 *   phase when it is appended. Every stage after this one plans from dates.firstPlannedDay, so a
 *   'this week' start on a Wednesday holds nothing on Monday or Tuesday.
 * - A building week is an accumulation week, a build week in a marathon or half phase, and a taper
 *   phase tapers every week. Its targets are M3's (rules/blocks.ts) with the RPE cap held to the
 *   review's, the volume and running factors scaled by the owner's part, and the load step the
 *   review's. A held block repeats the first building week: nothing rises week to week.
 * - With the directives' weekPlan (M7's season), the plan gives the week kinds and targets instead:
 *   plannedWeeks. The block records the season's block_type_chosen, and a deload_scheduled for each
 *   deload the season's cadence placed (the directed one is the results stage's).
 * - The bridge (late reviews) is emitted by bridgeBlock, not put in the draft: M3's stages fill
 *   every planned week they see and count running weeks across blocks, so the bridge stays out of
 *   them and generateNextBlock places it before the block.
 */
import { addDays } from '../../calendar.ts';
import type { BlockPlan, WeekPlan, WeekTargets } from '../../training/types.ts';
import { PHASE_LABEL } from '../../training/vocabulary.ts';
import type { Phase, WeekKind } from '../../training/vocabulary.ts';
import { cleanFloat } from '../../units.ts';
import { clip } from '../demand.ts';
import { BRIDGE_PHASE, BRIDGE_WEEK_KIND } from '../next-block/dates.ts';
import type { NextBlockDates } from '../next-block/dates.ts';
import { deloadWeek } from '../periodisation/deload.ts';
import { LIGHT_RUNNING_WEEK_KINDS } from '../periodisation/kinds.ts';
import type { CycleDirectives, DeloadPlacement, NextCycleSubset } from '../review/directives.ts';
import type { PlannedWeek } from '../review/directives.ts';
import { weekTargets } from '../rules/blocks.ts';
import { TARGETS } from '../rules/deload.ts';
import type { Stage } from '../stage.ts';
import { recordDeloads } from './blocks.ts';

/** Phases that only taper: every week of them is a taper week. */
const TAPER_PHASES: readonly Phase[] = ['taper', 'marathon_taper', 'half_taper'];
const RUNNING_PHASE = /^(marathon|half)_/;

/**
 * An unplanned bridge week's targets: nothing is planned in it, so it asks for no volume. The RPE
 * cap is the contract's least that still reads as easy, should a logged session be compared to it.
 */
export const BRIDGE_TARGETS: WeekTargets = {
	rpeCap: 7,
	volumeFactor: 0,
	loadStep: 0,
	runVolumeFactor: 0
};

export interface NextShape {
	dates: NextBlockDates;
	/** The outline block planned, as the current version holds it; null when appended. */
	outline: BlockPlan | null;
	phase: Phase;
	deload: DeloadPlacement;
	/** The owner's part of the directives, after clampOverrides. */
	targets: NextCycleSubset['targets'];
	/** The directives' progression is hold: nothing increases. */
	hold: boolean;
	/** The season's weeks (directives.weekPlan); absent, the phase's own weeks are planned. */
	weekPlan?: readonly PlannedWeek[];
	/** The season's block_type_chosen (directives.blockType). */
	blockType?: CycleDirectives['blockType'];
}

const building = (kind: WeekKind) => kind === 'accumulation' || kind === 'build';

/** The block's week kinds: its phase's building (or taper) week, with the directed deload. */
export function nextWeekKinds(weeks: number, phase: Phase, deload: DeloadPlacement): WeekKind[] {
	const kind: WeekKind = TAPER_PHASES.includes(phase)
		? 'taper'
		: RUNNING_PHASE.test(phase)
			? 'build'
			: 'accumulation';
	const kinds: WeekKind[] = Array.from({ length: weeks }, () => kind);
	if (deload === 'first') kinds[0] = 'deload';
	else if (deload === 'last' && weeks > 1) kinds[weeks - 1] = 'deload';
	return kinds;
}

/** A week's targets: M3's for its kind and step, held to the review's. */
export function nextWeekTargets(
	kind: WeekKind,
	step: number,
	{ targets, hold }: Pick<NextShape, 'targets' | 'hold'>
): WeekTargets {
	const t = weekTargets(kind, hold ? 0 : step);
	const rpeCap = Math.min(t.rpeCap, targets.rpeCap);
	if (!building(kind)) return { ...t, rpeCap };
	const volumeFactor = cleanFloat(t.volumeFactor * targets.volumeFactor, 3);
	const runVolumeFactor = cleanFloat(t.runVolumeFactor * targets.runVolumeFactor, 3);
	return {
		rpeCap,
		volumeFactor: hold ? Math.min(1, volumeFactor) : volumeFactor,
		loadStep: hold ? 0 : targets.loadStep,
		runVolumeFactor: hold ? Math.min(1, runVolumeFactor) : runVolumeFactor
	};
}

const LIGHT: readonly WeekKind[] = LIGHT_RUNNING_WEEK_KINDS;

/**
 * The season's weeks for a block of `weeks` (M7): week i is the plan's, and past its end the plan's
 * last loading week again. The directed deload replaces the first or last week, unless the plan
 * already deloads it. Every week's targets are held to the review's as nextWeekTargets holds M3's:
 * the RPE cap, the owner's volume and running factors on loading weeks, and the review's load step.
 * A held block repeats the plan's first loading week, so nothing rises week to week.
 */
export function plannedWeeks(
	weeks: number,
	plan: readonly PlannedWeek[],
	{ deload, targets, hold }: Pick<NextShape, 'deload' | 'targets' | 'hold'>
): PlannedWeek[] {
	const loading = plan.filter((w) => !LIGHT.includes(w.kind));
	const filler = loading.at(-1) ?? plan.at(-1)!;
	const out = Array.from({ length: weeks }, (_, i): PlannedWeek => {
		const week = plan[i] ?? filler;
		const from = hold && loading[0] && !LIGHT.includes(week.kind) ? loading[0] : week;
		return { kind: week.kind, targets: structuredClone(from.targets) };
	});
	const at = deload === 'first' ? 0 : deload === 'last' && weeks > 1 ? weeks - 1 : -1;
	const directed = out[at];
	if (directed && directed.kind !== 'deload')
		out[at] = { kind: 'deload', targets: deloadWeek(directed.targets, TARGETS, directed.kind) };
	return out.map(({ kind, targets: t }) => {
		const rpeCap = Math.min(t.rpeCap, targets.rpeCap);
		const mainLifts = t.mainLifts && {
			...t.mainLifts,
			topRpe: Math.min(t.mainLifts.topRpe, rpeCap)
		};
		const capped = { ...t, rpeCap, ...(mainLifts && { mainLifts }) };
		if (LIGHT.includes(kind)) return { kind, targets: capped };
		const volumeFactor = cleanFloat(t.volumeFactor * targets.volumeFactor, 3);
		const runVolumeFactor = cleanFloat(t.runVolumeFactor * targets.runVolumeFactor, 3);
		return {
			kind,
			targets: {
				...capped,
				volumeFactor: hold ? Math.min(1, volumeFactor) : volumeFactor,
				loadStep: hold ? 0 : targets.loadStep,
				runVolumeFactor: hold ? Math.min(1, runVolumeFactor) : runVolumeFactor
			}
		};
	});
}

/** The bridge before a late block: a planned block of empty unplanned weeks. */
export function bridgeBlock(bridge: NonNullable<NextBlockDates['bridge']>): BlockPlan {
	const weeks = Array.from({ length: bridge.weeks }, (_, i): WeekPlan => {
		const startsOn = addDays(bridge.startsOn, 7 * i);
		const targets = { ...BRIDGE_TARGETS };
		return {
			kind: BRIDGE_WEEK_KIND,
			startsOn,
			endsOn: addDays(startsOn, 6),
			targets,
			sessions: []
		};
	});
	return {
		phase: BRIDGE_PHASE,
		name: PHASE_LABEL[BRIDGE_PHASE],
		startsOn: bridge.startsOn,
		endsOn: bridge.endsOn,
		outline: false,
		goalRefs: [],
		progression: {},
		weeks
	};
}

/** The stage: the draft's only block, on the next block's dates. */
export function nextShape(shape: NextShape): Stage {
	return (draft, { input, log }) => {
		const { block: dated } = shape.dates;
		let step = 0;
		// The season's weeks run from the Monday after the reviewed block: the bridge's are skipped.
		const plan = shape.weekPlan?.slice(shape.dates.bridge?.weeks ?? 0);
		const planned = plan?.length
			? plannedWeeks(dated.weeks, plan, shape)
			: nextWeekKinds(dated.weeks, shape.phase, shape.deload).map((kind) => {
					const targets = nextWeekTargets(kind, step, shape);
					if (building(kind)) step += 1;
					return { kind, targets };
				});
		const weeks = planned.map(({ kind, targets }, i) => {
			const startsOn = addDays(dated.startsOn, 7 * i);
			return { kind, startsOn, endsOn: addDays(startsOn, 6), targets, sessions: [] };
		});
		const refs = input.maintenance ? input.refs.paused : input.refs.goals;
		// An outline whose phase the season replaced is named for the phase planned.
		const outlined = shape.blockType?.facts.outlined ? '' : shape.outline?.name;
		const name = clip(outlined || PHASE_LABEL[shape.phase], 60);
		if (plan?.length) {
			const { blockType } = shape;
			if (blockType)
				log.add('block_type_chosen', blockType.ruleKey, ['blocks.0'], {
					...blockType.facts,
					block: name,
					weeks: dated.weeks,
					startsOn: dated.startsOn
				});
			// The directed deload is the results stage's to record.
			recordDeloads(weeks, log, { first: 0, last: weeks.length - 1, none: -1 }[shape.deload]);
		}
		const block: BlockPlan = {
			phase: shape.phase,
			name,
			startsOn: dated.startsOn,
			endsOn: dated.endsOn,
			outline: false,
			goalRefs: [...(shape.outline?.goalRefs ?? refs)],
			progression: { ...shape.outline?.progression },
			weeks
		};
		return { ...draft, blocks: [block] };
	};
}
