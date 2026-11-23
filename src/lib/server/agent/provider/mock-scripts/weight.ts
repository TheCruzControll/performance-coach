/**
 * The mock coach's script for the owner's body weight (the weight plan's PR 7). Its answer is
 * computed from the turn's get_body_weight result: every number is a figure the tool returned, in
 * the tool's own [metric method=…] or [fact] form, citing the weigh-in or goal it rests on. A change
 * is said in words from its direction, never with a minus sign, as the tool gives it.
 * - 'Am I losing faster than planned?' (or any question about body weight, a weigh-in or the weight
 *   goal) reads the trend, the change per week and the goal, and states whether the trend is ahead
 *   of the goal line, behind it or on track, with the gap, as the tool gave the verdict.
 * With no weigh-in logged, it says so and gives no figure.
 */
import type { MockContext, MockScript } from '../mock.ts';

const WEIGHT =
	/\b(body\s+weight|my\s+weight|weight\s+(?:trend|rate|goal|loss|gain)|weigh(?:ed|ing|-?ins?)?|(?:losing|gaining)\s+(?:weight|faster|slower))\b/i;

interface Ref {
	type: string;
	id: string;
	label?: string;
}
interface Figure {
	value: number;
	unit: string | null;
	method: string;
	sources: Ref[];
}
/** A computed change: its size, and which way it went. */
interface Movement extends Figure {
	direction: 'up' | 'down' | 'flat';
}
interface WeighIn {
	day: string;
	weight: number;
	source: Ref;
}
interface Goal {
	verdict: 'ahead' | 'behind' | 'on_track' | 'no_data';
	gap: Figure | null;
	requiredRate: Movement | null;
	actualRate: Movement | null;
}
type Weight =
	| { status: 'insufficient_data'; reason: string }
	| {
			status: 'ok';
			unit: string;
			latest: WeighIn;
			trend: Figure;
			weeklyRate: Movement | null;
			goal: Goal | null;
	  };

/** A ref as the answer grammar writes it, its label free of the grammar's characters. */
const cite = (ref: Ref) =>
	`[[${ref.type}:${ref.id}${ref.label ? `|${ref.label.replace(/[[\]|\n]/g, ' ').slice(0, 80)}` : ''}]]`;

const amount = (value: number, unit: string) => `${value} ${unit}`;

/** A change in words: its size and its direction, a week's pace. */
const pace = (change: Movement, unit: string) =>
	change.direction === 'flat'
		? 'not moving'
		: `${change.direction} ${amount(change.value, unit)} a week`;

function goalLine(goal: Goal, unit: string): string[] {
	if (goal.verdict === 'no_data' || goal.gap === null)
		return ['[note] There are not enough weigh-ins around the start of your goal to judge it yet.'];
	const where =
		goal.verdict === 'ahead' ? 'ahead of' : goal.verdict === 'behind' ? 'behind' : 'on track with';
	return [
		`[metric method=${goal.gap.method}] Your trend is ${where} your goal line, ${amount(goal.gap.value, unit)} away ${cite(goal.gap.sources[0]!)}.`,
		...(goal.actualRate && goal.requiredRate
			? [
					`[metric method=${goal.actualRate.method}] Over the last 28 days your trend has been ${pace(goal.actualRate, unit)}, and reaching the target needs it ${pace(goal.requiredRate, unit)} ${cite(goal.actualRate.sources[0]!)}.`
				]
			: [])
	];
}

function weightAnswer(context: MockContext): string {
	const weight = context.result('get_body_weight') as Weight;
	if (weight.status !== 'ok')
		return '[note] You have no weigh-ins logged yet, so there is no trend to read. Log a weigh-in and ask again.';
	const { unit, latest, trend, weeklyRate, goal } = weight;
	return [
		'Here is where your weight trend stands.',
		`[fact] Your latest weigh-in is ${amount(latest.weight, unit)} ${cite(latest.source)}.`,
		`[metric method=${trend.method}] Your trend is ${amount(trend.value, unit)} ${cite(trend.sources[0]!)}.`,
		...(weeklyRate
			? [
					`[metric method=${weeklyRate.method}] Your trend is ${pace(weeklyRate, unit)} ${cite(weeklyRate.sources[0]!)}.`
				]
			: []),
		...(goal ? goalLine(goal, unit) : []),
		'[note] These numbers show where your weight is moving, not why.'
	].join('\n\n');
}

export const weightScripts: readonly MockScript[] = [
	{
		name: 'weight-trend',
		matches: (text) => WEIGHT.test(text),
		steps: [{ tools: [{ name: 'get_body_weight', input: {} }] }, { text: weightAnswer }]
	}
];
