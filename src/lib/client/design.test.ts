import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DESIGN_ASSET, DESIGN_KEY, savedDesign, setDesign } from './design';

/** The head script in src/app.html: the theme, the leave note and the design, before first paint. */
const HEAD_SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(
	readFileSync(new URL('../../app.html', import.meta.url), 'utf8')
)![1]!;

const STYLESHEET = '/_app/immutable/assets/graphite.D4x_9a-c.css';
const FONT = '/_app/immutable/assets/source-sans-3-latin-wght-normal.Bq3-x1.woff2';

interface FakeLink {
	rel: string;
	as: string;
	type: string;
	crossOrigin: string | null;
	href: string;
	dataset: Record<string, string>;
	attributes: Record<string, string>;
	setAttribute(name: string, value: string): void;
	remove(): void;
}

/** Just enough of a document for the head script: <html>, the asset <meta> and <head>'s links. */
function fakePage({
	search = '',
	meta = { content: STYLESHEET, font: FONT }
}: {
	search?: string;
	meta?: { content: string; font: string };
}) {
	const head: FakeLink[] = [];
	const root = { dataset: {} as Record<string, string> };
	const metaElement = meta && { content: meta.content, dataset: { font: meta.font } };
	const createLink = (): FakeLink => ({
		rel: '',
		as: '',
		type: '',
		crossOrigin: null,
		href: '',
		dataset: {},
		attributes: {},
		setAttribute(name, value) {
			this.attributes[name] = value;
		},
		remove() {
			head.splice(head.indexOf(this), 1);
		}
	});
	const document = {
		documentElement: root,
		head: { append: (...links: FakeLink[]) => head.push(...links) },
		createElement: (tag: string) => {
			if (tag !== 'link') throw new Error(`unexpected <${tag}>`);
			return createLink();
		},
		querySelector: (selector: string) =>
			selector === 'meta[name="pc-graphite"]' ? metaElement : null,
		querySelectorAll: (selector: string) => {
			if (selector !== 'link[data-design]') throw new Error(`unexpected ${selector}`);
			return head.filter((link) => link.dataset.design);
		}
	};
	vi.stubGlobal('document', document);
	vi.stubGlobal('location', { search });
	return { root, head };
}

let stored: Map<string, string>;
let page: { __pcDesign?: (design: string) => void };

function stubStorage(throws = false) {
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => {
			if (throws) throw new Error('SecurityError');
			return stored.get(key) ?? null;
		},
		setItem: (key: string, value: string) => {
			if (throws) throw new Error('SecurityError');
			stored.set(key, value);
		}
	});
}

/** Parse and run the head script, as the browser does before it reads the rest of the page. */
const runHeadScript = () => new Function(HEAD_SCRIPT)();

beforeEach(() => {
	stored = new Map();
	// In a page, window is the global object: the script's window.__pcDesign is design.ts's too.
	page = globalThis as typeof page;
	vi.stubGlobal('window', globalThis);
	vi.stubGlobal('addEventListener', () => {});
	vi.stubGlobal('matchMedia', () => ({ matches: false }));
	stubStorage();
});

afterEach(() => {
	delete page.__pcDesign;
	vi.unstubAllGlobals();
});

describe('the head script in src/app.html', () => {
	it('leaves today’s design alone: no attribute, and not one Graphite file requested', () => {
		const { root, head } = fakePage({});
		runHeadScript();
		expect(root.dataset).toEqual({});
		expect(head).toEqual([]);
		expect(stored.has(DESIGN_KEY)).toBe(false);
	});

	it('applies a saved Graphite before first paint: the attribute, a font preload, a render-blocking stylesheet', () => {
		stored.set(DESIGN_KEY, 'graphite');
		const { root, head } = fakePage({});
		runHeadScript();

		expect(root.dataset).toEqual({ design: 'graphite' });
		expect(head).toHaveLength(2);
		const [font, sheet] = head;
		expect(font).toMatchObject({
			rel: 'preload',
			as: 'font',
			type: 'font/woff2',
			crossOrigin: 'anonymous',
			href: FONT,
			dataset: { design: 'graphite' }
		});
		expect(sheet).toMatchObject({
			rel: 'stylesheet',
			href: STYLESHEET,
			attributes: { blocking: 'render' },
			dataset: { design: 'graphite' }
		});
	});

	it('takes ?design=graphite and ?design=current, and saves each for the next visit', () => {
		const first = fakePage({ search: '?design=graphite' });
		runHeadScript();
		expect(first.root.dataset.design).toBe('graphite');
		expect(stored.get(DESIGN_KEY)).toBe('graphite');

		const second = fakePage({ search: '?tab=x&design=current' });
		runHeadScript();
		expect(second.root.dataset).toEqual({});
		expect(second.head).toEqual([]);
		expect(stored.get(DESIGN_KEY)).toBe('current');
	});

	it('ignores a ?design it does not know, and keeps the saved one', () => {
		stored.set(DESIGN_KEY, 'graphite');
		const { root } = fakePage({ search: '?design=aqua' });
		runHeadScript();
		expect(root.dataset.design).toBe('graphite');
		expect(stored.get(DESIGN_KEY)).toBe('graphite');
	});

	it('still applies ?design=graphite where storage is refused (private mode)', () => {
		stubStorage(true);
		const { root, head } = fakePage({ search: '?design=graphite' });
		runHeadScript();
		expect(root.dataset.design).toBe('graphite');
		expect(head).toHaveLength(2);
	});

	it('requests nothing when the server left the placeholders unfilled', () => {
		stored.set(DESIGN_KEY, 'graphite');
		const { head } = fakePage({
			meta: { content: '%pc.graphite.stylesheet%', font: '%pc.graphite.font%' }
		});
		runHeadScript();
		expect(head).toEqual([]);
	});

	it('leaves __pcDesign behind, which switches while the page is open, without duplicating links', () => {
		const { root, head } = fakePage({});
		runHeadScript();

		page.__pcDesign!('graphite');
		page.__pcDesign!('graphite');
		expect(root.dataset.design).toBe('graphite');
		expect(head.map((link) => link.rel)).toEqual(['preload', 'stylesheet']);

		page.__pcDesign!('current');
		expect(root.dataset).toEqual({});
		expect(head).toEqual([]);
	});
});

describe('the design preference', () => {
	it('reads today’s design unless Graphite was saved, and when storage is refused', () => {
		expect(savedDesign()).toBe('current');
		stored.set(DESIGN_KEY, 'graphite');
		expect(savedDesign()).toBe('graphite');
		stored.set(DESIGN_KEY, 'something-else');
		expect(savedDesign()).toBe('current');
		stubStorage(true);
		expect(savedDesign()).toBe('current');
	});

	it('saves a choice under the key the head script reads, and applies it through the head script', () => {
		const { root, head } = fakePage({});
		runHeadScript();

		setDesign('graphite');
		expect(stored.get(DESIGN_KEY)).toBe('graphite');
		expect(HEAD_SCRIPT).toContain(`'${DESIGN_KEY}'`);
		expect(root.dataset.design).toBe('graphite');
		expect(head).toHaveLength(2);

		setDesign('current');
		expect(stored.get(DESIGN_KEY)).toBe('current');
		expect(root.dataset).toEqual({});
		expect(head).toEqual([]);
	});
});

describe('DESIGN_ASSET', () => {
	it('matches Graphite’s stylesheet and font as the build names them, and nothing of today’s', () => {
		expect(DESIGN_ASSET.test(STYLESHEET)).toBe(true);
		expect(DESIGN_ASSET.test(FONT)).toBe(true);
		for (const path of [
			'/_app/immutable/assets/mona-sans-latin-wght-normal.Bq3-x1.woff2',
			'/_app/immutable/assets/source-sans-3-latin-wght-italic.Bq3-x1.woff2',
			'/_app/immutable/assets/0.Cx81_a.css',
			'/_app/immutable/assets/graphite.svg',
			'/graphite.D4x_9a-c.css'
		]) {
			expect(DESIGN_ASSET.test(path), path).toBe(false);
		}
	});
});
