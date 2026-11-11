/**
 * The Coach header and a proposal conversation as the server renders them (svelte/server), which
 * is what paints first; e2e/coach-screen.serial.e2e.ts and e2e/coach-proposals.serial.e2e.ts cover the
 * browser.
 * - The header: the practice coach's badge sits on the eyebrow line, not beside the large title
 *   it ran into; the icon buttons are named 'What it knows' and 'Usage', each with its caption.
 * - A proposal conversation says things once: titled by its proposal, no recommendation block
 *   repeating the card's 'Nothing changes until you accept', the note a footnote under the card.
 */
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { ProposalCardView } from '#lib/domain/coach/cards.ts';
import type { CompletedBlock } from '#lib/domain/coach/index.ts';
import CoachHeader from './CoachHeader.svelte';
import Thread from './Thread.svelte';

vi.mock('$app/state', () => ({
	page: { url: new URL('http://app/coach/t1'), state: {} },
	navigating: { to: null }
}));
vi.mock('$app/navigation', () => ({ pushState: vi.fn(), replaceState: vi.fn() }));

/** The text of an HTML fragment: no tags, no Svelte comments, whitespace collapsed. */
const text = (fragment: string) =>
	fragment
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[^>]+>/g, '')
		.replace(/\s+/g, ' ')
		.trim();

/** The inner HTML of the first element whose opening tag matches `open`, nested ones included. */
function element(html: string, open: RegExp): string {
	const start = html.search(open);
	if (start < 0) throw new Error(`no element matching ${open}`);
	const tag = /^<(\w+)/.exec(html.slice(start))![1]!;
	const tags = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g');
	tags.lastIndex = start;
	let depth = 0;
	for (let m = tags.exec(html); m; m = tags.exec(html)) {
		depth += m[1] ? -1 : 1;
		if (depth === 0) return html.slice(start, m.index + m[0].length);
	}
	throw new Error(`unclosed ${tag}`);
}

describe('CoachHeader', () => {
	const html = render(CoachHeader, { props: { mockBadge: true } }).body;

	it('puts the practice coach’s badge on the eyebrow line, apart from the title', () => {
		const titles = element(html, /<div class="titles/);
		const eyebrowLine = element(titles, /<div class="eyebrow-row/);
		expect(text(eyebrowLine)).toMatch(/^Ask anything Practice coach/);
		expect(eyebrowLine).toContain('data-testid="mock-badge"');
		expect(text(element(html, /<div class="trailing/))).not.toMatch(/Practice coach/);
	});

	it('names the icon buttons ‘What it knows’ and ‘Usage’, each captioned with its name', () => {
		const buttons = [
			...html.matchAll(/<button\b[^>]*aria-label="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)
		];
		expect(buttons.map((b) => b[1])).toEqual(['What it knows', 'Usage']);
		for (const [, name, inner] of buttons)
			expect(inner).toMatch(
				new RegExp(`<span class="tip[^"]*" aria-hidden="true"[^>]*>${name}</span>`)
			);
	});

	it('draws no badge and no eyebrow row for the real coach', () => {
		const real = render(CoachHeader, { props: { mockBadge: false } }).body;
		expect(real).not.toContain('mock-badge');
		expect(real).not.toContain('eyebrow-row');
		expect(real).toContain('<p class="eyebrow');
	});
});

describe('Thread with a proposal', () => {
	const words = (block: number, kind: CompletedBlock['kind'], said: string): CompletedBlock => ({
		block,
		kind,
		method: null,
		ast: [{ type: 'paragraph', children: [{ type: 'text', text: said }] }],
		sources: [],
		grounded: true
	});
	const card: ProposalCardView = {
		id: 'p1',
		kind: 'program_adjustment',
		status: 'proposed',
		title: 'Replace Bulgarian split squat',
		rationale: 'You said you dislike it.',
		rows: [],
		impactLines: [],
		warnings: [],
		appliedVersion: null,
		supersededReason: null
	};
	const question = 'I hate Bulgarian split squats, so replace them';
	const html = render(Thread, {
		props: {
			thread: {
				id: 't1',
				title: question,
				messages: [
					{ id: 'o1', from: 'owner', text: question, clientId: 'c1' },
					{
						id: 'a1',
						from: 'coach',
						blocks: [
							words(0, 'note', 'Noted that you dislike Bulgarian split squats.'),
							words(1, 'recommendation', 'I’ve drafted that change; nothing changes until you do.')
						],
						ended: null,
						retryable: false
					},
					{ id: 'p1', from: 'proposal', card }
				]
			}
		}
	}).body;

	it('is titled by its outcome, the proposal, not the question', () => {
		expect(text(element(html, /<h2 id="thread-title"/))).toBe('Replace Bulgarian split squat');
	});

	it('leaves out the recommendation and its second ‘nothing changes’', () => {
		expect(html).not.toContain('data-testid="answer-block"');
		expect(html).not.toContain('data-testid="coach-message"');
		expect(text(html)).not.toMatch(/Recommendation|drafted that change|nothing changes/i);
	});

	it('shows the note once, as a footnote with the proposal', () => {
		const proposal = element(html, /<li class="coach[^"]*" data-testid="proposal"/);
		expect(text(element(proposal, /<div class="footnote/))).toMatch(
			/^Coach’s note: ?Noted that you dislike Bulgarian split squats\.$/
		);
		expect(text(html).match(/Noted that you dislike/g)).toHaveLength(1);
	});
});
