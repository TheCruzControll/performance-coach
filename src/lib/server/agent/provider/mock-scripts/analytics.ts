/**
 * The mock coach's scripts for the analytics tools. Each answer is computed from the turn's tool
 * results: every number is a figure a tool returned, in a `[metric method=…]` block carrying the
 * tool's own method and citing the figure's period, and too little data is said, never a zero.
 * - 'Am I doing enough weekly volume?' reads this week's summary: hard sets per muscle group,
 *   sessions completed against planned, and minutes.
 * - 'How is my running affecting my lifting?' reads the trends and the training load, and states
 *   how running distance and load changed, without claiming a cause.
 * - 'What should I focus on next week?' reads this week's summary and the load, then recommends
 *   from the ratio and the skipped sessions.
 */
import type { MockContext, MockScript } from '../mock.ts';

const VOLUME = /\b(enough|too much)\b.*\bvolume\b/i;
const RUNNING_LIFTING = /\brunning\b.*\b(lifting|lifts?|strength)\b/i;
const NEXT_WEEK = /\bfocus on\b.*\bnext week\b/i;

/** The acute:chronic band the load's caveat calls typical (ACWR_CAVEAT): below it, above it. */
const RATIO_BAND = Object.freeze({ low: 0.8, high: 1.3 });

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
interface Insufficient {
	status: 'insufficient_data';
	reason: string;
}
type Summary =
	| Insufficient
	| {
			status: 'ok';
			week: { from: string; inProgress: boolean };
			planned: Figure;
			completed: Figure;
			skipped: Figure;
			minutes: Figure;
			hardSets: Omit<Figure, 'value'> & { values: Record<string, number> };
	  };
type Load = Insufficient | { status: 'ok'; ratio: Figure; caveat: string };
interface Trend {
	metric: string;
	unit: string | null;
	method: string;
	sources: Ref[];
	change: { enoughData: boolean; earlier?: number; later?: number; direction?: string };
	changeMethod: string;
}
type Trends = Insufficient | { status: 'ok'; trends: Trend[] };

/** A ref as the answer grammar writes it, its label free of the grammar's characters. */
const cite = (ref: Ref) =>
	`[[${ref.type}:${ref.id}${ref.label ? `|${ref.label.replace(/[[\]|\n]/g, ' ').slice(0, 80)}` : ''}]]`;
const amount = (value: number, unit: string | null) => (unit ? `${value} ${unit}` : `${value}`);
const metric = (method: string, text: string, source: Ref) =>
	`[metric method=${method}] ${text} ${cite(source)}`;

function volumeAnswer(context: MockContext): string {
	const summary = context.result('get_weekly_training_summary') as Summary;
	if (summary.status !== 'ok')
		return '[note] Nothing is planned or logged this week yet, so there is no weekly volume to measure. Log a session and ask again.';
	const period = summary.planned.sources[0]!;
	const groups = Object.entries(summary.hardSets.values);
	const sets =
		groups.length === 0
			? '[note] No strength sets are logged this week, so there are no hard sets to count yet.'
			: metric(
					summary.hardSets.method,
					`Hard sets this week: ${groups.map(([group, n]) => `${group} ${n}`).join(', ')}.`,
					period
				);
	const { completed, planned, minutes } = summary;
	return [
		summary.week.inProgress ? 'Here is this week so far.' : 'Here is that week.',
		sets,
		metric(
			completed.method,
			`Completed: ${amount(completed.value, completed.unit)} of ${amount(planned.value, planned.unit)} planned.`,
			period
		),
		metric(minutes.method, `Time trained: ${amount(minutes.value, minutes.unit)}.`, period),
		'[note] Whether that is enough depends on how it compares with your usual weeks; ask how your training has trended to see that.'
	].join('\n\n');
}

function trendLine(trend: Trend, name: string): string {
	const { change } = trend;
	if (!change.enoughData)
		return `[note] There are not enough complete weeks yet to say how your ${name} changed.`;
	return metric(
		trend.changeMethod,
		`Your ${name} went from ${amount(change.earlier!, trend.unit)} to ${amount(change.later!, trend.unit)} a week (${change.direction}).`,
		trend.sources[0]!
	);
}

function ratioLine(load: Load): string[] {
	if (load.status !== 'ok')
		return ['[note] There is not enough history yet for a training load ratio.'];
	return [
		metric(
			load.ratio.method,
			`Acute:chronic load ratio: ${load.ratio.value}.`,
			load.ratio.sources[0]!
		),
		`[note] ${load.caveat}`
	];
}

function runningAnswer(context: MockContext): string {
	const trends = context.result('get_performance_trends') as Trends;
	const load = context.result('get_training_load') as Load;
	if (trends.status !== 'ok')
		return '[note] Nothing is logged in your recent complete weeks, so I can’t compare your running and lifting yet.';
	const named = (metric: string) => trends.trends.find((t) => t.metric === metric);
	const running = named('running_distance');
	const sessionLoad = named('session_load');
	return [
		'Here is how your running and your overall load have moved.',
		running ? trendLine(running, 'running distance') : '[note] No runs are logged in these weeks.',
		...(sessionLoad ? [trendLine(sessionLoad, 'training load')] : []),
		...ratioLine(load),
		'[note] These numbers show what changed, not why: they can’t tell whether your running is holding your lifting back.'
	].join('\n\n');
}

function focusAnswer(context: MockContext): string {
	const summary = context.result('get_weekly_training_summary') as Summary;
	const load = context.result('get_training_load') as Load;
	if (summary.status !== 'ok' && load.status !== 'ok')
		return '[note] There isn’t enough logged training yet to say what to focus on. [recommendation] Follow your plan next week and log each session, and I’ll have numbers to work from.';
	const blocks = ['Here is what this week and your load point to.', ...ratioLine(load)];
	if (summary.status === 'ok' && summary.skipped.value > 0)
		blocks.push(
			metric(
				summary.skipped.method,
				`Skipped this week: ${amount(summary.skipped.value, summary.skipped.unit)}.`,
				summary.skipped.sources[0]!
			)
		);
	const ratio = load.status === 'ok' ? load.ratio.value : null;
	blocks.push(
		ratio === null
			? '[recommendation] Focus on completing every planned session next week and rating how hard each felt, so your load can be measured.'
			: ratio > RATIO_BAND.high
				? '[recommendation] Your load has risen quickly: keep next week’s training about where it is rather than adding more.'
				: ratio < RATIO_BAND.low
					? '[recommendation] Your load has dropped: build back gradually next week, adding a little rather than all at once.'
					: '[recommendation] Your load is steady: focus on completing every planned session next week.'
	);
	return blocks.join('\n\n');
}

export const analyticsScripts: readonly MockScript[] = [
	{
		name: 'weekly-volume',
		matches: (text) => VOLUME.test(text),
		steps: [{ tools: [{ name: 'get_weekly_training_summary', input: {} }] }, { text: volumeAnswer }]
	},
	{
		name: 'running-and-lifting',
		matches: (text) => RUNNING_LIFTING.test(text),
		steps: [
			{
				tools: [
					{ name: 'get_performance_trends', input: {} },
					{ name: 'get_training_load', input: {} }
				]
			},
			{ text: runningAnswer }
		]
	},
	{
		name: 'next-week-focus',
		matches: (text) => NEXT_WEEK.test(text),
		steps: [
			{
				tools: [
					{ name: 'get_weekly_training_summary', input: {} },
					{ name: 'get_training_load', input: {} }
				]
			},
			{ text: focusAnswer }
		]
	}
];
