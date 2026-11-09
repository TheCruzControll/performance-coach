/**
 * The mock coach's scripts for today's workout. Each reads the workout first and computes its
 * inputs from what the tools returned:
 * - 'Can we change today's workout?' reads it, then asks update_workout for more rest on today's
 *   first session that has not started. Its draft ('change-workout-draft', the drafter's request)
 *   waits WORKOUT_DRAFT_DELAY_MS before it answers, longer than a tool's own time, as a real draft
 *   at effort high does.
 * - 'The leg press is taken' finds the named exercise, asks for alternatives with the equipment
 *   unavailable, and proposes the first one for this session.
 * - 'My knee hurts on lunges' finds the exercise and asks for the gentler options for the area,
 *   then answers without a safety block: the output policy appends one naming them.
 */
import { detectPain } from '../../../../domain/coach/safety.ts';
import type { MockContext, MockScript } from '../mock.ts';

/** The draft step's silent start: past toolMs (10 s), well inside a drafting tool's time. */
export const WORKOUT_DRAFT_DELAY_MS = 12_000;

const CHANGE = /\bchange\b.*\btoday['’]?s\b.*\b(workout|session)\b/i;
const TAKEN = /\b(?:is|are|['’]s)\s+(?:taken|busy|broken|in use|occupied|out of order)\b/i;
const HURTS_ON = /\b(?:hurts?|hurting|aches?|aching|painful)\b[^.?!]*\b(?:on|during|doing)\s+\w/i;
const NONE = '00000000-0000-4000-8000-000000000000';

interface Exercise {
	plannedExerciseLineage: string;
	exerciseId: string;
	name: string;
}
interface Session {
	source: { id: string };
	kind: string;
	status: string;
	started: boolean;
	exercises: Exercise[];
}
interface Workout {
	sessions?: Session[];
}
interface Alternatives {
	items?: { exerciseId: string; name: string }[];
	exercise?: { name: string };
}

const sessionsOf = (context: MockContext) =>
	(context.result('get_current_workout') as Workout).sessions ?? [];

/** The exercise the owner names: the most of its name's words in their message, live first. */
function named(context: MockContext): { session: string; exercise: Exercise | null } {
	const said = context.ownerText.toLowerCase();
	const sessions = [...sessionsOf(context)].sort((a, b) => Number(b.started) - Number(a.started));
	let best: { session: string; exercise: Exercise; score: number } | null = null;
	for (const session of sessions)
		for (const exercise of session.exercises) {
			const words = exercise.name.toLowerCase().split(/[^a-z]+/);
			const score = words.filter((w) => w.length > 3 && said.includes(w)).length;
			if (score > (best?.score ?? 0)) best = { session: session.source.id, exercise, score };
		}
	return best ?? { session: sessions[0]?.source.id ?? NONE, exercise: null };
}

const slot = (context: MockContext) => {
	const { session, exercise } = named(context);
	return {
		sessionLineage: session,
		plannedExerciseLineage: exercise?.plannedExerciseLineage ?? NONE
	};
};

/** The drafter's data, as draftRequest writes it after 'Data: '. */
function draftData(context: MockContext) {
	const text = context.ownerText;
	return JSON.parse(text.slice(text.lastIndexOf('Data: ') + 'Data: '.length)) as {
		session: { lineage: string; exercises?: { plannedExerciseLineage: string }[] };
	};
}

const alternativesOf = (context: MockContext) =>
	context.result('get_exercise_alternatives') as Alternatives;

export const workoutScripts: readonly MockScript[] = [
	{
		name: 'change-workout',
		matches: (text) => CHANGE.test(text),
		steps: [
			{ tools: [{ name: 'get_current_workout', input: {} }] },
			{
				tools: [
					{
						name: 'update_workout',
						input: (context) => ({
							sessionLineage:
								sessionsOf(context).find((s) => !s.started && s.status === 'planned')?.source.id ??
								NONE,
							request: 'Keep today’s session but give the first exercise four minutes of rest.'
						})
					}
				]
			},
			{
				text: (context) => {
					const result = context.results.findLast((r) => r.name === 'update_workout');
					return result && !result.isError
						? '[recommendation] I drafted a change to today’s session with more rest. Accept it on the card if it suits you.'
						: '[note] I couldn’t draft a change to today’s session. It may have started already.';
				}
			}
		]
	},
	{
		name: 'change-workout-draft',
		matches: (text) => text.startsWith('Kind: workout_update'),
		steps: [
			{
				firstDelayMs: WORKOUT_DRAFT_DELAY_MS,
				json: (context: MockContext) => {
					const { session } = draftData(context);
					const first = session.exercises?.[0];
					const op = first
						? {
								op: 'adjust_set',
								sessionLineage: session.lineage,
								plannedExerciseLineage: first.plannedExerciseLineage,
								position: 1,
								restSeconds: 240
							}
						: { op: 'skip', sessionLineage: session.lineage, reason: 'A lighter day' };
					return {
						title: 'More rest in today’s session',
						rationale: 'Longer rest keeps the first exercise’s quality up today.',
						payload: { ops: [op] }
					};
				}
			}
		]
	},
	{
		name: 'machine-taken',
		matches: (text) => TAKEN.test(text),
		steps: [
			{ tools: [{ name: 'get_current_workout', input: {} }] },
			{
				tools: [
					{
						name: 'get_exercise_alternatives',
						input: (context) => ({ ...slot(context), reason: 'equipment_unavailable' })
					}
				]
			},
			{
				tools: [
					{
						name: 'substitute_exercise',
						input: (context) => ({
							...slot(context),
							toExerciseId: alternativesOf(context).items?.[0]?.exerciseId ?? NONE,
							reason: 'equipment_unavailable',
							scope: 'session',
							title: 'Swap it for today',
							rationale: 'The equipment is taken; this keeps the session’s purpose without it.'
						})
					}
				]
			},
			{
				text: (context) => {
					const name = alternativesOf(context).items?.[0]?.name;
					return name
						? `[recommendation] Do ${name} instead, for this session only. Accept the card to swap it.`
						: '[note] I couldn’t find an alternative that needs other equipment.';
				}
			}
		]
	},
	{
		name: 'pain-on-exercise',
		matches: (text) => HURTS_ON.test(text) && detectPain(text).reported,
		steps: [
			{ tools: [{ name: 'get_current_workout', input: {} }] },
			{
				tools: [
					{
						name: 'get_exercise_alternatives',
						input: (context) => ({
							...slot(context),
							reason: 'pain',
							area: detectPain(context.ownerText).area ?? 'other'
						})
					}
				]
			},
			{
				text: '[note] Thanks for telling me. [recommendation] Leave that exercise out for the rest of today.'
			}
		]
	}
];
