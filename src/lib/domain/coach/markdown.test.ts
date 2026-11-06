import { describe, expect, it } from 'vitest';
import { createAnswerParser, parseAnswer } from './answer';
import { encodeSse, SSE_MAX_FRAME_BYTES } from './events';
import { parseRich, RICH_LIMITS } from './markdown';
import type { RichBlock, RichInline, RichItem, RichList, RichNode } from './rich';
import { SOURCE_TYPES, sourceAction, type SourceRef, type SourceType } from './sources';

const t = (text: string): RichInline => ({ type: 'text', text });
const em = (...children: RichInline[]): RichInline => ({ type: 'emphasis', children });
const strong = (...children: RichInline[]): RichInline => ({ type: 'strong', children });
const code = (text: string): RichInline => ({ type: 'code', text });
const link = (href: string, ...children: RichInline[]): RichInline => ({
	type: 'link',
	href,
	children
});
const ref = (type: SourceType, id: string, label?: string): RichInline => ({
	type: 'ref',
	ref: label === undefined ? { type, id } : { type, id, label },
	label: label ?? (type === 'date' ? id : '')
});
const p = (...children: RichInline[]): RichBlock => ({ type: 'paragraph', children });
const li = (...children: (RichInline | RichList)[]): RichItem => ({ type: 'item', children });
const ul = (...children: RichItem[]): RichList => ({ type: 'list', ordered: false, children });
const ol = (...children: RichItem[]): RichList => ({ type: 'list', ordered: true, children });

const children = (node: RichNode): readonly RichNode[] => ('children' in node ? node.children : []);
const size = (nodes: readonly RichNode[]): number =>
	nodes.reduce((sum, node) => sum + 1 + size(children(node)), 0);
const depth = (nodes: readonly RichNode[]): number =>
	Math.max(0, ...nodes.map((node) => 1 + depth(children(node))));
/** How deeply emphasis, strong and links sit inside one another. */
const inlineDepth = (nodes: readonly RichNode[]): number =>
	Math.max(
		0,
		...nodes.map((node) => {
			const own = ['emphasis', 'strong', 'link'].includes(node.type) ? 1 : 0;
			return own + inlineDepth(children(node));
		})
	);
const listDepth = (nodes: readonly RichNode[]): number =>
	Math.max(0, ...nodes.map((node) => (node.type === 'list' ? 1 : 0) + listDepth(children(node))));
const refs = (nodes: readonly RichNode[]): SourceRef[] =>
	nodes.flatMap((node) => (node.type === 'ref' ? [node.ref] : refs(children(node))));
const texts = (nodes: readonly RichNode[]): string =>
	nodes
		.map((node) => ('text' in node ? node.text : node.type === 'ref' ? node.label : ''))
		.concat(nodes.map((node) => texts(children(node))))
		.join('');

describe('parseRich: the supported subset', () => {
	it('splits paragraphs at blank lines and keeps a single newline, with each line trimmed', () => {
		expect(
			parseRich('  First line  \nsecond line\n\n \t \nThird.\r\nStill third.\rAnd this.\n\n')
		).toEqual([p(t('First line\nsecond line')), p(t('Third.\nStill third.\nAnd this.'))]);
	});

	it('gives no blocks for empty or blank text', () => {
		expect(parseRich('')).toEqual([]);
		expect(parseRich(' \n\n\t\r\n')).toEqual([]);
	});

	it('reads emphasis and strong with either delimiter', () => {
		expect(parseRich('*one* _two_ **three** __four__, (*five*) and **Squat:** 3×5')).toEqual([
			p(
				em(t('one')),
				t(' '),
				em(t('two')),
				t(' '),
				strong(t('three')),
				t(' '),
				strong(t('four')),
				t(', ('),
				em(t('five')),
				t(') and '),
				strong(t('Squat:')),
				t(' 3×5')
			)
		]);
	});

	it('reads inline code as written, with longer fences and one padding space stripped', () => {
		expect(parseRich('Use `box_squat`, ``a `tick` b``, `` ` `` and `**not bold**`.')).toEqual([
			p(
				t('Use '),
				code('box_squat'),
				t(', '),
				code('a `tick` b'),
				t(', '),
				code('`'),
				t(' and '),
				code('**not bold**'),
				t('.')
			)
		]);
	});

	it('reads bullet and numbered lists, with continuation lines and blank lines between items', () => {
		expect(parseRich('- one\n* two\n+ three')).toEqual([
			ul(li(t('one')), li(t('two')), li(t('three')))
		]);
		expect(parseRich('1. one\n2) two\n7. three')).toEqual([
			ol(li(t('one')), li(t('two')), li(t('three')))
		]);
		expect(parseRich('- one\n  continues here\nand lazily\n\n- two\n\nAfter the list.')).toEqual([
			ul(li(t('one\ncontinues here\nand lazily')), li(t('two'))),
			p(t('After the list.'))
		]);
	});

	it('starts a list straight after a paragraph line, and a new list when the kind changes', () => {
		expect(parseRich('Today:\n1. Squat\n2. Bench')).toEqual([
			p(t('Today:')),
			ol(li(t('Squat')), li(t('Bench')))
		]);
		expect(parseRich('- warm up\n1. work sets')).toEqual([
			ul(li(t('warm up'))),
			ol(li(t('work sets')))
		]);
	});

	it('nests lists by indentation and steps back out', () => {
		const text = [
			'- Squat',
			'  - 3 × 5 at **100 kg**',
			'  - Rest 3 min',
			'  1. Brace',
			'- Bench',
			'    1. Warm up',
			'   2. Work sets',
			'        - Pause the first rep',
			'- Row'
		].join('\n');
		expect(parseRich(text)).toEqual([
			ul(
				li(
					t('Squat'),
					ul(li(t('3 × 5 at '), strong(t('100 kg'))), li(t('Rest 3 min'))),
					ol(li(t('Brace')))
				),
				li(t('Bench'), ol(li(t('Warm up')), li(t('Work sets'), ul(li(t('Pause the first rep')))))),
				li(t('Row'))
			)
		]);
	});

	it('keeps links whose path is exactly one sourceAction builds, for every kind of ref', () => {
		const hrefs = new Set<string>();
		for (const type of SOURCE_TYPES) {
			const action = sourceAction({
				type,
				id: type === 'version' ? '12' : 'id 1',
				workoutId: 'w 7'
			});
			if (action?.kind === 'link') hrefs.add(action.href);
		}
		expect(hrefs.size).toBe(8);
		for (const href of hrefs)
			expect(parseRich(`See [this one](${href}).`)).toEqual([
				p(t('See '), link(href, t('this one')), t('.'))
			]);
	});

	it('nests emphasis, strong, code, links and refs inside one another', () => {
		expect(
			parseRich(
				'**Keep _the load_ and use `2.5 kg` plates** on [**Mon** _squat_](/progress/workouts/w-1), *see [v2](/train/history/2) and **[[set:s-1|set 1]]** now*'
			)
		).toEqual([
			p(
				strong(t('Keep '), em(t('the load')), t(' and use '), code('2.5 kg'), t(' plates')),
				t(' on '),
				link('/progress/workouts/w-1', strong(t('Mon')), t(' '), em(t('squat'))),
				t(', '),
				em(
					t('see '),
					link('/train/history/2', t('v2')),
					t(' and '),
					strong(ref('set', 's-1', 'set 1')),
					t(' now')
				)
			)
		]);
		expect(parseRich('- **Squat** on [[session:abc|Monday]]\n  - *easy* `5 kg`')).toEqual([
			ul(
				li(
					strong(t('Squat')),
					t(' on '),
					ref('session', 'abc', 'Monday'),
					ul(li(em(t('easy')), t(' '), code('5 kg')))
				)
			)
		]);
	});

	it('pairs a run with the nearest open run of the same kind, leaving crossed runs as text', () => {
		expect(parseRich('*a *b* c*')).toEqual([p(em(t('a '), em(t('b')), t(' c')))]);
		expect(parseRich('*a **b* c**')).toEqual([p(em(t('a **b')), t(' c**'))]);
		expect(parseRich('**a *b** c*')).toEqual([p(strong(t('a *b')), t(' c*'))]);
	});

	it('resolves a backslash before ASCII punctuation, and keeps any other backslash', () => {
		expect(parseRich('\\*not em\\* \\[optional\\] \\\\ \\_x\\_ \\q and a trailing \\')).toEqual([
			p(t('*not em* [optional] \\ _x_ \\q and a trailing \\'))
		]);
	});
});

describe('parseRich: refs', () => {
	it('turns each ref into a ref node that shows its label, or a date its day', () => {
		expect(
			parseRich('Squat on [[set:s-41|Mon 2 Nov]], [[date:2026-10-26]] and [[workout:w-9]].')
		).toEqual([
			p(
				t('Squat on '),
				ref('set', 's-41', 'Mon 2 Nov'),
				t(', '),
				ref('date', '2026-10-26'),
				t(' and '),
				ref('workout', 'w-9'),
				t('.')
			)
		]);
	});

	it('reads a ref inside code as its label, and resolves the grammar’s escapes there', () => {
		expect(parseRich('`[[set:s-1|Mon]]` and `\\[x\\]`')).toEqual([
			p(code('Mon'), t(' and '), code('[x]'))
		]);
	});

	it.each([
		'[[foo:1|this]]',
		'[[date:2026-02-30]]',
		'[[set:a b]]',
		'[[set:x|a|b]]',
		'[[set:a]b]]',
		'[3 sets]'
	])('keeps %s, which parseRef does not accept, as written', (text) => {
		expect(parseRich(text)).toEqual([p(t(text))]);
	});
});

describe('parseRich: everything else stays literal', () => {
	it.each([
		'<script>alert("hi")</script>',
		'<img src=x onerror=alert(1)>',
		'<a href="https://evil.example">tap</a>',
		'[tap](javascript:alert(1))',
		'[tap](javascript:void)',
		'[tap](JavaScript:void)',
		'[tap](data:text/html;base64,PHNjcmlwdD4)',
		'[tap](https://evil.example/progress/workouts/w-9)',
		'[tap](//evil.example/progress/workouts/w-9)',
		'[tap](/progress/workouts/w-9?next=//evil.example)',
		'[tap](/progress/workouts/w-9#top)',
		'[tap](/progress/workouts/..)',
		'[tap](/progress/workouts/%2E%2E)',
		'[tap](/progress/workouts/%E0%A4%A)',
		'[tap](/profile/security)',
		'[tap](/train/history/0)',
		'[tap](progress/workouts/w-9)',
		'[tap]( /progress/workouts/w-9 )',
		'[tap](/progress/workouts/w-9 "title")',
		'[](/progress/workouts/w-9)',
		'[ ](/progress/workouts/w-9)',
		'![chart](/progress/workouts/w-9)',
		'<https://evil.example>',
		'https://evil.example/x',
		'&lt;b&gt; &amp; &#x3C;script&#x3E;'
	])('keeps %s as text', (text) => {
		expect(parseRich(text)).toEqual([p(t(text))]);
	});

	it.each([
		'# Heading',
		'> quoted',
		'```js',
		'| a | b |',
		'~~gone~~',
		'---',
		'- - -',
		'* * *',
		'***bold italic***',
		'___x___',
		'snake_case_name',
		'3*5*2 and 2**x**',
		'word*emphasis*',
		'5 * 3 * 2',
		'*not closed',
		'`unclosed',
		'-not a list',
		'1.5 kg plates',
		'+5 kg',
		'3. Squat'
	])('keeps %s as text', (text) => {
		expect(parseRich(text)).toEqual([p(t(text))]);
	});

	it('keeps headings, quotes, fences and tables over several lines as one paragraph of text', () => {
		const text = '# Plan\n> from your coach\n```js\nalert(1)\n```\n| a | b |';
		expect(parseRich(text)).toEqual([p(t(text))]);
	});

	it('keeps a numbered list that does not start at 1 as written, since the tree has no start', () => {
		expect(parseRich('3. Squat\n4. Bench')).toEqual([p(t('3. Squat\n4. Bench'))]);
		expect(parseRich('In\n2026. it moved')).toEqual([p(t('In\n2026. it moved'))]);
		expect(parseRich('- a\n3. b')).toEqual([ul(li(t('a\n3. b')))]);
	});
});

describe('parseRich: bounds', () => {
	it('cuts text over RICH_LIMITS.chars at a space and marks the cut', () => {
		const [block] = parseRich('word '.repeat(2000));
		const text = texts([block!]);
		expect(text.length).toBeLessThanOrEqual(RICH_LIMITS.chars);
		expect(text.length).toBeGreaterThan(RICH_LIMITS.chars - 10);
		expect(text).toMatch(/ word…$/);
		expect('word '.repeat(2000).startsWith(text.slice(0, -1))).toBe(true);
	});

	it('cuts a text with no space mid-word, never through a surrogate pair', () => {
		expect(parseRich('a'.repeat(5000))).toEqual([p(t(`${'a'.repeat(RICH_LIMITS.chars - 1)}…`))]);
		const emoji = texts(parseRich('💪'.repeat(3000)));
		expect(emoji).toMatch(/^(💪)+…$/u);
		expect(emoji.length).toBeLessThanOrEqual(RICH_LIMITS.chars);
	});

	it('parses only the text it keeps: a closer past the cut leaves the opener as text', () => {
		expect(parseRich(`**${'a '.repeat(3000)}**`)).toEqual([
			{
				type: 'paragraph',
				children: [{ type: 'text', text: expect.stringMatching(/^\*\*(a )+a…$/) }]
			}
		]);
	});

	it('nests emphasis, strong and links at most RICH_LIMITS.inlineDepth deep', () => {
		expect(RICH_LIMITS.inlineDepth).toBe(3);
		expect(parseRich('*a __b [c **d**](/train/history/1)__ f*')).toEqual([
			p(em(t('a '), strong(t('b '), link('/train/history/1', t('c **d**'))), t(' f')))
		]);
	});

	it('nests lists at most RICH_LIMITS.listDepth deep; a deeper item continues the item above', () => {
		expect(RICH_LIMITS.listDepth).toBe(3);
		expect(parseRich('- 1\n  - 2\n    - 3\n      - 4\n- back')).toEqual([
			ul(li(t('1'), ul(li(t('2'), ul(li(t('3\n- 4')))))), li(t('back')))
		]);
	});

	it('keeps a code span, link words or a link path over its limit as written', () => {
		const long = (n: number) => 'x'.repeat(n);
		expect(parseRich(`\`${long(RICH_LIMITS.code)}\``)).toEqual([p(code(long(RICH_LIMITS.code)))]);
		expect(parseRich(`\`${long(RICH_LIMITS.code + 1)}\``)).toEqual([
			p(t(`\`${long(RICH_LIMITS.code + 1)}\``))
		]);
		const words = `[${long(RICH_LIMITS.linkText)}](/train/history/1)`;
		expect(parseRich(words)).toEqual([p(link('/train/history/1', t(long(RICH_LIMITS.linkText))))]);
		const over = `[${long(RICH_LIMITS.linkText + 1)}](/train/history/1)`;
		expect(parseRich(over)).toEqual([p(t(over))]);
		const action = sourceAction({ type: 'workout', id: 'é'.repeat(100) });
		const href = action?.kind === 'link' ? action.href : '';
		expect(href.length).toBeGreaterThan(RICH_LIMITS.href);
		const path = `[tap](${href})`;
		expect(parseRich(path)).toEqual([p(t(path))]);
	});

	it('shows a block that would need over RICH_LIMITS.nodes nodes as its plain text', () => {
		const line = (n: number) =>
			Array.from({ length: n }, (_, i) => `**${i}** [[set:s-${i}|set ${i}]]`).join(' ');
		const tree = parseRich(line(120));
		expect(tree).toEqual([
			p(t(Array.from({ length: 120 }, (_, i) => `**${i}** set ${i}`).join(' ')))
		]);
		const structured = parseRich(line(50));
		expect(size(structured)).toBeGreaterThan(200);
		expect(size(structured)).toBeLessThanOrEqual(RICH_LIMITS.nodes);
		expect(refs(structured)).toHaveLength(50);
	});

	it('keeps every tree within its limits and inside one SSE frame, whatever the text', () => {
		const pieces = [
			'*',
			'**',
			'_',
			'__',
			'`',
			'``',
			'[[set:s-1|💪 a label]]',
			'[[date:2026-11-02]]',
			'[x](/train/history/1)',
			'[',
			'](',
			')',
			'\n',
			'\n\n',
			'- ',
			'1. ',
			'  - ',
			'    1. ',
			'"',
			'\\',
			'\u0001',
			'word ',
			'é',
			'<script>',
			'💪',
			' ',
			'~'
		];
		let seed = 0x5eed;
		const random = () => {
			seed = (seed + 0x6d2b79f5) | 0;
			let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
			return ((x ^ (x >>> 14)) >>> 0) / 2 ** 32;
		};
		for (let run = 0; run < 200; run++) {
			let text = '';
			while (text.length < RICH_LIMITS.chars + 500)
				text += pieces[Math.floor(random() * pieces.length)];
			const tree = parseRich(text);
			expect(size(tree)).toBeLessThanOrEqual(RICH_LIMITS.nodes);
			expect(inlineDepth(tree)).toBeLessThanOrEqual(RICH_LIMITS.inlineDepth);
			expect(listDepth(tree)).toBeLessThanOrEqual(RICH_LIMITS.listDepth);
			expect(depth(tree)).toBeLessThanOrEqual(
				2 * RICH_LIMITS.listDepth + RICH_LIMITS.inlineDepth + 1
			);
			expect(texts(tree).length).toBeLessThanOrEqual(RICH_LIMITS.chars);
			const frame = encodeSse({
				type: 'block_completed',
				block: 0,
				kind: 'note',
				method: null,
				ast: tree,
				sources: refs(tree),
				grounded: true
			});
			expect(new TextEncoder().encode(frame).length).toBeLessThan(SSE_MAX_FRAME_BYTES);
			expect(parseRich(text)).toEqual(tree);
		}
	});
});

describe('parseRich: determinism', () => {
	const ANSWER =
		'[metric method="Epley"] Your e1RM is **128 kg**, up from [[workout:w-9|last month]].\n' +
		'[recommendation]\n- Keep the load\n- Add a rep on [[session:abc|Monday]] 💪\n';
	const TREES = [
		[
			p(
				t('Your e1RM is '),
				strong(t('128 kg')),
				t(', up from '),
				ref('workout', 'w-9', 'last month'),
				t('.')
			)
		],
		[ul(li(t('Keep the load')), li(t('Add a rep on '), ref('session', 'abc', 'Monday'), t(' 💪')))]
	];

	it('gives equal, separately built trees for equal text', () => {
		const text = ANSWER.replace(/\[(metric[^\]]*|recommendation)\]/g, '');
		const first = parseRich(text);
		const second = parseRich(text);
		expect(second).toEqual(first);
		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
		expect(second[0]).not.toBe(first[0]);
	});

	it('gives the same tree for an answer block however the answer streamed', () => {
		expect(parseAnswer(ANSWER).map((block) => parseRich(block.raw))).toEqual(TREES);
		for (const chunk of [1, 7, 64]) {
			const parser = createAnswerParser();
			for (let at = 0; at < ANSWER.length; at += chunk) parser.push(ANSWER.slice(at, at + chunk));
			parser.end();
			expect(parser.blocks.map((block) => parseRich(block.raw))).toEqual(TREES);
		}
	});
});
