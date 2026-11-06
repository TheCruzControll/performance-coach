import { describe, expect, it } from 'vitest';
import {
	COACH_EVENT_TYPES,
	createSseDecoder,
	encodeSse,
	SSE_HEARTBEAT,
	SSE_MAX_FRAME_BYTES,
	SseProtocolError,
	type CoachEvent,
	type CompletedBlock
} from './events';

const block: CompletedBlock = {
	block: 1,
	kind: 'metric',
	method: 'Epley e1RM from the best set',
	ast: [
		{
			type: 'paragraph',
			children: [
				{ type: 'text', text: 'Your e1RM rose to ' },
				{ type: 'strong', children: [{ type: 'text', text: '112.5 kg' }] },
				{ type: 'ref', ref: { type: 'set', id: 's1', workoutId: 'w1' }, label: 'Mon squat' }
			]
		}
	],
	sources: [{ type: 'set', id: 's1', label: 'Mon squat', date: '2026-11-02', workoutId: 'w1' }],
	grounded: true
};

/** One of every event, with text that stresses JSON and UTF-8: quotes, newlines, emoji. */
const EVENTS: CoachEvent[] = [
	{ type: 'run_started', threadId: 't1', runId: 'r1', messageId: 'm1' },
	{
		type: 'activity',
		id: 'tu_1',
		tool: 'get_exercise_history',
		state: 'running',
		label: 'Looking…'
	},
	{ type: 'block_started', block: 0, kind: 'fact', method: null },
	{ type: 'text_delta', block: 0, text: 'Line one\nline "two" 💪 é\r\n: not a comment' },
	{ ...block, type: 'block_completed' },
	{ ...block, type: 'block_replaced', reason: 'ungrounded', grounded: false },
	{ type: 'answer_reset', reason: 'fallback' },
	{ type: 'proposal', id: 'p1', kind: 'workout_update', title: 'Swap the leg press' },
	{ type: 'answer_completed', messageId: 'm2' },
	{ type: 'error', kind: 'unavailable', reason: 'not_launched' },
	{ type: 'error', kind: 'rate_limited', retryAfterS: 42 },
	{ type: 'done', status: 'completed' },
	{ type: 'done', status: null }
];

const STREAM = EVENTS.map((event, i) => encodeSse(event, i + 1)).join(SSE_HEARTBEAT);

function decodeAll(chunks: (string | Uint8Array)[]) {
	const decoder = createSseDecoder();
	const events = chunks.flatMap((chunk) => decoder.push(chunk));
	return { events: [...events, ...decoder.end()], lastEventId: decoder.lastEventId };
}

describe('the coach event stream', () => {
	it('names every event type once', () => {
		expect(new Set(EVENTS.map((event) => event.type))).toEqual(new Set(COACH_EVENT_TYPES));
	});

	it('round-trips every event, with its id', () => {
		for (const [i, event] of EVENTS.entries()) {
			const frame = encodeSse(event, i);
			expect(frame).toMatch(new RegExp(`^id: ${i}\nevent: ${event.type}\ndata: [^\n]+\n\n$`));
			expect(decodeAll([frame])).toEqual({ events: [event], lastEventId: String(i) });
		}
		expect(decodeAll([encodeSse(EVENTS[0]!)]).lastEventId).toBeNull();
	});

	// Compared as JSON: thousands of decodes, and a string diff still shows where they differ.
	const expected = JSON.stringify(EVENTS);
	const bytes = new TextEncoder().encode(STREAM);

	it('decodes the same events for a split at every character', () => {
		expect(decodeAll([STREAM]).events).toEqual(EVENTS);
		for (let cut = 0; cut <= STREAM.length; cut++) {
			const { events } = decodeAll([STREAM.slice(0, cut), STREAM.slice(cut)]);
			expect(JSON.stringify(events), `split at character ${cut}`).toBe(expected);
		}
	});

	it('decodes the same events for a split at every byte, inside a character included', () => {
		for (let cut = 0; cut <= bytes.length; cut++) {
			const { events } = decodeAll([bytes.slice(0, cut), bytes.slice(cut)]);
			expect(JSON.stringify(events), `split at byte ${cut}`).toBe(expected);
		}
	});

	it('decodes the same events in 1-, 7- and 64-byte chunks', () => {
		for (const size of [1, 7, 64]) {
			const chunks = [];
			for (let at = 0; at < bytes.length; at += size) chunks.push(bytes.slice(at, at + size));
			expect(decodeAll(chunks).events, `${size}-byte chunks`).toEqual(EVENTS);
		}
	});

	it('joins multi-line data and accepts CRLF and CR line ends, even split between chunks', () => {
		const event = { type: 'text_delta', block: 2, text: 'hi' };
		const multi =
			'event: text_delta\ndata: {"type":"text_delta",\ndata:"block":2,\ndata: "text":"hi"}\n\n';
		expect(decodeAll([multi]).events).toEqual([event]);
		const crlf = multi.replaceAll('\n', '\r\n');
		for (let cut = 0; cut <= crlf.length; cut++)
			expect(decodeAll([crlf.slice(0, cut), crlf.slice(cut)]).events, `${cut}`).toEqual([event]);
		expect(decodeAll([multi.replaceAll('\n', '\r')]).events).toEqual([event]);
	});

	it('skips heartbeats, comments, unknown events and frames without data', () => {
		const stream = [
			SSE_HEARTBEAT,
			': anything\n\n',
			'event: thinking_summary\ndata: {"type":"thinking_summary"}\n\n',
			'data: {"type":"done","status":null}\n\n', // no event name: a 'message' event
			'event: done\n\n',
			'retry: 1000\n\n',
			encodeSse({ type: 'done', status: 'completed' })
		].join('');
		expect(decodeAll([stream]).events).toEqual([{ type: 'done', status: 'completed' }]);
	});

	it('drops an unterminated last frame, and strips a byte-order mark', () => {
		const frame = encodeSse({ type: 'answer_reset', reason: 'fallback' });
		expect(decodeAll([frame.slice(0, -1)]).events).toEqual([]);
		expect(decodeAll(['\ufeff' + frame]).events).toEqual([
			{ type: 'answer_reset', reason: 'fallback' }
		]);
	});

	it('refuses data that is not its event', () => {
		expect(() => decodeAll(['event: done\ndata: {nope\n\n'])).toThrow(SseProtocolError);
		expect(() => decodeAll(['event: done\ndata: {"type":"error"}\n\n'])).toThrow(SseProtocolError);
		expect(() => decodeAll(['event: done\ndata: 1\n\n'])).toThrow(SseProtocolError);
	});
});

describe('the 64 KB frame limit', () => {
	const textOf = (frameBytes: number) => {
		const rest = frameBytes - encodeSse({ type: 'text_delta', block: 0, text: '' }).length;
		return 'é'.repeat(Math.floor(rest / 2)) + (rest % 2 ? 'a' : ''); // é is two bytes
	};

	it('accepts a frame of exactly 64 KB and refuses one byte more, both ways', () => {
		const exact = { type: 'text_delta', block: 0, text: textOf(SSE_MAX_FRAME_BYTES) } as const;
		const frame = encodeSse(exact);
		expect(new TextEncoder().encode(frame).length).toBe(SSE_MAX_FRAME_BYTES);
		expect(decodeAll([frame]).events).toEqual([exact]);
		const over = { ...exact, text: exact.text + 'a' };
		expect(() => encodeSse(over)).toThrow(RangeError);
		const raw = frame.replace('"text":"', '"text":"a');
		expect(() => decodeAll([raw])).toThrow(SseProtocolError);
	});

	it('counts a character once when string chunks split its surrogate pair', () => {
		const event = { type: 'text_delta', block: 0, text: '💪💪' } as const;
		const frame = encodeSse(event);
		const decoder = createSseDecoder(new TextEncoder().encode(frame).length);
		const units = frame.repeat(3).split(''); // one UTF-16 unit per chunk
		const events = [...units.flatMap((unit) => decoder.push(unit)), ...decoder.end()];
		expect(events).toEqual([event, event, event]);
	});

	it('refuses an oversize frame while it is still arriving, before its end', () => {
		const decoder = createSseDecoder();
		decoder.push('event: text_delta\ndata: {"type":"text_delta","block":0,"text":"');
		const chunk = 'x'.repeat(1024);
		let pushed = 0;
		expect(() => {
			for (; pushed < 100; pushed++) decoder.push(chunk);
		}).toThrow(SseProtocolError);
		expect(pushed).toBeLessThan(64);
	});
});
