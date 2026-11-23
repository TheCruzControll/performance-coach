/**
 * The words an activity chip shows while a tool runs, once it is done and if it fails ('Looking
 * at your last 6 bench sessions…', 'Drafting the change…'). Every tool has its own wording, in
 * the coach's voice.
 *
 * A chip never shows a raw id. The input and output are whatever the model and the tool produced,
 * so the wording reads only these fields and drops any value that does not pass its check:
 * - `exercise`: a short name, from the input, else from the output (a string or `{name}`). A
 *   UUID, a snake_case catalogue key, a `type:id` ref, a path, a long token with a digit or a
 *   control character is dropped, and the tool's general wording is used instead.
 * - `weeks` and `limit` in the input: whole numbers from 1 to 999.
 * - once done, how many results came back: the output's `items` length, or its `count`. It
 *   replaces `limit`; none is not a count.
 */
import type { ActivityState } from './events.ts';
import type { ToolName } from './tools.ts';

export type ActivityWording = Readonly<Record<ActivityState, string>>;

/** For a name the catalogue does not know: the chip never repeats what the model asked for. */
export const GENERIC_ACTIVITY: ActivityWording = Object.freeze({
	running: 'Working on it…',
	done: 'Finished a step',
	failed: 'Couldn’t finish a step'
});

/** What the wording may show, each value already checked. */
interface Facts {
	exercise?: string;
	weeks?: number;
	count?: number;
}

type Triple = readonly [running: string, done: string, failed: string];

const MAX_NAME_CHARS = 40;
const MAX_TOKEN_CHARS = 20;
const MAX_NUMBER = 999;

function fields(value: unknown): (key: string) => unknown {
	const record = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
	return (key) =>
		Object.hasOwn(record, key) ? (record as Record<string, unknown>)[key] : undefined;
}

function whole(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_NUMBER
		? value
		: undefined;
}

/** A name that is safe to show, or undefined for anything that could be an id, key or ref. */
function name(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const text = value.trim();
	if (text.length === 0 || text.length > MAX_NAME_CHARS || !/\p{L}/u.test(text)) return undefined;
	if (/[_:/\\[\]|\p{Cc}]/u.test(text) || /[0-9a-f]{8}-[0-9a-f]{4}/i.test(text)) return undefined;
	const tokens = text.split(/\s+/);
	if (tokens.some((t) => t.length > MAX_TOKEN_CHARS || (t.length >= 8 && /\d/.test(t))))
		return undefined;
	return text;
}

function inputFacts(input: unknown): Facts {
	const field = fields(input);
	return {
		exercise: name(field('exercise')),
		weeks: whole(field('weeks')),
		count: whole(field('limit'))
	};
}

function outputFacts(input: unknown, output: unknown): Facts {
	const facts = inputFacts(input);
	const field = fields(output);
	const items = field('items');
	const count = Array.isArray(items) ? whole(items.length) : whole(field('count'));
	const exercise = field('exercise');
	return {
		...facts,
		exercise: facts.exercise ?? name(exercise) ?? name(fields(exercise)('name')),
		count: count ?? (Array.isArray(items) ? undefined : facts.count)
	};
}

/** "3 alternatives", "1 alternative". */
const counted = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
/** After "last": "week" for one, "4 weeks". */
const last = (n: number, noun: string) => (n === 1 ? noun : `${n} ${noun}s`);

const look = (s: string): Triple => [`Looking at ${s}…`, `Looked at ${s}`, `Couldn’t load ${s}`];
const check = (s: string): Triple => [`Checking ${s}…`, `Checked ${s}`, `Couldn’t check ${s}`];
const draft = (s: string): Triple => [`Drafting ${s}…`, `Drafted ${s}`, `Couldn’t draft ${s}`];
const prepare = (s: string): Triple => [
	`Preparing ${s}…`,
	`Prepared ${s}`,
	`Couldn’t prepare ${s}`
];

const WORDING: Readonly<Record<ToolName, (f: Facts) => Triple>> = {
	// History
	get_training_history: (f) =>
		look(
			f.weeks
				? `your last ${last(f.weeks, 'week')} of training`
				: f.count
					? `your last ${last(f.count, 'session')}`
					: 'your training history'
		),
	get_exercise_history: (f) =>
		look(
			!f.exercise
				? 'your exercise history'
				: f.count
					? `your last ${last(f.count, `${f.exercise} session`)}`
					: `your ${f.exercise} history`
		),
	get_running_history: (f) =>
		look(
			f.weeks
				? `your last ${last(f.weeks, 'week')} of running`
				: f.count
					? `your last ${last(f.count, 'run')}`
					: 'your running history'
		),
	get_recent_workouts: (f) =>
		look(f.count ? `your last ${last(f.count, 'workout')}` : 'your recent workouts'),
	get_personal_records: (f) =>
		look(f.exercise ? `your ${f.exercise} records` : 'your personal records'),
	// Programming
	get_current_program: () => look('your current program'),
	get_current_training_week: () => look('this week’s plan'),
	get_training_schedule: (f) =>
		look(f.weeks ? `the next ${last(f.weeks, 'week')} of your schedule` : 'your training schedule'),
	get_program_history: () => [
		'Looking at how your program has changed…',
		'Looked at how your program has changed',
		'Couldn’t load your program’s history'
	],
	get_coach_proposals: () => check('my earlier proposals'),
	evaluate_week_interference: () => check('this week’s schedule'),
	explain_schedule_tradeoffs: () => look('why your week is shaped this way'),
	propose_program_adjustment: () => draft('the change'),
	create_training_program: () => [
		'Building a new program…',
		'Built a new program for you to review',
		'Couldn’t build a new program'
	],
	create_next_training_cycle: () => draft('your next cycle'),
	// Workout
	get_current_workout: () => look('today’s workout'),
	get_exercise_alternatives: (f) => {
		const to = f.exercise ? ` to ${f.exercise}` : '';
		return [
			`Finding alternatives${to}…`,
			`Found ${f.count ? counted(f.count, 'alternative') : 'alternatives'}${to}`,
			`Couldn’t find alternatives${to}`
		];
	},
	update_workout: () => draft('a change to today’s workout'),
	substitute_exercise: (f) => prepare(f.exercise ? `a swap for ${f.exercise}` : 'a swap'),
	save_workout_analysis: () => [
		'Saving notes on your workout…',
		'Saved notes on your workout',
		'Couldn’t save notes on your workout'
	],
	// Preferences
	get_training_preferences: () => check('your preferences'),
	update_exercise_preferences: (f) => {
		const s = f.exercise ? `your preference about ${f.exercise}` : 'your exercise preference';
		return [`Noting ${s}…`, `Noted ${s}`, `Couldn’t note ${s}`];
	},
	update_training_goals: () => prepare('a change to your goals'),
	// Analytics
	get_weekly_training_summary: (f) => {
		const s = f.weeks ? `your last ${last(f.weeks, 'week')}` : 'your training week';
		return [`Summarising ${s}…`, `Summarised ${s}`, `Couldn’t summarise ${s}`];
	},
	get_training_load: (f) => {
		const s = f.weeks
			? `your training load over the last ${last(f.weeks, 'week')}`
			: 'your training load';
		return [`Working out ${s}…`, `Worked out ${s}`, `Couldn’t work out ${s}`];
	},
	get_performance_trends: (f) =>
		check(f.exercise ? `your ${f.exercise} trend` : 'your performance trends')
};

/**
 * The chip's three wordings. Running and failed read only the input; done also reads the output.
 * A name outside the catalogue gets GENERIC_ACTIVITY.
 */
export function activityLabel(tool: ToolName, input: unknown, output?: unknown): ActivityWording {
	if (!Object.hasOwn(WORDING, tool)) return GENERIC_ACTIVITY;
	const words = WORDING[tool];
	const before = words(inputFacts(input));
	return Object.freeze({
		running: before[0],
		done: words(outputFacts(input, output))[1],
		failed: before[2]
	});
}
