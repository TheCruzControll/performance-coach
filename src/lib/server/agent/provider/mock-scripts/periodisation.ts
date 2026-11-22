/**
 * The mock coach's scripts for the engine's periodisation reads (tools-periodisation-reads). Each
 * answer is computed from the turn's tool results, so it states only what the engine returned,
 * every number in a [metric] block with the tool's own method, every finding and decision a
 * [fact] citing its records:
 * - 'Does next week clash?' judges the week (next week when the owner says so, else this one):
 *   its score and grade, its findings with their reasons, and the engine's fix when it has one.
 * - 'Fix next week' judges the week, then proposes the engine's repair exactly as computed, by
 *   passing suggestedRepair.ops to propose_program_adjustment: nothing is drafted.
 * - 'Why is my week shaped like this?' reads the priorities, the decisions behind the week and
 *   the road, quoting each decision's why as stored.
 */
import type { MockContext, MockScript } from '../mock.ts';

const CLASH = /\b(clash|clashes|conflicts?)\b/i;
const REPAIR = /\b(fix|repair)\b.*\b(week|schedule)\b/i;
const SHAPE = /\bwhy\b.*\b(week|schedule)\b.*\b(shaped|laid out|arranged)\b/i;
const NEXT = /\bnext week\b/i;

interface Wrapped {
	untrusted_text: string;
}
interface Ref {
	type: string;
	id: string;
	label?: string;
}
interface Metric {
	value: number;
	unit: string | null;
	method: string;
}
interface EvaluateResult {
	week: { startsOn: string };
	score: Metric;
	grade: 'clear' | 'minor' | 'conflicts';
	findings: { headline: string; why: string; sources: Ref[] }[];
	loads: { label: string; load: Metric }[];
	suggestedRepair: { ops: object[] } | null;
}
interface ExplainResult {
	priorities: { goal: Ref; title: Wrapped; mode: string; weight: Metric }[];
	decisions: { value: { source: Ref; summary: Wrapped; why: Wrapped } }[];
	road: { value: Wrapped; sources: Ref[] } | null;
}

/** The grade in the answer's words. */
const GRADE_WORDS = {
	clear: 'nothing left to act on',
	minor: 'only advice, or trade-offs the plan explains',
	conflicts: 'a clash still ahead that nothing in the plan explains'
};

/** At most this many findings or decisions in one answer. */
const SHOWN = 3;

/** Stored text as an inline ref's label: no brackets, bars or line breaks, 80 characters. */
const label = (text: string) => text.replace(/[[\]|\n]/g, ' ').slice(0, 80);
const cite = (ref: Ref) => `[[${ref.type}:${ref.id}${ref.label ? `|${label(ref.label)}` : ''}]]`;
const weekCite = (monday: string) => cite({ type: 'date', id: monday, label: `Week of ${monday}` });
const weekInput = (context: MockContext) => ({
	week: NEXT.test(context.ownerText) ? 'next' : 'current'
});

function clashAnswer(context: MockContext): string {
	const r = context.result('evaluate_week_interference') as EvaluateResult;
	const which = NEXT.test(context.ownerText) ? 'Next week' : 'This week';
	const lines = [
		`[metric method=${r.score.method}] ${which} scores ${r.score.value} of 100: ${GRADE_WORDS[r.grade]}. ${weekCite(r.week.startsOn)}`,
		...r.findings
			.slice(0, SHOWN)
			.map((f) => `[fact] ${f.headline}. ${f.why} ${f.sources.slice(0, 2).map(cite).join(' ')}`)
	];
	const heaviest = r.loads.toSorted((a, b) => b.load.value - a.load.value)[0];
	if (heaviest)
		lines.push(
			`[metric method=${heaviest.load.method}] ${heaviest.label} carries the most load: ${heaviest.load.value} ${heaviest.load.unit ?? ''}. ${weekCite(r.week.startsOn)}`
		);
	if (r.suggestedRepair)
		lines.push(
			`[recommendation] The scheduling engine can clear this by moving ${r.suggestedRepair.ops.length === 1 ? 'one session' : `${r.suggestedRepair.ops.length} sessions`}. Say the word and I’ll propose it.`
		);
	return lines.join('\n\n');
}

function repairAnswer(context: MockContext): string {
	const done = context.results.find((r) => r.name === 'propose_program_adjustment');
	return done && !done.isError
		? '[note] I’ve proposed the engine’s fix exactly as it computed it. Accept it in your proposals to change the week; nothing changes until you do.'
		: '[note] The engine has nothing to move in that week, so there is nothing to propose.';
}

function shapeAnswer(context: MockContext): string {
	const r = context.result('explain_schedule_tradeoffs') as ExplainResult;
	const lines = [
		...r.priorities.map(
			(p) =>
				`[metric method=${p.weight.method}] ${p.title.untrusted_text} is ${p.mode}, at weight ${p.weight.value}. ${cite({ ...p.goal, label: p.title.untrusted_text })}`
		),
		...r.decisions
			.slice(0, SHOWN)
			.map(
				({ value: d }) =>
					`[fact] “${d.why.untrusted_text}” ${cite({ ...d.source, label: d.summary.untrusted_text })}`
			)
	];
	if (r.road)
		lines.push(`[fact] ${r.road.value.untrusted_text.split('\n')[0]} ${cite(r.road.sources[0]!)}`);
	return lines.length
		? ['Here is what shapes your week.', ...lines].join('\n\n')
		: '[note] Nothing recorded explains this week’s shape yet.';
}

export const periodisationScripts: readonly MockScript[] = [
	{
		name: 'week-repair',
		matches: (text) => REPAIR.test(text),
		steps: [
			{ tools: [{ name: 'evaluate_week_interference', input: weekInput }] },
			{
				tools: [
					{
						name: 'propose_program_adjustment',
						input: (context) => {
							const r = context.result('evaluate_week_interference') as EvaluateResult;
							return {
								request:
									'Move the sessions the scheduling engine suggests, so the week clears its clashes.',
								ops: r.suggestedRepair?.ops ?? []
							};
						}
					}
				]
			},
			{ text: repairAnswer }
		]
	},
	{
		name: 'week-clash',
		matches: (text) => CLASH.test(text),
		steps: [
			{ tools: [{ name: 'evaluate_week_interference', input: weekInput }] },
			{ text: clashAnswer }
		]
	},
	{
		name: 'week-shape',
		matches: (text) => SHAPE.test(text),
		steps: [
			{ tools: [{ name: 'explain_schedule_tradeoffs', input: weekInput }] },
			{ text: shapeAnswer }
		]
	}
];
