import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearDeviceAccountData } from './signout';
import { PREPAINT_KEY } from './workout/prepaint';

vi.mock('$app/env', () => ({ version: 'test' }));

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('clearDeviceAccountData', () => {
	it("deletes /workout's prepainted card, blocked or not, and keeps the device's preferences", async () => {
		for (const held of [
			'{"v":1,"workoutId":"w","rest":false,"card":{}}',
			'{"v":1,"blocked":true}'
		]) {
			const map = new Map([
				[PREPAINT_KEY, held],
				['pc:prefs:v1', '{"theme":"light"}']
			]);
			vi.stubGlobal('localStorage', {
				getItem: (key: string) => map.get(key) ?? null,
				setItem: (key: string, value: string) => void map.set(key, value),
				removeItem: (key: string) => void map.delete(key)
			});

			await clearDeviceAccountData();

			expect([...map.keys()]).toEqual(['pc:prefs:v1']);
		}
	});
});
