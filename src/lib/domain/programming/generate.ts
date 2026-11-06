/**
 * The composer (PRD §5): generateProgram(input, {startsOn, firstPlannedDay}) → ProgramPlan, by
 * running every stage, in order, on one draft. Deterministic and pure: the same input and
 * options give the same plan, byte for byte, with no clock, randomness or I/O.
 *
 * The full stage list lives here from m3/13. Each stage slice replaces only its own stub in
 * ./stages/, and only m3/28 edits this file again (output validation and program_purpose).
 */
import { daysBetween, mondayOf } from '../calendar.ts';
import type { ProgramPlan } from '../training/types.ts';
import { planFirstBlock } from './blocks.ts';
import { DecisionLog } from './decisions.ts';
import { allocateWeek, clip, weekBudget } from './demand.ts';
import type { ProgrammingInput } from './input.ts';
import type { Draft, GenerateOptions, Stage } from './stage.ts';
import { commitments } from './stages/commitments.ts';
import { loads } from './stages/loads.ts';
import { other } from './stages/other.ts';
import { placement } from './stages/placement.ts';
import { progression } from './stages/progression.ts';
import { running } from './stages/running.ts';
import { strength } from './stages/strength.ts';
import { timefit } from './stages/timefit.ts';
import { volume } from './stages/volume.ts';

const demand: Stage = (draft, { input, log }) => {
	const budget = weekBudget(input);
	return { ...draft, demand: { budget, allocation: allocateWeek(input, budget, log) } };
};

const blocks: Stage = (draft, { input, options, log }) => ({
	...draft,
	blocks: planFirstBlock(input, options.startsOn, log)
});

/** Every stage, in the order they run. */
export const STAGES: readonly { name: string; run: Stage }[] = [
	{ name: 'demand', run: demand },
	{ name: 'blocks', run: blocks },
	{ name: 'commitments', run: commitments },
	{ name: 'strength', run: strength },
	{ name: 'running', run: running },
	{ name: 'other', run: other },
	{ name: 'placement', run: placement },
	{ name: 'volume', run: volume },
	{ name: 'loads', run: loads },
	{ name: 'progression', run: progression },
	{ name: 'timefit', run: timefit }
];

export function generateProgram(input: ProgrammingInput, options: GenerateOptions): ProgramPlan {
	const { startsOn, firstPlannedDay } = options;
	if (mondayOf(startsOn) !== startsOn)
		throw new RangeError(`Week 1 starts on a Monday: ${startsOn}`);
	const offset = daysBetween(startsOn, firstPlannedDay);
	if (offset < 0 || offset > 6) throw new RangeError(`Not a day of week 1: ${firstPlannedDay}`);

	const context = { input, options, log: new DecisionLog() };
	let draft: Draft = { demand: null, blocks: [] };
	for (const stage of STAGES) draft = stage.run(draft, context);
	const goals = input.maintenance ? input.paused : input.goals;
	const title = goals.map((g) => g.title).join(' · ') || 'Training';
	return {
		title: clip(input.maintenance ? `Maintenance · ${title}` : title, 80),
		startsOn,
		firstPlannedDay,
		blocks: draft.blocks,
		decisions: context.log.list()
	};
}
