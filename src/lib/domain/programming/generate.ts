/**
 * The composer (PRD §5): generateProgram(input, {startsOn, firstPlannedDay}) → ProgramPlan, by
 * running every stage, in order, on one draft. Deterministic and pure: the same input and
 * options give the same plan, byte for byte, with no clock, randomness or I/O.
 *
 * - The program_purpose decision says what week 1 is for: a baseline week, and what it
 *   establishes for the lifts and runs the block holds.
 * - A 'This week' start (firstPlannedDay after startsOn) plans only from firstPlannedDay on:
 *   every stage plans from it, and the contract check below refuses a session before it, or any
 *   mid-week start once PARTIAL_FIRST_WEEK (../training/schemas.ts) is turned off.
 * - The plan is checked against programPlanSchema before it is returned, so a plan that breaks
 *   the contract is a GeneratedPlanError here, never a stored version or a coach's tool result.
 *
 * The full stage list lives here from m3/13. Each stage slice replaces only its own stub in
 * ./stages/, and only m3/28 edits this file again (output validation and program_purpose).
 */
import { daysBetween, mondayOf, weekdayOf } from '../calendar.ts';
import { WEEKDAY_INFO } from '../profile/catalog.ts';
import { programPlanSchema } from '../training/schemas.ts';
import type { BlockPlan, ProgramPlan } from '../training/types.ts';
import { validate } from '../validation.ts';
import type { FieldErrors } from '../validation.ts';
import { planFirstBlock } from './blocks.ts';
import { inWords } from './commitments.ts';
import { DecisionLog } from './decisions.ts';
import { allocateWeek, clip, weekBudget } from './demand.ts';
import type { ProgrammingInput } from './input.ts';
import { eachMain } from './loads.ts';
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

/**
 * What week 1 is for, in the program_purpose decision's words, so rewording it is an edit here:
 * its opening, then what it does for the block's main lifts (by whether their 1RMs are known) and
 * its runs (by whether a weekly volume is told). A commitment keeps its own intensity, so when one
 * in week 1 is harder than the cap, the opening sets it aside. Each is short, as the purpose is a
 * decision fact of at most 200 characters: the longest, a Wednesday start with a harder commitment,
 * lifts of both kinds and a told running volume, is checked to fit (scenarios.test.ts).
 */
export const PURPOSE = {
	week: (rpe: number, aside: string) => `Nothing in it goes above RPE ${rpe}${aside}.`,
	partWeek: (day: string, rpe: number, aside: string) =>
		`It plans ${day === 'Sunday' ? 'Sunday only' : `${day} to Sunday`}, at RPE ${rpe} at most${aside}.`,
	aside: ', your commitments aside',
	liftsByRpe: 'Each main lift works up to a top set by RPE, which estimates its 1RM.',
	liftsKnown: 'Each main lift starts at a safe share of your 1RM for it.',
	liftsMixed: 'Lifts with a 1RM start at a safe share of it; the rest work up to a top set by RPE.',
	runsByDistance: 'Runs start from the volume you run now.',
	runsByTime: 'Runs go by time and effort.'
} as const;

/** A decision fact's longest text (programPlanSchema). */
const MAX_FACT = 200;

/** The program_purpose decision's facts, from what the first block holds. */
function purposeFacts(
	planned: readonly BlockPlan[],
	input: ProgrammingInput,
	{ startsOn, firstPlannedDay }: GenerateOptions
) {
	const weeks = planned[0]!.weeks;
	const { targets, sessions } = weeks[0]!;
	const { rpeCap } = targets;
	const harder = sessions.some((s) => s.source === 'commitment' && s.targetRpe > rpeCap);
	const aside = harder ? PURPOSE.aside : '';
	const known = new Set<boolean>();
	for (const week of weeks) {
		eachMain(week, input, (exercise, main) => {
			known.add(main.oneRepMax !== null);
			return exercise;
		});
	}
	const runs = weeks.some((w) =>
		w.sessions.some((s) => s.kind === 'run' && s.source !== 'commitment')
	);
	const day = WEEKDAY_INFO[weekdayOf(firstPlannedDay)].label;
	const sentences = [
		firstPlannedDay > startsOn ? PURPOSE.partWeek(day, rpeCap, aside) : PURPOSE.week(rpeCap, aside),
		known.size > 1
			? PURPOSE.liftsMixed
			: known.size
				? known.has(true)
					? PURPOSE.liftsKnown
					: PURPOSE.liftsByRpe
				: null,
		!runs
			? null
			: (input.running?.weeklyMetres ?? 0) > 0
				? PURPOSE.runsByDistance
				: PURPOSE.runsByTime
	];
	const purpose = sentences.filter((s) => s !== null).join(' ');
	const goals = (input.maintenance ? input.paused : input.goals).map((g) => g.title);
	const goal = !goals.length
		? 'your training'
		: `${inWords(goals)}${input.maintenance ? ', at maintenance' : ''}`;
	return { purpose, goal: clip(goal, MAX_FACT), rpeCap, firstPlannedDay };
}

/** A generated plan the contract refuses: a bug in a stage, never the owner's profile. */
export class GeneratedPlanError extends Error {
	/** Each refused path and why, as programPlanSchema words them. */
	readonly errors: FieldErrors;

	constructor(errors: FieldErrors) {
		const [path, why] = Object.entries(errors)[0] ?? ['', 'Invalid'];
		super(`The generated plan breaks the contract at ${path || 'its root'}: ${why}`);
		this.name = 'GeneratedPlanError';
		this.errors = errors;
	}
}

export function generateProgram(input: ProgrammingInput, options: GenerateOptions): ProgramPlan {
	const { startsOn, firstPlannedDay } = options;
	if (mondayOf(startsOn) !== startsOn)
		throw new RangeError(`Week 1 starts on a Monday: ${startsOn}`);
	const offset = daysBetween(startsOn, firstPlannedDay);
	if (offset < 0 || offset > 6) throw new RangeError(`Not a day of week 1: ${firstPlannedDay}`);

	const context = { input, options, log: new DecisionLog() };
	let draft: Draft = { demand: null, blocks: [] };
	for (const stage of STAGES) draft = stage.run(draft, context);
	const facts = purposeFacts(draft.blocks, input, options);
	context.log.add('program_purpose', 'program.baseline_week', ['blocks.0.weeks.0'], facts);
	const goals = input.maintenance ? input.paused : input.goals;
	const title = goals.map((g) => g.title).join(' · ') || 'Training';
	const checked = validate(programPlanSchema, {
		title: clip(input.maintenance ? `Maintenance · ${title}` : title, 80),
		startsOn,
		firstPlannedDay,
		blocks: draft.blocks,
		decisions: context.log.list()
	});
	if (!checked.ok) throw new GeneratedPlanError(checked.errors);
	return checked.data;
}
