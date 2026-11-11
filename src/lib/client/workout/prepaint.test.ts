import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
	blockPrepaint,
	clearPrepaint,
	EARLY_ROWS,
	type EarlyRows,
	PREPAINT_KEY,
	PREPAINT_SCRIPT,
	prepaintCard,
	unblockPrepaint,
	writePrepaint,
	type CardWords,
	type PrepaintStorage
} from './prepaint';
import { workoutUrl } from './reconcile';

/** localStorage, as a Map. */
function memoryStorage(entries: Record<string, string> = {}): PrepaintStorage & {
	map: Map<string, string>;
} {
	const map = new Map(Object.entries(entries));
	return {
		map,
		getItem: (key) => map.get(key) ?? null,
		setItem: (key, value) => void map.set(key, String(value)),
		removeItem: (key) => void map.delete(key)
	};
}

/** Storage that refuses everything, as a blocked or full one does. */
const refusing: PrepaintStorage = {
	getItem: () => {
		throw new DOMException('denied', 'SecurityError');
	},
	setItem: () => {
		throw new DOMException('full', 'QuotaExceededError');
	},
	removeItem: () => {
		throw new DOMException('denied', 'SecurityError');
	}
};

/** Just enough of the DOM for the inline script: elements, attributes, text, children. */
class FakeElement {
	readonly attributes = new Map<string, string>();
	readonly children: FakeElement[] = [];
	className = '';
	textContent: string | null = null;
	hidden = true;
	readonly tag: string;
	readonly namespace: string | null;
	constructor(tag: string, namespace: string | null = null) {
		this.tag = tag;
		this.namespace = namespace;
	}
	appendChild(child: FakeElement) {
		this.children.push(child);
		return child;
	}
	setAttribute(name: string, value: unknown) {
		this.attributes.set(name, String(value));
	}
	getAttribute(name: string) {
		return this.attributes.get(name) ?? null;
	}
	/** Every element below, depth first. */
	all(): FakeElement[] {
		return this.children.flatMap((child) => [child, ...child.all()]);
	}
	/** The descendants with class `name` (an element's own or an SVG's class attribute). */
	find(name: string): FakeElement[] {
		return this.all().filter((el) =>
			(el.className || el.getAttribute('class') || '').split(' ').includes(name)
		);
	}
	/** Its text and its descendants', in order. */
	text(): string {
		return (this.textContent ?? '') + this.children.map((child) => child.text()).join('');
	}
}

const SPRITE = '/_app/immutable/assets/sprite.abc.svg';

/** The page's network as the inline script sees it: every GET it starts, never answered. */
function network({ onLine = true }: { onLine?: boolean } = {}) {
	const window: { [EARLY_ROWS]?: EarlyRows } = {};
	const fetch = vi.fn((_url: string, _init: RequestInit) => new Promise<Response>(() => {}));
	return { window, navigator: { onLine }, fetch };
}

/** Runs the inline script as /workout does: its container, this storage, this URL, this network. */
function paint(
	storage: PrepaintStorage,
	{ search = '', net = network() }: { search?: string; net?: ReturnType<typeof network> } = {}
): FakeElement {
	const root = new FakeElement('div');
	root.setAttribute('data-sprite', SPRITE);
	const document = {
		currentScript: { previousElementSibling: root },
		createElement: (tag: string) => new FakeElement(tag),
		createElementNS: (namespace: string, tag: string) => new FakeElement(tag, namespace)
	};
	const run = new Function(
		'document',
		'localStorage',
		'location',
		'window',
		'navigator',
		'fetch',
		PREPAINT_SCRIPT
	);
	run(document, storage, { search }, net.window, net.navigator, net.fetch);
	return root;
}

/** Nothing shown, nothing built. */
function expectNothing(root: FakeElement) {
	expect(root.hidden).toBe(true);
	expect(root.children).toEqual([]);
}

const WORKOUT = '00000000-0000-4000-8000-0000000000a1';

const words: CardWords = {
	name: 'Back squat',
	label: 'A1',
	place: 'Exercise 1 of 5',
	lines: ['Work up to a set of 5 @ RPE 7.5', '3 × 5 @ RPE 6.5'],
	load: { kind: 'weight', text: '≈ 100 kg' },
	loads: [{ kind: 'weight', text: '≈ 100 kg' }, null, { kind: 'instruction', text: 'Heavy' }],
	rest: 'Rest 2:00',
	rests: ['Rest 2:00', null, 'Rest 3:00'],
	previous: { heading: 'Last time · 7 days ago', sets: ['100 kg × 5 reps · RPE 8'] },
	status: { text: 'Swapped for this session', instead: 'Front squat' },
	ended: false,
	rows: [
		{
			setIndex: 1,
			state: 'done',
			text: '100 kg × 5 reps · RPE 8',
			word: 'Done',
			set: { id: 's1' },
			plates: { target: 100 }
		},
		{ setIndex: 2, state: 'current', text: '5 reps · ≈ 100 kg', word: 'Now', plates: false },
		{ setIndex: 3, state: 'not-saved', text: '5 reps', word: 'Not saved on this device' }
	]
};

const write = (storage: PrepaintStorage, card = prepaintCard(words), rest = false) =>
	writePrepaint({ workoutId: WORKOUT, rest, card }, storage);

describe('prepaintCard', () => {
	it('keeps what the card draws: words, which rows edit or weigh, and Options while not ended', () => {
		const card = prepaintCard(words);
		expect(card).toMatchObject({
			label: 'A1',
			name: 'Back squat',
			options: true,
			lines: 'Work up to a set of 5 @ RPE 7.5 · 3 × 5 @ RPE 6.5',
			last: 'Last time · 7 days ago',
			chips: ['100 kg × 5 reps · RPE 8'],
			status: { text: 'Swapped for this session', instead: 'Front squat' }
		});
		expect(card.rows).toEqual([
			{
				index: 1,
				state: 'done',
				text: '100 kg × 5 reps · RPE 8',
				word: 'Done',
				edit: true,
				plates: true
			},
			{
				index: 2,
				state: 'current',
				text: '5 reps · ≈ 100 kg',
				word: 'Now',
				edit: false,
				plates: false
			},
			{
				index: 3,
				state: 'not-saved',
				text: '5 reps',
				word: 'Not saved on this device',
				edit: false,
				plates: false
			}
		]);
		// Nothing of the set itself: only its words.
		expect(JSON.stringify(card)).not.toContain('s1');
	});

	it("says Last time's first-render words without previous sets, and no Options once ended", () => {
		const card = prepaintCard({ ...words, label: undefined, previous: null, ended: true });
		expect(card).toMatchObject({ label: null, last: 'Last time · none yet', chips: null });
		expect(card.options).toBe(false);
	});
});

describe('the inline script', () => {
	it('paints the card the view kept, with its structure and classes, and shows it', () => {
		const storage = memoryStorage();
		write(storage);
		const root = paint(storage);

		expect(root.hidden).toBe(false);
		const [card] = root.children;
		expect(card!.tag).toBe('section');
		expect(card!.className).toBe('card');
		expect(root.find('badge')[0]!.text()).toBe('A1');
		expect(root.find('place')[0]!.text()).toBe('A1Exercise 1 of 5');
		expect(
			root
				.all()
				.find((el) => el.tag === 'h2')!
				.text()
		).toBe('Back squat');
		expect(root.find('lines')[0]!.text()).toBe('Work up to a set of 5 @ RPE 7.5 · 3 × 5 @ RPE 6.5');
		expect(root.find('state')[0]!.text()).toBe('Swapped for this sessionInstead of Front squat');
		expect(root.find('btn')[0]!.text()).toBe('Options');

		// The load and rest over their ghosts, so the card keeps the tallest's room.
		const load = root.find('load');
		expect(load.map((el) => [el.className, el.getAttribute('data-kind'), el.text()])).toEqual([
			['load', 'weight', '≈ 100 kg'],
			['load ghost', 'weight', ''],
			['load ghost', 'instruction', '']
		]);
		expect(load.map((el) => el.getAttribute('data-text'))).toEqual([null, '≈ 100 kg', 'Heavy']);
		expect(root.find('rest').map((el) => el.text() || el.getAttribute('data-text'))).toEqual([
			'Rest 2:00',
			'Rest 2:00',
			'Rest 3:00'
		]);
		expect(
			root
				.all()
				.find((el) => el.tag === 'h3')!
				.text()
		).toBe('Last time · 7 days ago');
		expect(root.find('chips')[0]!.children.map((li) => li.text())).toEqual([
			'100 kg × 5 reps · RPE 8'
		]);

		const rows = root.find('sets')[0]!.children;
		expect(rows.map((li) => [li.getAttribute('data-state'), li.className])).toEqual([
			['done', 'plated'],
			['current', ''],
			['not-saved', '']
		]);
		expect(rows.map((li) => li.children[0]!.className)).toEqual(['set edit', 'set', 'set']);
		expect(rows.map((li) => li.children[0]!.text())).toEqual([
			'1100 kg × 5 reps · RPE 8Done',
			'25 reps · ≈ 100 kgNow',
			'35 repsNot saved on this device'
		]);

		// Icons from the sprite, at the hydrated card's sizes.
		const icons = root.all().filter((el) => el.tag === 'svg');
		expect(
			icons.map((svg) => [svg.children[0]!.getAttribute('href'), svg.getAttribute('width')])
		).toEqual([
			[`${SPRITE}#chevron-right`, '20'],
			[`${SPRITE}#refresh`, '20'],
			[`${SPRITE}#plate`, '22']
		]);
		expect(icons.every((svg) => svg.namespace === 'http://www.w3.org/2000/svg')).toBe(true);
	});

	it('draws the words as text, never as markup', () => {
		const storage = memoryStorage();
		const name = '<img src=x onerror="alert(1)">';
		write(storage, { ...prepaintCard(words), name });
		const root = paint(storage);
		expect(
			root
				.all()
				.find((el) => el.tag === 'h2')!
				.text()
		).toBe(name);
		expect(root.all().some((el) => el.tag === 'img')).toBe(false);
	});

	it('paints nothing without a snapshot, or once it is cleared', () => {
		expectNothing(paint(memoryStorage()));
		const storage = memoryStorage();
		write(storage);
		clearPrepaint(storage);
		expect(storage.map.has(PREPAINT_KEY)).toBe(false);
		expectNothing(paint(storage));
	});

	it('ignores another version, or a snapshot under an older key', () => {
		const storage = memoryStorage();
		write(storage);
		const kept = JSON.parse(storage.map.get(PREPAINT_KEY)!) as Record<string, unknown>;
		expectNothing(paint(memoryStorage({ [PREPAINT_KEY]: JSON.stringify({ ...kept, v: 2 }) })));
		expectNothing(paint(memoryStorage({ 'pc:workout-prepaint:v0': JSON.stringify(kept) })));
	});

	it('ignores anything malformed, all or nothing', () => {
		const storage = memoryStorage();
		write(storage);
		const kept = JSON.parse(storage.map.get(PREPAINT_KEY)!) as {
			card: Record<string, unknown> & { rows: Record<string, unknown>[] };
		};
		const row = kept.card.rows[0]!;
		const broken: unknown[] = [
			'{"v":1,',
			'null',
			'[]',
			{ ...kept, workoutId: 7 },
			{ ...kept, card: null },
			{ ...kept, card: { ...kept.card, name: 42 } },
			{ ...kept, card: { ...kept.card, place: null } },
			{ ...kept, card: { ...kept.card, place: undefined } },
			{ ...kept, card: { ...kept.card, last: undefined } },
			{ ...kept, card: { ...kept.card, lines: ['a', 'b'] } },
			{ ...kept, card: { ...kept.card, loads: 'none' } },
			{ ...kept, card: { ...kept.card, load: { kind: 'bogus', text: 'x' } } },
			{ ...kept, card: { ...kept.card, rests: [3] } },
			{ ...kept, card: { ...kept.card, chips: [{}] } },
			{ ...kept, card: { ...kept.card, rows: {} } },
			{ ...kept, card: { ...kept.card, rows: [...kept.card.rows, { ...row, state: 'gone' }] } },
			{ ...kept, card: { ...kept.card, rows: [...kept.card.rows, { ...row, index: '4' }] } },
			{ ...kept, card: { ...kept.card, rows: [...kept.card.rows, { ...row, word: null }] } }
		];
		for (const value of broken) {
			const raw = typeof value === 'string' ? value : JSON.stringify(value);
			expectNothing(paint(memoryStorage({ [PREPAINT_KEY]: raw })));
		}
	});

	it('paints nothing while a workout starts (?start or ?new)', () => {
		const storage = memoryStorage();
		write(storage);
		expectNothing(paint(storage, { search: '?start=abc' }));
		expectNothing(paint(storage, { search: '?x=1&new=run' }));
		expect(paint(storage, { search: '?restart=1' }).hidden).toBe(false);
	});

	it('marks a card kept with a rest shown, which the page shows below 1024 px only', () => {
		const storage = memoryStorage();
		write(storage, prepaintCard(words), true);
		const resting = paint(storage);
		expect(resting.hidden).toBe(false);
		expect(resting.getAttribute('data-rest')).toBe('');
		write(storage);
		expect(paint(storage).getAttribute('data-rest')).toBeNull();
	});

	it('paints nothing where storage refuses to be read', () => {
		const root = paint(refusing);
		expectNothing(root);
	});

	it("starts the reconcile's GET of the kept workout's rows, and leaves it for the app", () => {
		const storage = memoryStorage();
		write(storage);
		const net = network();
		paint(storage, { net });

		expect(net.fetch).toHaveBeenCalledTimes(1);
		const [url, init] = net.fetch.mock.calls[0]!;
		expect(url).toBe(workoutUrl(WORKOUT));
		expect(init.headers).toEqual({ accept: 'application/json' });
		const early = net.window[EARLY_ROWS]!;
		expect(early.workoutId).toBe(WORKOUT);
		expect(early.response).toBe(net.fetch.mock.results[0]!.value);
		expect(init.signal).toBe(early.controller.signal);
		early.controller.abort();
		expect(init.signal!.aborted).toBe(true);
	});

	it('asks for the path as reconcile.ts does, whatever the id holds', () => {
		const storage = memoryStorage();
		const odd = 'a/b?c#d e';
		writePrepaint({ workoutId: odd, rest: false, card: prepaintCard(words) }, storage);
		const net = network();
		paint(storage, { net });
		expect(net.fetch.mock.calls[0]![0]).toBe(workoutUrl(odd));
	});

	it('starts no GET offline, while a workout starts, signed out, or with no card to paint', () => {
		const kept = memoryStorage();
		write(kept);
		const blocked = memoryStorage();
		write(blocked);
		blockPrepaint(blocked);
		const runs: [PrepaintStorage, { search?: string; onLine?: boolean }][] = [
			[kept, { onLine: false }],
			[kept, { search: '?start=abc' }],
			[kept, { search: '?new=run' }],
			[blocked, {}],
			[memoryStorage(), {}],
			[memoryStorage({ [PREPAINT_KEY]: '{"v":1,"workoutId":7}' }), {}],
			[refusing, {}]
		];
		for (const [storage, { search, onLine }] of runs) {
			const net = network({ onLine });
			paint(storage, { search, net });
			expect(net.fetch).not.toHaveBeenCalled();
			expect(net.window).toEqual({});
		}
		// Kept and online: the card and the GET.
		const net = network();
		expect(paint(kept, { net }).hidden).toBe(false);
		expect(net.fetch).toHaveBeenCalledTimes(1);
	});

	it('paints the card whether the GET fails or cannot start', () => {
		const storage = memoryStorage();
		write(storage);
		const failing = network();
		failing.fetch.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));
		expect(paint(storage, { net: failing }).hidden).toBe(false);
		const throwing = network();
		throwing.fetch.mockImplementation(() => {
			throw new TypeError('Failed to fetch');
		});
		expect(paint(storage, { net: throwing }).hidden).toBe(false);
	});

	it('stays tiny: under 1.5 KB gzipped, in every page load of /workout', () => {
		expect(gzipSync(PREPAINT_SCRIPT).length).toBeLessThan(1536);
	});
});

describe('keeping the snapshot', () => {
	it('writes it under the versioned key, tied to its workout', () => {
		const storage = memoryStorage();
		write(storage);
		expect(JSON.parse(storage.map.get(PREPAINT_KEY)!)).toMatchObject({
			v: 1,
			workoutId: WORKOUT,
			rest: false,
			card: { name: 'Back squat' }
		});
	});

	it('writes nothing while blocked (signed out); a clear keeps the block; unblocking lifts it', () => {
		const storage = memoryStorage();
		write(storage);
		blockPrepaint(storage);
		expectNothing(paint(storage));
		write(storage);
		clearPrepaint(storage);
		expectNothing(paint(storage));
		expect(storage.map.has(PREPAINT_KEY)).toBe(true);

		unblockPrepaint(storage);
		expect(storage.map.has(PREPAINT_KEY)).toBe(false);
		write(storage);
		expect(paint(storage).hidden).toBe(false);
		// Unblocking leaves a snapshot alone.
		unblockPrepaint(storage);
		expect(paint(storage).hidden).toBe(false);
	});

	it('never throws where storage refuses, or there is none', () => {
		for (const storage of [refusing, null]) {
			expect(() => {
				write(storage as PrepaintStorage);
				clearPrepaint(storage);
				blockPrepaint(storage);
				unblockPrepaint(storage);
			}).not.toThrow();
		}
	});
});
