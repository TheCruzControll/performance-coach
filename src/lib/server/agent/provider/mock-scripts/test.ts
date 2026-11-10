/**
 * The mock coach's scripts for the coach's states in the browser. None matches an owner's message:
 * each plays only when the test route forces it (POST /api/test-support/coach {script}, or the
 * 'refusal' and 'slow' faults), whatever the owner asks.
 * - 'long-answer': a lead and six labelled blocks, about 2,000 characters, for the long answer's
 *   collapse and its scrolling.
 * - 'refusal': the model declines (stop_reason refusal), so the turn ends refused.
 * - 'slow': a short answer streamed SLOW_CHUNK_MS apart, about 5 s in all: long enough to press
 *   Stop, leave mid-answer or run past a shortened turn.
 * - 'thinking-pause': nothing for THINKING_PAUSE_MS, then the whole answer at once, so 'Thinking…'
 *   shows and then gives way to text.
 * - 'many-blocks': MANY_BLOCKS short notes, more than an answer shows before 'Show all'.
 * - 'exercise-source': reads the bench's history, then points to the exercise it returned, so a
 *   streamed answer carries an exercise source (its history sheet).
 * - 'perf-stream': PERF_STREAM_TOKENS of clean labelled blocks (paragraphs, emphasis and lists),
 *   streamed a little faster than a real model, for the Coach screen's main-thread budget while an
 *   answer streams (e2e/perf-coach.e2e.ts).
 * Only 'exercise-source' calls a tool, and it cites only what the tool returned; none states a
 * fact, so the output policy changes none of them, and none names pain or a phrase it holds.
 */
import type { MockContext, MockScript } from '../mock.ts';

/** The wait before each chunk of the 'slow' answer. */
export const SLOW_CHUNK_MS = 250;
/** The silence before the 'thinking-pause' answer starts. */
export const THINKING_PAUSE_MS = 2_000;

const paragraph = (topic: string) =>
	`${topic} matters for the next block. Keep each session honest, log every set as you do it, and judge progress across weeks rather than single days. Small, steady changes compound into a better month.`;

export const LONG_ANSWER = [
	'Here is the whole picture, one part at a time.',
	`[note] ${paragraph('Sleep')}`,
	`[recommendation] ${paragraph('Warming up')}`,
	`[note] ${paragraph('Rest between sets')}`,
	`[recommendation] ${paragraph('Your easy runs')}`,
	`[note] ${paragraph('Technique work')}`,
	`[recommendation] ${paragraph('A planned lighter week')}`
].join('\n\n');

/** 19 chunks of 16 characters. */
export const SLOW_ANSWER =
	'[note] Your week is on track so far. Two sessions are done and the next one is planned for tomorrow morning. Keep the easy run easy, eat well tonight and get to bed on time, and the heavier session later in the week will feel a lot better for it.';

export const THINKING_PAUSE_ANSWER =
	'[note] I looked at your week before answering. Everything planned so far is done.';

/** More than ANSWER_BLOCKS_SHOWN (ui/coach/answer-words.ts), so the answer collapses. */
export const MANY_BLOCKS = 14;

export const MANY_BLOCKS_ANSWER = Array.from(
	{ length: MANY_BLOCKS },
	(_, i) => `[note] Part ${i + 1} of the plan: keep it steady and log every set.`
).join('\n\n');

/** At least this many output tokens (MOCK_BYTES_PER_TOKEN) in the 'perf-stream' answer. */
export const PERF_STREAM_TOKENS = 3_000;
/** Characters per 'perf-stream' delta: about ten tokens. */
export const PERF_STREAM_CHUNK_CHARS = 40;
/**
 * The wait before each 'perf-stream' delta: about 300 tokens a second, faster than the coach's
 * model streams, so the screen does at least a real answer's work per second (about 10 s in all).
 */
export const PERF_STREAM_DELAY_MS = 33;

const PERF_TOPICS = [
	'Sleep',
	'Warming up',
	'Rest between sets',
	'Your easy runs',
	'Technique work',
	'A planned lighter week',
	'Eating around sessions',
	'Your long run',
	'Mobility',
	'Tracking your sessions'
] as const;

/** One block of the 'perf-stream' answer: two paragraphs around a five-item list. */
const perfBlock = (topic: string, index: number) =>
	[
		`[${index % 2 === 0 ? 'note' : 'recommendation'}] **${topic}** matters for the next block. ${paragraph(topic)} Treat it as part of training, not as something extra, and give it the same care.`,
		[
			`- Keep *${topic.toLowerCase()}* simple and repeatable.`,
			'- Write down what you did, while you still remember it.',
			'- Change one thing at a time, then give it two weeks.',
			'- Look back across the month, not at a single day.',
			'- Ask me when something feels off, before it becomes a habit.'
		].join('\n'),
		`${paragraph(topic)} When a week goes sideways, pick up where you left off without trying to make up for the missed work. ${paragraph(topic)} Rest days belong to the plan as much as the sessions do, and they count.`
	].join('\n\n');

export const PERF_STREAM_ANSWER = [
	'Here is a long look at your training, one part at a time.',
	...PERF_TOPICS.map(perfBlock)
].join('\n\n');

/** The exercise the bench's history named, cited as its own source. */
function exerciseSource(context: MockContext): string {
	const { exercise } = context.result('get_exercise_history') as {
		exercise?: { source: { type: string; id: string } };
	};
	if (!exercise) return '[note] I couldn’t find your bench press in your library.';
	const { type, id } = exercise.source;
	return `[note] Your full bench history is one tap away [[${type}:${id}|Bench press]].`;
}

export const testScripts: readonly MockScript[] = [
	{ name: 'long-answer', steps: [{ text: LONG_ANSWER }] },
	{
		name: 'refusal',
		steps: [{ refusal: { category: null, explanation: 'Declined by the mock coach' } }]
	},
	{ name: 'slow', steps: [{ text: SLOW_ANSWER, delayMs: SLOW_CHUNK_MS }] },
	{ name: 'many-blocks', steps: [{ text: MANY_BLOCKS_ANSWER }] },
	{
		name: 'exercise-source',
		steps: [
			{ tools: [{ name: 'get_exercise_history', input: { exercise: 'bench' } }] },
			{ text: exerciseSource }
		]
	},
	{
		name: 'perf-stream',
		steps: [
			{
				text: PERF_STREAM_ANSWER,
				chunkChars: PERF_STREAM_CHUNK_CHARS,
				delayMs: PERF_STREAM_DELAY_MS
			}
		]
	},
	{
		name: 'thinking-pause',
		steps: [{ text: THINKING_PAUSE_ANSWER, firstDelayMs: THINKING_PAUSE_MS, chunkChars: 1_000 }]
	}
];
