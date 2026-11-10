/**
 * The mock coach's scripts for programming proposals. Each computes its inputs and its answer from
 * the owner's words and the turn's tool results, and each draft from the drafter's request and
 * data:
 * - 'Move my intervals to Friday' reads this week, picks the planned session whose title the
 *   owner named, and proposes moving it to that weekday of its week (a move op).
 * - 'Build me a program' asks create_training_program for the generator's program, and says
 *   whether it was proposed or a program is already active.
 * - 'Plan my next cycle' drafts the next block's brief from the current one: its last week's
 *   targets, and the first exercise with an alternative rotated out.
 * - 'I hate Bulgarian split squats, replace them' records the dislike, then proposes swapping the
 *   exercise for its best alternative never again (a never_again swap replaces every upcoming
 *   occurrence when accepted).
 */
import type { MockContext, MockScript } from '../mock.ts';

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const MOVE = new RegExp(`\\bmove\\b.*\\bto\\s+(${WEEKDAYS.join('|')})\\b`, 'i');
const BUILD = /\b(?:build|create|make|set up)\b.*\b(?:program|plan)\b/i;
const NEXT_CYCLE = /\bnext\s+(?:cycle|block)\b/i;
const REPLACE =
	/\bi\s+(?:really\s+)?(?:hate|dislike|can['’]?t stand)\s+(.+?)[,;.]?\s+(?:so\s+|please\s+)?replace\b/i;
const NONE = '00000000-0000-4000-8000-000000000000';
const ISO_DATE = /\d{4}-\d{2}-\d{2}/g;

interface Wrapped {
	untrusted_text: string;
}
interface Week {
	week: {
		value: {
			planned: boolean;
			startsOn: string;
			sessions?: { source: { id: string }; date: string; title: Wrapped; status: string }[];
		};
	} | null;
}
interface DraftExercise {
	exerciseId: string;
	name: string;
	alternatives: { exerciseId: string; name: string }[];
}
interface DraftData {
	sessions?: {
		sessionLineage: string;
		exercises?: { plannedExerciseLineage: string; exerciseId: string | null }[];
	}[];
	block?: { fromBlockLineage: string; lastWeekTargets: Record<string, number> | null };
	exercises: DraftExercise[];
}

/** The drafter's request and data, as draftRequest writes them. */
function draftOf(context: MockContext): { request: string; data: DraftData } {
	const text = context.ownerText;
	const at = text.lastIndexOf('\n\nData: ');
	const request = text.slice(text.indexOf('Request: ') + 'Request: '.length, at);
	return { request, data: JSON.parse(text.slice(at + '\n\nData: '.length)) as DraftData };
}

/** The planned session the owner names, by the most of its title's words, and its new day. */
function moveOf(context: MockContext) {
	const value = (context.result('get_current_training_week') as Week).week?.value;
	const said = context.ownerText.toLowerCase();
	const planned = (value?.sessions ?? []).filter((s) => s.status === 'planned');
	const score = (title: string) =>
		title
			.toLowerCase()
			.split(/[^a-z]+/)
			.filter((w) => w.length > 3 && said.includes(w)).length;
	const session = [...planned].sort(
		(a, b) => score(b.title.untrusted_text) - score(a.title.untrusted_text)
	)[0];
	const day = WEEKDAYS.indexOf((MOVE.exec(context.ownerText)?.[1] ?? '').toLowerCase());
	const start = new Date(`${value?.startsOn ?? '2000-01-03'}T00:00:00Z`);
	start.setUTCDate(start.getUTCDate() + Math.max(day, 0));
	return { session, toDate: start.toISOString().slice(0, 10) };
}

const answered = (context: MockContext, tool: string) => {
	const result = context.results.findLast((r) => r.name === tool);
	return result && !result.isError ? (result.content as Record<string, unknown>) : null;
};

const named = (context: MockContext) =>
	(REPLACE.exec(context.ownerText)?.[1] ?? '').replace(/\s+them$/i, '').slice(0, 100);

const PROPOSED =
	'[recommendation] I’ve drafted that change. Accept it on the card if it suits you; nothing changes until you do.';

export const programmingProposalScripts: readonly MockScript[] = [
	{
		name: 'move-session',
		matches: (text) => MOVE.test(text),
		steps: [
			{ tools: [{ name: 'get_current_training_week', input: {} }] },
			{
				tools: [
					{
						name: 'propose_program_adjustment',
						input: (context) => {
							const { session, toDate } = moveOf(context);
							return {
								request: `Move ${session?.title.untrusted_text ?? 'the session'} on ${session?.date ?? 'its day'} to ${toDate}.`,
								sessionLineages: [session?.source.id ?? NONE]
							};
						}
					}
				]
			},
			{
				text: (context) =>
					answered(context, 'propose_program_adjustment')
						? PROPOSED
						: '[note] I couldn’t draft that move, so nothing changed.'
			}
		]
	},
	{
		name: 'replace-the-split-squats',
		matches: (text) => REPLACE.test(text),
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
			{
				tools: [
					{
						name: 'propose_program_adjustment',
						input: (context) => {
							const out = answered(context, 'update_exercise_preferences') as {
								exercise?: { exerciseId: string; name: string };
							} | null;
							const exercise = out?.exercise ?? { exerciseId: NONE, name: named(context) };
							return {
								request: `Replace ${exercise.name} (exercise ${exercise.exerciseId}) with its best alternative, never again: the owner dislikes it.`
							};
						}
					}
				]
			},
			{
				text: (context) =>
					answered(context, 'propose_program_adjustment')
						? `[note] Noted that you dislike ${named(context)}. ${PROPOSED}`
						: '[note] I couldn’t draft a replacement, so your program is unchanged.'
			}
		]
	},
	{
		name: 'program-adjustment-draft',
		matches: (text) => text.startsWith('Kind: program_adjustment'),
		steps: [
			{
				json: (context: MockContext) => {
					const { request, data } = draftOf(context);
					const sessions = data.sessions ?? [];
					const exercise = data.exercises.find((e) => request.includes(e.exerciseId));
					if (exercise) {
						const session = sessions.find((s) =>
							s.exercises?.some((e) => e.exerciseId === exercise.exerciseId)
						);
						const planned = session?.exercises?.find((e) => e.exerciseId === exercise.exerciseId);
						const swap = {
							op: 'swap',
							sessionLineage: session?.sessionLineage ?? NONE,
							plannedExerciseLineage: planned?.plannedExerciseLineage ?? NONE,
							toExerciseId: exercise.alternatives[0]?.exerciseId ?? NONE,
							scope: 'never_again',
							reason: 'The owner dislikes it'
						};
						return {
							title: `Replace ${exercise.name}`.slice(0, 80),
							rationale: `You said you dislike ${exercise.name}; ${exercise.alternatives[0]?.name ?? 'an alternative'} trains the same thing.`,
							payload: { ops: [swap] }
						};
					}
					const toDate = request.match(ISO_DATE)?.at(-1) ?? '2000-01-01';
					const move = { op: 'move', sessionLineage: sessions[0]?.sessionLineage ?? NONE, toDate };
					return {
						title: 'Move a session',
						rationale: 'You asked to move it; the rest of the week stays as planned.',
						payload: { ops: [move] }
					};
				}
			}
		]
	},
	{
		name: 'next-cycle',
		matches: (text) => NEXT_CYCLE.test(text),
		steps: [
			{
				tools: [
					{
						name: 'create_next_training_cycle',
						input: {
							request:
								'Plan the block after this one: keep building strength, rotate one exercise for variety, and end with a deload.'
						}
					}
				]
			},
			{
				text: (context) =>
					answered(context, 'create_next_training_cycle')
						? '[recommendation] I’ve drafted your next cycle. Accepting it keeps it ready for your cycle review; your current program doesn’t change.'
						: '[note] I couldn’t draft the next cycle, so nothing was stored.'
			}
		]
	},
	{
		name: 'next-cycle-draft',
		matches: (text) => text.startsWith('Kind: next_cycle'),
		steps: [
			{
				json: (context: MockContext) => {
					const { data } = draftOf(context);
					const t = data.block?.lastWeekTargets;
					const rotate = data.exercises.find((e) => e.alternatives.length > 0);
					return {
						title: 'Your next cycle',
						rationale: 'It builds on this block’s loads and ends with a lighter week to recover.',
						payload: {
							fromBlockLineage: data.block?.fromBlockLineage ?? NONE,
							focus: 'Keep building strength',
							phase: 'accumulation',
							weeks: 4,
							emphasis: [],
							targets: {
								rpeCap: t?.rpeCap ?? 8,
								volumeFactor: t?.volumeFactor ?? 1,
								loadStep: t?.loadStep ?? 0,
								runVolumeFactor: t?.runVolumeFactor ?? 1
							},
							rotation: rotate
								? [
										{
											fromExerciseId: rotate.exerciseId,
											toExerciseId: rotate.alternatives[0]!.exerciseId
										}
									]
								: [],
							running: null,
							ending: 'deload',
							constraints: []
						}
					};
				}
			}
		]
	},
	{
		name: 'build-program',
		matches: (text) => BUILD.test(text),
		steps: [
			{
				tools: [
					{
						name: 'create_training_program',
						input: {
							rationale:
								'You asked for a program; this is the one the generator builds from your profile.'
						}
					}
				]
			},
			{
				text: (context) => {
					const out = answered(context, 'create_training_program') as {
						preview: { title: Wrapped; plannedWeeks: number };
					} | null;
					return out
						? `[recommendation] Here’s the program your profile gives: ${out.preview.title.untrusted_text}, ${out.preview.plannedWeeks} planned weeks. Accept it on the card to start it.`
						: '[note] I couldn’t propose a new program. You may already have one, or your profile isn’t finished.';
				}
			}
		]
	}
];
