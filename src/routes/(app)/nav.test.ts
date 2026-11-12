import { describe, expect, it } from 'vitest';
import { activePath, heldFor, isTabRoot, type Where } from './nav';

const at = (path: string) => new URL(path, 'https://coach.test');
const none = () => undefined;

describe('activePath', () => {
	it("marks the tab a navigation is going to before that tab's data arrives", () => {
		expect(activePath('/today', at('/train'))).toBe('/train');
		expect(activePath('/today', at('/progress/exercises/1'))).toBe('/progress/exercises/1');
	});

	it("keeps the page's own tab without a navigation, or for one leaving the tabs", () => {
		expect(activePath('/today', null)).toBe('/today');
		expect(activePath('/today', undefined)).toBe('/today');
		expect(activePath('/train', at('/workout'))).toBe('/train');
		expect(activePath('/train', at('/'))).toBe('/train');
	});
});

describe('isTabRoot', () => {
	it("is true for a tab's own screen only", () => {
		expect(isTabRoot('/today')).toBe(true);
		expect(isTabRoot('/coach')).toBe(true);
		expect(isTabRoot('/progress/exercises/1')).toBe(false);
		expect(isTabRoot('/offline')).toBe(false);
		expect(isTabRoot('/workout')).toBe(false);
	});
});

describe('heldFor', () => {
	it("shows another tab's skeleton when that tab has no kept screen", () => {
		expect(heldFor(at('/today'), at('/train'), none)).toEqual({ label: 'Train', last: null });
		expect(heldFor(at('/progress/exercises/1'), at('/coach'), none)).toEqual({
			label: 'Coach',
			last: null
		});
	});

	it('shows the last screen a URL showed, from any screen, its own tab included', () => {
		const kept = new Map([['/today', 'today screen']]);
		const recall = (url: Where) => kept.get(url.pathname + url.search);
		expect(heldFor(at('/train'), at('/today'), recall)).toEqual({
			label: 'Today',
			last: 'today screen'
		});
		kept.set('/progress', 'progress screen');
		expect(heldFor(at('/progress/exercises/1'), at('/progress'), recall)).toEqual({
			label: 'Progress',
			last: 'progress screen'
		});
	});

	it('asks the memory for the exact URL it is going to', () => {
		const asked: string[] = [];
		heldFor(at('/today'), at('/progress?view=strength'), (url) => {
			asked.push(`${url.origin}${url.pathname}${url.search}`);
			return undefined;
		});
		expect(asked).toEqual(['https://coach.test/progress?view=strength']);
	});

	it('holds nothing for the same screen, its own tab first shown, or a URL outside the tabs', () => {
		const recall = () => 'kept';
		expect(heldFor(at('/progress'), at('/progress?period=26w'), recall)).toBeNull();
		expect(heldFor(at('/train'), at('/train/session/1'), none)).toBeNull();
		expect(heldFor(at('/progress/exercises/1'), at('/progress'), none)).toBeNull();
		expect(heldFor(at('/train'), at('/workout'), recall)).toBeNull();
		expect(heldFor(at('/today'), at('/offline'), recall)).toBeNull();
		expect(heldFor(at('/today'), at('https://elsewhere.test/train'), recall)).toBeNull();
		expect(heldFor(at('/today'), null, recall)).toBeNull();
	});
});
