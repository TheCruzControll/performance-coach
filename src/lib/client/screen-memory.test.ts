import { describe, expect, it } from 'vitest';
import { forgetScreens, ScreenMemory, screens } from './screen-memory.ts';

const at = (path: string) => new URL(path, 'https://coach.test');

describe('ScreenMemory', () => {
	it('recalls the screen kept for the same pathname and query only', () => {
		const memory = new ScreenMemory<string>(5);
		memory.keep(at('/progress?view=strength'), 'strength');
		expect(memory.recall(at('/progress?view=strength'))).toBe('strength');
		expect(memory.recall(at('/progress?view=strength#lifts'))).toBe('strength');
		expect(memory.recall(at('/progress'))).toBeUndefined();
		expect(memory.recall(at('/today'))).toBeUndefined();
	});

	it("keeps one screen per pathname, so a tab's other views never push another tab out", () => {
		const memory = new ScreenMemory<string>(2);
		memory.keep(at('/today'), 'today');
		memory.keep(at('/progress?view=strength'), 'strength');
		memory.keep(at('/progress?period=26w'), '26 weeks');
		expect(memory.recall(at('/today'))).toBe('today');
		expect(memory.recall(at('/progress?period=26w'))).toBe('26 weeks');
		expect(memory.recall(at('/progress?view=strength'))).toBeUndefined();
		expect(memory.size).toBe(2);
	});

	it('replaces the screen kept for a URL with the newer one', () => {
		const memory = new ScreenMemory<string>(5);
		memory.keep(at('/today'), 'morning');
		memory.keep(at('/today'), 'evening');
		expect(memory.recall(at('/today'))).toBe('evening');
		expect(memory.size).toBe(1);
	});

	it('keeps only the most recently kept screens', () => {
		const memory = new ScreenMemory<string>(2);
		memory.keep(at('/today'), 'today');
		memory.keep(at('/train'), 'train');
		memory.keep(at('/today'), 'today again');
		memory.keep(at('/progress'), 'progress');
		expect(memory.recall(at('/train'))).toBeUndefined();
		expect(memory.recall(at('/today'))).toBe('today again');
		expect(memory.recall(at('/progress'))).toBe('progress');
		expect(memory.size).toBe(2);
	});

	it('forgets every screen', () => {
		const memory = new ScreenMemory<string>(5);
		memory.keep(at('/today'), 'today');
		memory.keep(at('/coach'), 'coach');
		memory.forget();
		expect(memory.size).toBe(0);
		expect(memory.recall(at('/today'))).toBeUndefined();
	});

	it("forgetScreens empties the app's memory", () => {
		screens.keep(at('/today'), []);
		forgetScreens();
		expect(screens.size).toBe(0);
	});
});
