import { describe, expect, it } from 'vitest';
import { activePath, APP_NAV, isAppPath, isTabRoot, PROFILE, screenName, tabFor } from './nav';

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

describe('the tabs', () => {
	it('are four, and Profile is not one of them', () => {
		expect(APP_NAV.map((tab) => tab.label)).toEqual(['Today', 'Train', 'Progress', 'Coach']);
		expect(PROFILE.href).toBe('/profile');
	});
	it('keep Profile and its sub-screens in the shell, under their own name', () => {
		expect(isAppPath('/profile')).toBe(true);
		expect(isAppPath('/profile/security')).toBe(true);
		expect(screenName('/profile/goals')).toBe('Profile');
		expect(isTabRoot('/profile')).toBe(true);
		expect(tabFor('/profile/security')).toBe(PROFILE);
	});
});
