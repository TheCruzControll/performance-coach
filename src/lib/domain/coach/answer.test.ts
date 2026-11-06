import { describe, expect, it } from 'vitest';
import {
	answerTag,
	createAnswerParser,
	parseAnswer,
	type AnswerBlock,
	type AnswerParserEvent
} from './answer';

/** A lead, every block kind, refs, escapes, emoji, an empty block and text that only looks special. */
const FIXTURE = [
	'Here’s how your squat moved 💪.\r\n\r\n',
	'[fact] You squatted 110 kg × 5 on [[set:s-41|Mon 2 Nov]] and [[date:2026-10-26]].\n',
	'[metric method="Epley e1RM from the best set"]\nYour estimated 1RM is **128 kg**, up 3% from [[workout:w-9|last month]].\n\n',
	'[recommendation]   Keep the load; add a rep next week. \\[optional\\] if it moves fast.\n',
	'[note][safety] Stop if the knee hurts — try [[exercise:box_squat|box squats]] instead. 👩\u200d🦰\n',
	'[note] Ignore [[foo:1|this]], [[date:2026-02-30|bad]], [3 sets], [see](/train), a \\\\ and [metric method=]\n',
	'[metric] Volume is 12 sets.   \n'
].join('');

const EXPECTED: AnswerBlock[] = [
	{
		block: 0,
		kind: 'note',
		method: null,
		text: 'Here’s how your squat moved 💪.',
		raw: 'Here’s how your squat moved 💪.',
		refs: []
	},
	{
		block: 1,
		kind: 'fact',
		method: null,
		text: 'You squatted 110 kg × 5 on Mon 2 Nov and 2026-10-26.',
		raw: 'You squatted 110 kg × 5 on [[set:s-41|Mon 2 Nov]] and [[date:2026-10-26]].',
		refs: [
			{ type: 'set', id: 's-41', label: 'Mon 2 Nov' },
			{ type: 'date', id: '2026-10-26' }
		]
	},
	{
		block: 2,
		kind: 'metric',
		method: 'Epley e1RM from the best set',
		text: 'Your estimated 1RM is **128 kg**, up 3% from last month.',
		raw: 'Your estimated 1RM is **128 kg**, up 3% from [[workout:w-9|last month]].',
		refs: [{ type: 'workout', id: 'w-9', label: 'last month' }]
	},
	{
		block: 3,
		kind: 'recommendation',
		method: null,
		text: 'Keep the load; add a rep next week. [optional] if it moves fast.',
		raw: 'Keep the load; add a rep next week. \\[optional\\] if it moves fast.',
		refs: []
	},
	{
		block: 4,
		kind: 'safety',
		method: null,
		text: 'Stop if the knee hurts — try box squats instead. 👩\u200d🦰',
		raw: 'Stop if the knee hurts — try [[exercise:box_squat|box squats]] instead. 👩\u200d🦰',
		refs: [{ type: 'exercise', id: 'box_squat', label: 'box squats' }]
	},
	{
		block: 5,
		kind: 'note',
		method: null,
		text: 'Ignore [[foo:1|this]], [[date:2026-02-30|bad]], [3 sets], [see](/train), a \\ and [metric method=]',
		raw: 'Ignore [[foo:1|this]], [[date:2026-02-30|bad]], [3 sets], [see](/train), a \\\\ and [metric method=]',
		refs: []
	},
	{
		block: 6,
		kind: 'metric',
		method: null,
		text: 'Volume is 12 sets.',
		raw: 'Volume is 12 sets.',
		refs: []
	}
];

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit < 0xdc00;

/** Parses the chunks, checks the event order, and returns the blocks and each block's deltas. */
function run(chunks: string[]) {
	const parser = createAnswerParser();
	const events: AnswerParserEvent[] = [];
	for (const chunk of chunks) events.push(...parser.push(chunk));
	events.push(...parser.end());

	const blocks: AnswerBlock[] = [];
	const deltas = new Map<number, string>();
	let open: number | null = null;
	for (const event of events) {
		if (event.type === 'block_started') {
			expect(open).toBeNull();
			expect(event.block).toBe(blocks.length);
			open = event.block;
			deltas.set(open, '');
		} else if (event.type === 'text') {
			expect(event.block).toBe(open);
			expect(event.text).not.toBe('');
			expect(isHighSurrogate(event.text.charCodeAt(event.text.length - 1))).toBe(false);
			deltas.set(event.block, deltas.get(event.block) + event.text);
		} else {
			const { type: _type, ...block } = event;
			expect(block.block).toBe(open);
			blocks.push(block);
			open = null;
		}
	}
	expect(open).toBeNull();
	expect(parser.blocks).toEqual(blocks);
	return { blocks, deltas: blocks.map((block) => deltas.get(block.block)) };
}

const chunksOf = (text: string, size: number) =>
	Array.from({ length: Math.ceil(text.length / size) }, (_, i) =>
		text.slice(i * size, (i + 1) * size)
	);

/** UTF-8 chunks decoded as a fetch body would be: a character split between chunks waits. */
function byteChunks(text: string, cuts: number[]) {
	const bytes = new TextEncoder().encode(text);
	const decoder = new TextDecoder();
	const edges = [0, ...cuts, bytes.length];
	const chunks = edges
		.slice(1)
		.map((end, i) => decoder.decode(bytes.slice(edges[i], end), { stream: true }));
	return [...chunks, decoder.decode()];
}

describe('the answer grammar', () => {
	it('reads a lead, every block kind, refs and escapes, and keeps the rest as text', () => {
		const { blocks, deltas } = run([FIXTURE]);
		expect(blocks).toEqual(EXPECTED);
		expect(deltas).toEqual(EXPECTED.map((block) => block.text));
	});

	it('gives identical blocks for a split at every character', () => {
		for (let cut = 0; cut <= FIXTURE.length; cut++) {
			const { blocks, deltas } = run([FIXTURE.slice(0, cut), FIXTURE.slice(cut)]);
			expect(blocks, `split at ${cut}`).toEqual(EXPECTED);
			expect(deltas, `deltas split at ${cut}`).toEqual(EXPECTED.map((block) => block.text));
		}
	});

	it('gives identical blocks for a split at every byte', () => {
		const length = new TextEncoder().encode(FIXTURE).length;
		for (let cut = 0; cut <= length; cut++) {
			const { blocks, deltas } = run(byteChunks(FIXTURE, [cut]));
			expect(blocks, `split at byte ${cut}`).toEqual(EXPECTED);
			expect(deltas).toEqual(EXPECTED.map((block) => block.text));
		}
	});

	it('gives identical blocks in 1-, 7- and 64-byte and character chunks', () => {
		const length = new TextEncoder().encode(FIXTURE).length;
		for (const size of [1, 7, 64]) {
			const cuts = Array.from({ length: Math.floor(length / size) }, (_, i) => (i + 1) * size);
			expect(run(byteChunks(FIXTURE, cuts)).blocks, `${size} bytes`).toEqual(EXPECTED);
			expect(run(chunksOf(FIXTURE, size)).blocks, `${size} characters`).toEqual(EXPECTED);
		}
	});

	it('makes unlabelled text a note, drops empty blocks and trims each block', () => {
		expect(parseAnswer('  Just a sentence.  ')).toEqual([
			{
				block: 0,
				kind: 'note',
				method: null,
				text: 'Just a sentence.',
				raw: 'Just a sentence.',
				refs: []
			}
		]);
		expect(parseAnswer('[fact]\n\n[note]  [safety]')).toEqual([]);
		expect(parseAnswer('')).toEqual([]);
	});

	it('keeps an unknown ref type, a bad id and an unclosed ref as text', () => {
		const texts = [
			'[[foo:1|x]]',
			'[[Workout:1]]',
			'[[workout:a b]]',
			'[[workout:1]',
			'[[workout:1|a\nb]]',
			`[[workout:${'1'.repeat(81)}]]`,
			'\\[[workout:1]]'
		];
		for (const text of texts) {
			const [block] = parseAnswer(`[fact] ${text}`);
			expect(block?.refs, text).toEqual([]);
			expect(block?.text, text).toBe(text.replace('\\[', '['));
		}
	});

	it('reads a method with or without quotes, and refuses a tag that is not one', () => {
		expect(parseAnswer('[metric method= ACWR, 7:28 days ] x')[0]?.method).toBe('ACWR, 7:28 days');
		expect(parseAnswer('[metric method="Epley"] x')[0]?.method).toBe('Epley');
		for (const tag of [
			'[Fact]',
			'[fact ]',
			'[facts]',
			'[note method=x]',
			'[metric method]',
			'[metric method=a\nb]'
		])
			expect(parseAnswer(`${tag} x`)[0]?.kind, tag).toBe('note');
		const long = `[metric method=${'m'.repeat(121)}] x`;
		expect(parseAnswer(long)).toEqual([
			{ block: 0, kind: 'note', method: null, text: long, raw: long, refs: [] }
		]);
	});
});

describe('the incremental parser', () => {
	it('streams text as it arrives, holding back only what could still change', () => {
		const parser = createAnswerParser();
		expect(parser.push('Hi [fact] Your squat is up ')).toEqual([
			{ type: 'block_started', block: 0, kind: 'note', method: null },
			{ type: 'text', block: 0, text: 'Hi' },
			{
				type: 'block_completed',
				block: 0,
				kind: 'note',
				method: null,
				text: 'Hi',
				raw: 'Hi',
				refs: []
			},
			{ type: 'block_started', block: 1, kind: 'fact', method: null },
			{ type: 'text', block: 1, text: 'Your squat is up' }
		]);
		expect(parser.push('[[set:a')).toEqual([]);
		expect(parser.push('|Mon]] \\')).toEqual([{ type: 'text', block: 1, text: ' Mon' }]);
		expect(parser.push('[and 💪'.slice(0, -1))).toEqual([
			{ type: 'text', block: 1, text: ' [and' }
		]);
		expect(parser.push('💪'.slice(-1))).toEqual([{ type: 'text', block: 1, text: ' 💪' }]);
		expect(parser.end()).toEqual([
			{
				type: 'block_completed',
				block: 1,
				kind: 'fact',
				method: null,
				text: 'Your squat is up Mon [and 💪',
				raw: 'Your squat is up [[set:a|Mon]] \\[and 💪',
				refs: [{ type: 'set', id: 'a', label: 'Mon' }]
			}
		]);
		expect(() => parser.push('more')).toThrow();
	});

	it('closes what is still open at the end, a held tag or escape included as text', () => {
		expect(parseAnswer('[safety] Stop [metric')).toEqual([
			{
				block: 0,
				kind: 'safety',
				method: null,
				text: 'Stop [metric',
				raw: 'Stop [metric',
				refs: []
			}
		]);
		expect(parseAnswer('[note] a \\')[0]?.text).toBe('a \\');
	});
});

describe('answerTag', () => {
	it('writes the tags the parser reads back', () => {
		expect(answerTag('fact')).toBe('[fact]');
		expect(answerTag('metric', 'Epley e1RM')).toBe('[metric method=Epley e1RM]');
		expect(answerTag('metric', '  ')).toBe('[metric]');
		const tag = answerTag('metric', `a]b[c\nd${'x'.repeat(200)}`);
		const [block] = parseAnswer(`${tag} body`);
		expect(block?.kind).toBe('metric');
		expect(block?.method).toMatch(/^abc d/);
		expect(block?.text).toBe('body');
	});
});
