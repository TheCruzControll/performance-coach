/**
 * The mock coach's scripts for a review's write-up (agent/reviews/narrate.ts, M6). The write-up
 * turn is read-only, opened with entry weekly_review_writeup or cycle_review_writeup, and its turn
 * context names the review's proposal and the decision on it.
 * - 'weekly-review' (entry weekly_review_writeup) reads the reviewed week's summary and the trends,
 *   then writes the week up: sessions completed against planned, time trained and skipped
 *   sessions, how the training load moved, and a recommendation from the decision on the review's
 *   proposal.
 * - 'cycle-review' (entry cycle_review_writeup) reads last week's summary and the trends, then
 *   writes the block up the same way, with the decision on the next cycle.
 * Every number is a figure a tool returned, in a block citing the figure's own source.
 * - 'review-propose' (forced by the test route) tries propose_program_adjustment, which a review's
 *   turn does not offer, then answers with a note.
 * - 'review-ungrounded' (forced) states a fact no tool returned, which the output policy replaces.
 */
import { addDays, mondayOf, type IsoDate } from '../../../../domain/calendar.ts';
import type { MockContext, MockScript } from '../mock.ts';

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
type Summary =
	| { status: 'insufficient_data' }
	| { status: 'ok'; planned: Figure; completed: Figure; skipped: Figure; minutes: Figure };
interface Trend {
	metric: string;
	unit: string | null;
	sources: Ref[];
	change: { enoughData: boolean; earlier?: number; later?: number; direction?: string };
	changeMethod: string;
}
type Trends = { status: 'insufficient_data' } | { status: 'ok'; trends: Trend[] };
interface ReviewContext {
	date?: string;
	entry?: { from?: string; ref?: { type?: string; id?: string } | null } | null;
	review?: { proposal: { id: string; kind: string; decision: string } | null };
}

/** The fact 'review-ungrounded' states: no tool returned it, so the policy replaces it. */
export const UNGROUNDED_FACT = 'You squatted 312 kg for 9 reps on Tuesday.';

const facts = (context: MockContext) => (context.turnContext ?? {}) as ReviewContext;
const from = (context: MockContext) => facts(context).entry?.from;

const cite = (ref: Ref) =>
	`[[${ref.type}:${ref.id}${ref.label ? `|${ref.label.replace(/[[\]|\n]/g, ' ').slice(0, 80)}` : ''}]]`;
const amount = (value: number, unit: string | null) => (unit ? `${value} ${unit}` : `${value}`);
const metric = (figure: Figure, text: string) =>
	`[metric method=${figure.method}] ${text} ${cite(figure.sources[0]!)}`;

/** The reviewed week's Monday, from the entry's review key (`w-<Monday>`). */
function reviewedWeek(context: MockContext): Record<string, unknown> {
	const id = facts(context).entry?.ref?.id ?? '';
	if (id.startsWith('w-')) return { week: id.slice(2) };
	// A cycle review: the last complete week before today.
	const today = facts(context).date;
	return today ? { week: mondayOf(addDays(today as IsoDate, -7)) } : {};
}

function weekLines(summary: Summary, period: string): string[] {
	if (summary.status !== 'ok')
		return [`[note] Nothing was planned or logged ${period}, so there is nothing to measure.`];
	const { planned, completed, skipped, minutes } = summary;
	return [
		metric(
			completed,
			`Completed ${period}: ${amount(completed.value, completed.unit)} of ${amount(planned.value, planned.unit)} planned.`
		),
		metric(minutes, `Time trained ${period}: ${amount(minutes.value, minutes.unit)}.`),
		skipped.value > 0
			? `[fact] You skipped ${amount(skipped.value, skipped.unit)} ${period} ${cite(skipped.sources[0]!)}.`
			: `[fact] You skipped no planned session ${period} ${cite(planned.sources[0]!)}.`
	];
}

function loadLine(trends: Trends): string {
	const load =
		trends.status === 'ok' ? trends.trends.find((t) => t.metric === 'session_load') : undefined;
	if (!load?.change.enoughData)
		return '[note] There are not enough complete weeks yet to say how your training load moved.';
	const { earlier, later, direction } = load.change;
	return `[metric method=${load.changeMethod}] Your weekly training load went from ${amount(earlier!, load.unit)} to ${amount(later!, load.unit)} (${direction}). ${cite(load.sources[0]!)}`;
}

/** What the owner should do next, from the decision on the review's proposal. */
function recommendation(context: MockContext, change: string): string {
	const decision = facts(context).review?.proposal?.decision ?? 'none';
	switch (decision) {
		case 'undecided':
		case 'partly_past':
			return `[recommendation] Look over ${change} your review proposed and decide on them before the first session.`;
		case 'applied':
		case 'accepted_waiting':
			return `[recommendation] You took ${change} your review proposed: train to the updated plan and log each session.`;
		case 'rejected':
			return `[recommendation] You kept your plan rather than ${change} your review proposed: follow it and log each session.`;
		default:
			return '[recommendation] Follow your plan as it stands and log each session as you go.';
	}
}

function weeklyAnswer(context: MockContext): string {
	const summary = context.result('get_weekly_training_summary') as Summary;
	const trends = context.result('get_performance_trends') as Trends;
	return [
		'Here is your week, from your weekly review.',
		...weekLines(summary, 'that week'),
		loadLine(trends),
		recommendation(context, 'the changes for next week')
	].join('\n\n');
}

function cycleAnswer(context: MockContext): string {
	const summary = context.result('get_weekly_training_summary') as Summary;
	const trends = context.result('get_performance_trends') as Trends;
	return [
		'Here is how your block ended, from your cycle review.',
		...weekLines(summary, 'in its last week'),
		loadLine(trends),
		recommendation(context, 'the next block')
	].join('\n\n');
}

const reads = {
	tools: [
		{ name: 'get_weekly_training_summary', input: reviewedWeek },
		{ name: 'get_performance_trends', input: {} }
	]
};

export const reviewScripts: readonly MockScript[] = [
	{
		name: 'weekly-review',
		matches: (_text, context) => context !== undefined && from(context) === 'weekly_review_writeup',
		steps: [reads, { text: weeklyAnswer }]
	},
	{
		name: 'cycle-review',
		matches: (_text, context) => context !== undefined && from(context) === 'cycle_review_writeup',
		steps: [reads, { text: cycleAnswer }]
	},
	{
		name: 'review-propose',
		steps: [
			{
				tools: [
					{
						name: 'propose_program_adjustment',
						input: { title: 'Lighter next week', reason: 'Your review looked heavy.', ops: [] }
					}
				]
			},
			{ text: '[note] Your review already holds the changes for next week; decide on them there.' }
		]
	},
	{
		name: 'review-ungrounded',
		steps: [{ text: `Here is your week.\n\n[fact] ${UNGROUNDED_FACT}` }]
	}
];
