import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubScreens, type SubScreen } from './subscreens.svelte.ts';

// No DOM here: what opened a sub-screen, the scroll and the title to focus are stubbed. Focus
// itself is the e2e's to prove.
beforeEach(() => {
	vi.stubGlobal('HTMLElement', class {});
	vi.stubGlobal('document', { activeElement: null, querySelector: () => null });
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

	it('resets to the section’s own screen', () => {
		const subs = new SubScreens();
		subs.open(injury);
		subs.open(kit);
		subs.reset();
		expect(subs.top).toBeNull();
		expect(subs.stack).toEqual([]);
	});
});
