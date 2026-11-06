/**
 * The coach's stream (POST /api/coach/turns answers text/event-stream): one closed set of events,
 * so the browser never parses markdown or model JSON, only these. The server parses and checks
 * every answer block before it sends it (domain/coach/answer.ts, the output policy).
 *
 * A turn's events arrive in this order: run_started; then, repeated, activity chips and blocks
 * (block_started, text_delta…, block_completed, or block_replaced when the policy changed a
 * block); proposal cards as tools create them; answer_reset if a fallback model took over and
 * the visible answer starts again; answer_completed or error; and always done, last.
 *
 * Events only ever gain optional fields and new types; the decoder skips a type it does not know.
 */
import type { RichNode } from './rich.ts';
import type { SourceRef } from './sources.ts';
import type {
	AnswerBlockKind,
	CoachErrorKind,
	CoachUnavailableReason,
	RunStatus
} from './vocabulary.ts';

export const ACTIVITY_STATES = ['running', 'done', 'failed'] as const;
export type ActivityState = (typeof ACTIVITY_STATES)[number];

/** Why the policy replaced a block: unsafe pain guidance, or a fact it could not check. */
export const BLOCK_REPLACED_REASONS = ['safety', 'ungrounded'] as const;
export type BlockReplacedReason = (typeof BLOCK_REPLACED_REASONS)[number];

/** A finished block: its words as a tree, the sources it cites, and whether they were checked. */
export interface CompletedBlock {
	/** The block's index in the answer, from 0. */
	block: number;
	kind: AnswerBlockKind;
	/** How a metric was calculated; null for every other kind, and for a metric without one. */
	method: string | null;
	ast: RichNode[];
	sources: SourceRef[];
	/** True when every ref and number was found in this turn's tool results or the snapshot. */
	grounded: boolean;
}

export type CoachEvent =
	| { type: 'run_started'; threadId: string; runId: string; messageId: string }
	| { type: 'activity'; id: string; tool: string; state: ActivityState; label: string }
	| { type: 'block_started'; block: number; kind: AnswerBlockKind; method: string | null }
	| { type: 'text_delta'; block: number; text: string }
	| ({ type: 'block_completed' } & CompletedBlock)
	| ({ type: 'block_replaced'; reason: BlockReplacedReason } & CompletedBlock)
	| { type: 'answer_reset'; reason: 'fallback' }
	| { type: 'proposal'; id: string; kind: string; title: string }
	| { type: 'answer_completed'; messageId: string }
	| {
			type: 'error';
			kind: CoachErrorKind;
			reason?: CoachUnavailableReason;
			retryAfterS?: number;
	  }
	| { type: 'done'; status: RunStatus | null };

export type CoachEventType = CoachEvent['type'];

const EVENT_TYPE: Record<CoachEventType, true> = {
	run_started: true,
	activity: true,
	block_started: true,
	text_delta: true,
	block_completed: true,
	block_replaced: true,
	answer_reset: true,
	proposal: true,
	answer_completed: true,
	error: true,
	done: true
};
export const COACH_EVENT_TYPES = Object.keys(EVENT_TYPE) as readonly CoachEventType[];

export function isCoachEventType(value: string): value is CoachEventType {
	return Object.hasOwn(EVENT_TYPE, value);
}

// ---- Server-sent events ---------------------------------------------------------------------

/** No frame, either way, is larger than this. */
export const SSE_MAX_FRAME_BYTES = 64 * 1024;

/** A comment frame the endpoint sends every 15 s so proxies keep the stream open. */
export const SSE_HEARTBEAT = ': heartbeat\n\n';

export class SseProtocolError extends Error {
	override name = 'SseProtocolError';
}

/** The UTF-8 length of `text`, without encoding it (a lone surrogate counts as U+FFFD). */
function utf8Length(text: string): number {
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		const unit = text.charCodeAt(i);
		if (unit < 0x80) bytes += 1;
		else if (unit < 0x800) bytes += 2;
		else if (unit >= 0xd800 && unit < 0xdc00 && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
			bytes += 4;
			i++;
		} else bytes += 3;
	}
	return bytes;
}

/** One frame; `id` is the SSE id a client can name when it comes back for the stored message. */
export function encodeSse(event: CoachEvent, id?: number): string {
	const frame = `${id === undefined ? '' : `id: ${id}\n`}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
	if (utf8Length(frame) > SSE_MAX_FRAME_BYTES)
		throw new RangeError(`A ${event.type} frame is over ${SSE_MAX_FRAME_BYTES} bytes`);
	return frame;
}

export interface SseDecoder {
	/** The events completed by this chunk, in order. */
	push(chunk: string | Uint8Array): CoachEvent[];
	/** Ends the stream; an unterminated last frame is dropped, as the SSE standard says. */
	end(): CoachEvent[];
	/** The last `id:` the stream sent. */
	readonly lastEventId: string | null;
}

/**
 * An incremental SSE parser for the coach's stream, safe across any chunk boundary (bytes split
 * inside a character, a surrogate pair split between strings, CRLF split in two). It skips
 * comments (the heartbeat), frames without data and event types it does not know, and throws
 * SseProtocolError for a frame over `maxFrameBytes` (checked while it is still arriving, so memory
 * stays bounded) or data that is not the JSON of its event.
 */
export function createSseDecoder(maxFrameBytes = SSE_MAX_FRAME_BYTES): SseDecoder {
	const utf8 = new TextDecoder();
	let buffer = ''; // the line still arriving
	let bufferBytes = 0;
	let carry = ''; // a high surrogate that ended a string chunk, held until its pair arrives
	let scanFrom = 0; // where to look for the next line end
	let started = false;
	let frameBytes = 0;
	let eventName = '';
	let data: string[] = [];
	let lastEventId: string | null = null;

	const dispatch = (out: CoachEvent[]) => {
		const name = eventName;
		const payload = data;
		eventName = '';
		data = [];
		frameBytes = 0;
		if (payload.length === 0 || !isCoachEventType(name)) return;
		let event: unknown;
		try {
			event = JSON.parse(payload.join('\n'));
		} catch {
			throw new SseProtocolError(`The ${name} event's data is not JSON`);
		}
		if (typeof event !== 'object' || event === null || (event as { type?: unknown }).type !== name)
			throw new SseProtocolError(`The ${name} event's data is not a ${name} event`);
		out.push(event as CoachEvent);
	};

	const field = (line: string, out: CoachEvent[]) => {
		if (line === '') return dispatch(out);
		if (line.startsWith(':')) return;
		const colon = line.indexOf(':');
		const name = colon < 0 ? line : line.slice(0, colon);
		const raw = colon < 0 ? '' : line.slice(colon + 1);
		const value = raw.startsWith(' ') ? raw.slice(1) : raw;
		if (name === 'data') data.push(value);
		else if (name === 'event') eventName = value;
		else if (name === 'id' && !value.includes('\u0000')) lastEventId = value;
	};

	const feed = (chunk: string, final: boolean): CoachEvent[] => {
		const out: CoachEvent[] = [];
		let text = carry + chunk;
		const last = text.charCodeAt(text.length - 1);
		carry = !final && last >= 0xd800 && last < 0xdc00 ? text.slice(-1) : '';
		if (carry) text = text.slice(0, -1);
		if (!started && text) {
			started = true;
			if (text.startsWith('\ufeff')) text = text.slice(1);
		}
		buffer += text;
		bufferBytes += utf8Length(text);
		let start = 0;
		for (let i = scanFrom; i < buffer.length; i++) {
			const unit = buffer[i];
			if (unit !== '\n' && unit !== '\r') continue;
			if (unit === '\r' && i + 1 === buffer.length && !final) break; // maybe CRLF
			const line = buffer.slice(start, i);
			const lineBytes = utf8Length(line);
			const end = unit === '\r' && buffer[i + 1] === '\n' ? i + 2 : i + 1;
			bufferBytes -= lineBytes + (end - i);
			frameBytes += lineBytes + 1;
			if (frameBytes > maxFrameBytes) throw new SseProtocolError('An SSE frame is over the limit');
			field(line, out);
			start = end;
			i = end - 1;
		}
		buffer = buffer.slice(start);
		scanFrom = buffer.endsWith('\r') && !final ? buffer.length - 1 : buffer.length;
		if (frameBytes + bufferBytes > maxFrameBytes)
			throw new SseProtocolError('An SSE frame is over the limit');
		return out;
	};

	return {
		push: (chunk) =>
			feed(typeof chunk === 'string' ? chunk : utf8.decode(chunk, { stream: true }), false),
		end: () => feed(utf8.decode(), true),
		get lastEventId() {
			return lastEventId;
		}
	};
}
