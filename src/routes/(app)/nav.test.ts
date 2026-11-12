import { describe, expect, it } from 'vitest';
import { activePath, isTabRoot } from './nav';

const at = (path: string) => new URL(path, 'https://coach.test');

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
