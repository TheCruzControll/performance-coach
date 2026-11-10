/**
 * The 'perf-stream' script the Coach screen's streaming budget plays (e2e/perf-coach.e2e.ts): long
 * enough to be the 3,000-token answer the budget names, and clean, so the output gate releases it
 * sentence by sentence as it arrives. Held text would make the budget measure one burst at the end
 * instead of a stream, and the first-text delay the gate's hold, not the screen.
 */
import { describe, expect, it } from 'vitest';
import { createAnswerParser, parseAnswer } from '../../../../domain/coach/answer.ts';
import type { CoachEvent } from '../../../../domain/coach/events.ts';
import { sentenceBoundaries } from '../../../../domain/coach/sentences.ts';
import { createOutputPolicy } from '../../policy.ts';
import { MOCK_BYTES_PER_TOKEN } from '../mock.ts';
import { MOCK_SCRIPTS } from './index.ts';
import {
	PERF_STREAM_ANSWER,
	PERF_STREAM_CHUNK_CHARS,
	PERF_STREAM_DELAY_MS,
	PERF_STREAM_TOKENS
} from './test.ts';

const script = MOCK_SCRIPTS.find((each) => each.name === 'perf-stream');

/** The answer through the parser and the gate, PERF_STREAM_CHUNK_CHARS at a time. */
function stream() {
	const parser = createAnswerParser();
	const policy = createOutputPolicy({
		painMode: false,
		preamble: { role: 'user', content: 'Memory snapshot\n{}' }
	});
	/** Each wire event with the characters the model had sent when the gate let it out. */
	const sent: { event: CoachEvent; fed: number }[] = [];
	for (let at = 0; at < PERF_STREAM_ANSWER.length; at += PERF_STREAM_CHUNK_CHARS) {
		const fed = Math.min(at + PERF_STREAM_CHUNK_CHARS, PERF_STREAM_ANSWER.length);
		const events = policy.push(parser.push(PERF_STREAM_ANSWER.slice(at, fed)));
		sent.push(...events.map((event) => ({ event, fed })));
	}
	const total = PERF_STREAM_ANSWER.length;
	sent.push(...policy.end().map((event) => ({ event, fed: total })));
	sent.push(...policy.push(parser.end()).map((event) => ({ event, fed: total })));
	return { sent, interventions: policy.interventions };
}

describe("the 'perf-stream' mock script", () => {
	it('is registered and streams the answer in small, paced deltas', () => {
		expect(script?.steps).toEqual([
			{
				text: PERF_STREAM_ANSWER,
				chunkChars: PERF_STREAM_CHUNK_CHARS,
				delayMs: PERF_STREAM_DELAY_MS
			}
		]);
		const deltas = Math.ceil(PERF_STREAM_ANSWER.length / PERF_STREAM_CHUNK_CHARS);
		// Several seconds of streaming, not one burst.
		expect(deltas * PERF_STREAM_DELAY_MS).toBeGreaterThanOrEqual(5_000);
	});

	it(`is at least ${PERF_STREAM_TOKENS} output tokens of labelled blocks`, () => {
		const tokens = Buffer.byteLength(PERF_STREAM_ANSWER) / MOCK_BYTES_PER_TOKEN;
		expect(tokens).toBeGreaterThanOrEqual(PERF_STREAM_TOKENS);
		expect(tokens).toBeLessThan(PERF_STREAM_TOKENS * 1.2);
		const blocks = parseAnswer(PERF_STREAM_ANSWER);
		expect(blocks.length).toBeGreaterThanOrEqual(10);
		expect(new Set(blocks.map((block) => block.kind))).toEqual(new Set(['note', 'recommendation']));
	});

	it('passes the output gate unchanged, its first words released at the first sentence end', () => {
		const { sent, interventions } = stream();
		expect(interventions).toEqual([]);
		expect(sent.filter(({ event }) => event.type === 'block_replaced')).toEqual([]);
		const texts = sent.filter(({ event }) => event.type === 'text_delta');
		const first = texts[0]!;
		const sentenceEnd = sentenceBoundaries(PERF_STREAM_ANSWER)[0]!;
		// The gate waits for a sentence end, then sends it within the next delta or two.
		expect(first.fed).toBeLessThanOrEqual(sentenceEnd + 2 * PERF_STREAM_CHUNK_CHARS);
		// Released all along the answer: every block's words reach the wire before the model ends.
		const blocks = parseAnswer(PERF_STREAM_ANSWER).length;
		const early = new Set(
			texts
				.filter(({ fed }) => fed < PERF_STREAM_ANSWER.length)
				.map(({ event }) => {
					return (event as Extract<CoachEvent, { type: 'text_delta' }>).block;
				})
		);
		expect(early.size).toBe(blocks);
		const wire = texts.map(({ event }) => (event as { text: string }).text).join('');
		expect(wire).toBe(
			parseAnswer(PERF_STREAM_ANSWER)
				.map((block) => block.text)
				.join('')
		);
	});
});
