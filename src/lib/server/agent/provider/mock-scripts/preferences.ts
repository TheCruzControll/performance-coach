/**
 * The mock coach's scripts for preferences and goals. Each computes its inputs and its answer from
 * the owner's words and the turn's tool results:
 * - 'I hate Bulgarian split squats' records the dislike of the exercise the owner named, by the
 *   words after the verb, and says whether it was saved or proposed.
 * - 'Which exercises do I avoid?' reads the preferences and lists the dislikes and the movements
 *   injuries rule out, each citing its preference.
 * - 'Make my marathon my top goal' reads the goals and proposes the reorder that puts the goal
 *   whose title names the marathon first.
 */
import type { MockContext, MockScript } from '../mock.ts';

const DISLIKE =
	/\bi\s+(?:really\s+|just\s+)?(?:hate|dislike|detest|loathe|can['’]?t stand)\s+(.+)$/i;
const AVOID = /\b(?:which|what)\b.*\b(?:exercises?|movements?)\b.*\b(?:avoid|dislike|hate|skip)\b/i;
const TOP_GOAL =
	/\bmake\b\s+my\s+(.+?)\s+my\s+(?:top|first|main|number one)\s+(?:goal|priority)\b/i;

interface Wrapped {
	untrusted_text: string;
}
interface Preferences {
	dislikes: { source: { id: string }; exercise: Wrapped }[];
	avoid: { source: { id: string }; movement: Wrapped; reason: string }[];
	goals: { goalId: string; rank: number; title: Wrapped }[];
}

/** Stored text as a ref label: no brackets, pipes or line breaks. */
const label = (text: string) => text.replace(/[[\]|\n]/g, ' ').slice(0, 80);
const named = (context: MockContext) =>
	(DISLIKE.exec(context.ownerText)?.[1] ?? '').replace(/[.!?\s]+$/, '').slice(0, 100);
const preferences = (context: MockContext) =>
	context.result('get_training_preferences') as Preferences;

interface UpdateResult {
	outcome?: string;
	exercise?: { name: string };
}

function dislikeAnswer(context: MockContext): string {
	const result = context.results.findLast((r) => r.name === 'update_exercise_preferences');
	const output = result?.content as UpdateResult | undefined;
	if (!result || result.isError || !output?.exercise)
		return '[note] I couldn’t note that preference, so nothing changed.';
	const name = output.exercise.name;
	return output.outcome === 'recorded'
		? `[note] Noted: you dislike ${name}, so I won’t prescribe it again. You can change this in Profile → Exercises.`
		: `[recommendation] I’ve proposed noting that you dislike ${name}. Accept it on the card if that’s right.`;
}

function avoidAnswer(context: MockContext): string {
	const { dislikes, avoid } = preferences(context);
	if (dislikes.length === 0 && avoid.length === 0)
		return '[note] You haven’t told me about any exercises to avoid.';
	const lines = [
		...dislikes.map(
			(d) =>
				`[fact] You dislike ${d.exercise.untrusted_text} [[preference:${d.source.id}|${label(d.exercise.untrusted_text)}]]`
		),
		...avoid.map(
			(a) =>
				`[fact] Avoid ${a.movement.untrusted_text} because of your ${a.reason} [[preference:${a.source.id}|${label(a.reason)}]]`
		)
	];
	return `Here’s what you’ve asked me to keep out of your training.\n\n${lines.join('\n\n')}`;
}

/** The open goal ids with the one the owner named first; null when none or it is already first. */
function reordered(context: MockContext): string[] | null {
	const wanted = (TOP_GOAL.exec(context.ownerText)?.[1] ?? '').toLowerCase();
	const goals = [...preferences(context).goals].sort((a, b) => a.rank - b.rank);
	const goal = wanted
		? goals.find((g) => g.title.untrusted_text.toLowerCase().includes(wanted))
		: undefined;
	if (!goal || goal.rank === 1) return null;
	return [goal.goalId, ...goals.filter((g) => g !== goal).map((g) => g.goalId)];
}

export const preferenceScripts: readonly MockScript[] = [
	{
		name: 'dislike-exercise',
		matches: (text) => DISLIKE.test(text),
		steps: [
			{
				tools: [
					{
						name: 'update_exercise_preferences',
						input: (context) => ({
							exercise: named(context),
							sentiment: 'dislike',
							title: `No more ${named(context)}`.slice(0, 80),
							rationale: 'You said you dislike it.'
						})
					}
				]
			},
			{ text: dislikeAnswer }
		]
	},
	{
		name: 'exercises-to-avoid',
		matches: (text) => AVOID.test(text),
		steps: [{ tools: [{ name: 'get_training_preferences', input: {} }] }, { text: avoidAnswer }]
	},
	{
		name: 'top-goal',
		matches: (text) => TOP_GOAL.test(text),
		steps: [
			{ tools: [{ name: 'get_training_preferences', input: {} }] },
			{
				tools: [
					{
						name: 'update_training_goals',
						// No goal to move: an empty ranking, which the tool refuses, so nothing is stored.
						input: (context) => ({
							title: 'Put your marathon first',
							rationale: 'You asked to make it your top goal.',
							payload: { ops: [{ op: 'reorder', ids: reordered(context) ?? [] }] }
						})
					}
				]
			},
			{
				text: (context) => {
					const result = context.results.findLast((r) => r.name === 'update_training_goals');
					return result && !result.isError
						? '[recommendation] I’ve proposed making it your top goal. Accept it on the card and your plan will follow.'
						: '[note] That goal is already your top priority, or I couldn’t find it, so nothing changed.';
				}
			}
		]
	}
];
