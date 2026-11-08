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
 * No script calls a tool or states a fact, so the output policy changes none of them, and none
 * names pain or a phrase it holds.
 */
import type { MockScript } from '../mock.ts';

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

export const testScripts: readonly MockScript[] = [
	{ name: 'long-answer', steps: [{ text: LONG_ANSWER }] },
	{
		name: 'refusal',
		steps: [{ refusal: { category: null, explanation: 'Declined by the mock coach' } }]
	},
	{ name: 'slow', steps: [{ text: SLOW_ANSWER, delayMs: SLOW_CHUNK_MS }] },
	{
		name: 'thinking-pause',
		steps: [{ text: THINKING_PAUSE_ANSWER, firstDelayMs: THINKING_PAUSE_MS, chunkChars: 1_000 }]
	}
];
