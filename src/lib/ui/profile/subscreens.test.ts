import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubScreens, type SubScreen } from './subscreens.svelte.ts';

/** A stand-in for an element: whether it is still in the page, and whether it was focused. */
class FakeElement {
	focus = vi.fn();
	isConnected = true;
}

/** The page's elements by selector, and what has the focus. */
let page: { activeElement: FakeElement | null; elements: Record<string, FakeElement> };

// No DOM here: what opened a sub-screen, the elements to focus and the scroll are stubbed. That
// the right element is there to be found is the e2e's to prove.
beforeEach(() => {
	page = { activeElement: null, elements: {} };
	vi.stubGlobal('HTMLElement', FakeElement);
	vi.stubGlobal('CSS', { escape: (id: string) => id.replace(/:/g, '\\:') });
	vi.stubGlobal('document', {
		get activeElement() {
			return page.activeElement;
		},
		querySelector: (selector: string) => page.elements[selector] ?? null
	});
	vi.stubGlobal('window', { scrollTo: vi.fn() });
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const injury: SubScreen = { id: 'injury:a', title: 'Left knee', back: 'Injuries' };
const kit: SubScreen = { id: 'kit', title: 'What’s there?', back: 'Equipment' };

describe('SubScreens', () => {
	it('has none open at first', () => {
		expect(new SubScreens().top).toBeNull();
	});

	it('opens one over another: the last opened is on top', () => {
		const subs = new SubScreens();
		subs.open(injury);
		subs.open(kit);
		expect(subs.top).toEqual(kit);
		expect(subs.stack).toHaveLength(2);
	});

	it('closes the one on top, back to the one under it', () => {
		const subs = new SubScreens();
		subs.open(injury);
		subs.open(kit);
		subs.close();
		expect(subs.top).toEqual(injury);
		expect(subs.stack).toHaveLength(1);
	});

	it('gives the focus back to what opened it, when it is still there', async () => {
		const subs = new SubScreens();
		const opener = (page.activeElement = new FakeElement());
		subs.open(injury);
		page.elements['[data-opens="injury\\:a"]'] = new FakeElement();
		subs.close();
		await tick();
		expect(opener.focus).toHaveBeenCalled();
		expect(page.elements['[data-opens="injury\\:a"]'].focus).not.toHaveBeenCalled();
	});

	it('gives it to what opens the screen once the opener is gone (a row drawn again)', async () => {
		const subs = new SubScreens();
		const opener = (page.activeElement = new FakeElement());
		subs.open(injury);
		opener.isConnected = false;
		const row = (page.elements['[data-opens="injury\\:a"]'] = new FakeElement());
		const fallback = new FakeElement();
		subs.close(() => fallback as unknown as HTMLElement);
		await tick();
		expect(opener.focus).not.toHaveBeenCalled();
		expect(row.focus).toHaveBeenCalled();
		expect(fallback.focus).not.toHaveBeenCalled();
	});

	it('gives it to the fallback when nothing opens the screen any more (removed)', async () => {
		const subs = new SubScreens();
		const opener = (page.activeElement = new FakeElement());
		subs.open(injury);
		opener.isConnected = false;
		const fallback = new FakeElement();
		subs.close(() => fallback as unknown as HTMLElement);
		await tick();
		expect(fallback.focus).toHaveBeenCalled();
	});

	it('closes quietly when there is nothing to focus', async () => {
		const subs = new SubScreens();
		subs.open(injury);
		subs.close();
		await tick();
		expect(subs.top).toBeNull();
	});

	it('resets to the section’s own screen', () => {
		const subs = new SubScreens();
		subs.open(injury);
		subs.open(kit);
		subs.reset();
		expect(subs.top).toBeNull();
		expect(subs.stack).toEqual([]);
	});
});
