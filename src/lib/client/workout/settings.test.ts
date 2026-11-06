import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_REST_SECONDS, restFor } from '#lib/domain/workout/timers.ts';
import {
	DEFAULT_WORKOUT_SETTINGS,
	readWorkoutSettings,
	REST_SETTING_LIMITS,
	WORKOUT_SETTINGS_KEY,
	writeWorkoutSettings
} from './settings';

/** A localStorage over a Map; a second reader over the same entries is the page after a reload. */
function memoryStorage(initial: Record<string, string> = {}) {
	const entries = new Map(Object.entries(initial));
	return {
		entries,
		getItem: (key: string) => entries.get(key) ?? null,
		setItem: (key: string, value: string) => void entries.set(key, value)
	};
}

const holding = (value: unknown) =>
	memoryStorage({ [WORKOUT_SETTINGS_KEY]: JSON.stringify(value) });

const DEFAULTS = {
	rest: { main: 180, compound: 120, isolation: 90, timed: 60 },
	autoStartRest: true,
	sound: true,
	vibration: true,
	keepAwake: true
};

afterEach(() => {
	vi.unstubAllGlobals();
	Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('workout settings: defaults', () => {
	it('starts a device at 3:00, 2:00, 1:30 and 1:00 of rest, with every feedback on', () => {
		expect(readWorkoutSettings(memoryStorage())).toEqual(DEFAULTS);
		expect(DEFAULT_WORKOUT_SETTINGS).toEqual(DEFAULTS);
	});

	it('takes its rest from the timers, so restFor and the settings agree', () => {
		expect(readWorkoutSettings(memoryStorage()).rest).toEqual(DEFAULT_REST_SECONDS);
	});

	it('is kept under pc:workout:v1', () => {
		expect(WORKOUT_SETTINGS_KEY).toBe('pc:workout:v1');
		const storage = memoryStorage();
		writeWorkoutSettings({ sound: false }, storage);
		expect([...storage.entries.keys()]).toEqual(['pc:workout:v1']);
	});

	it('hands out copies, so a screen that changes one never changes the defaults', () => {
		const settings = readWorkoutSettings(memoryStorage());
		(settings.rest as Record<string, number>).main = 10;
		settings.sound = false;
		expect(readWorkoutSettings(memoryStorage())).toEqual(DEFAULTS);
	});
});

describe('workout settings: a reload', () => {
	it('reads back what was written', () => {
		const storage = memoryStorage();
		const { settings, saved } = writeWorkoutSettings(
			{ rest: { isolation: 60 }, autoStartRest: false, keepAwake: false },
			storage
		);
		expect(saved).toBe(true);
		const reloaded = readWorkoutSettings(memoryStorage(Object.fromEntries(storage.entries)));
		expect(reloaded).toEqual(settings);
		expect(reloaded).toEqual({
			...DEFAULTS,
			rest: { ...DEFAULTS.rest, isolation: 60 },
			autoStartRest: false,
			keepAwake: false
		});
	});

	it('changes only what a write names, over what the device already holds', () => {
		const storage = memoryStorage();
		writeWorkoutSettings({ rest: { main: 240 }, sound: false }, storage);
		const { settings } = writeWorkoutSettings({ rest: { timed: 45 } }, storage);
		expect(settings).toEqual({
			...DEFAULTS,
			rest: { ...DEFAULTS.rest, main: 240, timed: 45 },
			sound: false
		});
	});

	it('stores only the settings it knows', () => {
		const storage = holding({ sound: false, theme: 'light', rest: { main: 200, warmup: 30 } });
		writeWorkoutSettings({ vibration: false }, storage);
		expect(JSON.parse(storage.entries.get(WORKOUT_SETTINGS_KEY)!)).toEqual({
			...DEFAULTS,
			rest: { ...DEFAULTS.rest, main: 200 },
			sound: false,
			vibration: false
		});
	});

	it('feeds restFor: a set with no prescribed rest starts the class the owner set', () => {
		const storage = memoryStorage();
		writeWorkoutSettings({ rest: { isolation: 60 } }, storage);
		const { rest } = readWorkoutSettings(storage);
		expect(restFor(null, { restClass: 'isolation' }, rest)).toBe(60_000);
		expect(restFor({ role: 'working', restSeconds: 75 }, { restClass: 'isolation' }, rest)).toBe(
			75_000
		);
	});
});

describe('workout settings: corrupt or partial storage', () => {
	it('falls back to the defaults when the stored value is not JSON or not an object', () => {
		for (const raw of ['{not json', '[]', '"fast"', '42', 'null', 'true', '']) {
			const storage = memoryStorage({ [WORKOUT_SETTINGS_KEY]: raw });
			expect(readWorkoutSettings(storage), raw).toEqual(DEFAULTS);
		}
	});

	it('keeps every valid field of a partial value and defaults the rest', () => {
		expect(readWorkoutSettings(holding({ sound: false }))).toEqual({ ...DEFAULTS, sound: false });
		expect(readWorkoutSettings(holding({ rest: { compound: 150 } }))).toEqual({
			...DEFAULTS,
			rest: { ...DEFAULTS.rest, compound: 150 }
		});
	});

	it('falls back field by field, never the whole value for one bad field', () => {
		const stored = {
			rest: { main: '3:00', compound: 150, isolation: -5, timed: 60.5 },
			autoStartRest: 'no',
			sound: false,
			vibration: 1,
			keepAwake: null
		};
		expect(readWorkoutSettings(holding(stored))).toEqual({
			...DEFAULTS,
			rest: { ...DEFAULTS.rest, compound: 150 },
			sound: false
		});
		expect(readWorkoutSettings(holding({ rest: 'long', keepAwake: false }))).toEqual({
			...DEFAULTS,
			keepAwake: false
		});
	});

	it('keeps the current value, not the default, for a field a write gets wrong', () => {
		const storage = memoryStorage();
		writeWorkoutSettings({ rest: { isolation: 60 }, sound: false }, storage);
		const bad = { rest: { isolation: 5_000, main: Number.NaN }, sound: 'loud' };
		const { settings } = writeWorkoutSettings(bad as never, storage);
		expect(settings).toEqual({
			...DEFAULTS,
			rest: { ...DEFAULTS.rest, isolation: 60 },
			sound: false
		});
		expect(readWorkoutSettings(storage)).toEqual(settings);
	});
});

describe('workout settings: bounds', () => {
	it('allows whole seconds from 0:15 to 15:00, the longest rest a prescription can name', () => {
		expect(REST_SETTING_LIMITS).toEqual({ min: 15, max: 900 });
		expect(readWorkoutSettings(holding({ rest: { main: 900, timed: 15 } })).rest).toEqual({
			...DEFAULTS.rest,
			main: 900,
			timed: 15
		});
	});

	it('refuses anything outside them, a fraction or a value JSON cannot hold', () => {
		for (const seconds of [14, 901, 0, -60, 90.5, Number.POSITIVE_INFINITY, Number.NaN]) {
			const storage = memoryStorage();
			const { settings } = writeWorkoutSettings({ rest: { isolation: seconds } }, storage);
			expect(settings.rest.isolation, String(seconds)).toBe(90);
			expect(readWorkoutSettings(holding({ rest: { isolation: seconds } })).rest.isolation).toBe(
				90
			);
		}
	});
});

describe('workout settings: storage that fails never breaks a screen', () => {
	const throwing = {
		getItem: () => {
			throw new DOMException('The operation is insecure.', 'SecurityError');
		},
		setItem: () => {
			throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
		}
	};

	it('reads the defaults when reading throws', () => {
		expect(readWorkoutSettings(throwing)).toEqual(DEFAULTS);
	});

	it('answers a write it could not keep with the settings and saved: false', () => {
		const storage = { ...memoryStorage(), setItem: throwing.setItem };
		expect(writeWorkoutSettings({ sound: false }, storage)).toEqual({
			settings: { ...DEFAULTS, sound: false },
			saved: false
		});
		expect(readWorkoutSettings(storage)).toEqual(DEFAULTS);
	});

	it('works with no storage at all', () => {
		expect(readWorkoutSettings(null)).toEqual(DEFAULTS);
		expect(writeWorkoutSettings({ sound: false }, null)).toEqual({
			settings: { ...DEFAULTS, sound: false },
			saved: false
		});
	});

	it("uses the page's localStorage by default", () => {
		const storage = memoryStorage();
		vi.stubGlobal('localStorage', storage);
		expect(writeWorkoutSettings({ vibration: false }).saved).toBe(true);
		expect(readWorkoutSettings()).toEqual({ ...DEFAULTS, vibration: false });
		expect(storage.entries.has(WORKOUT_SETTINGS_KEY)).toBe(true);
	});

	it('reads the defaults where there is no localStorage, or touching it throws', () => {
		expect(readWorkoutSettings()).toEqual(DEFAULTS);
		expect(writeWorkoutSettings({ sound: false }).saved).toBe(false);
		Object.defineProperty(globalThis, 'localStorage', {
			configurable: true,
			get() {
				throw new DOMException('The operation is insecure.', 'SecurityError');
			}
		});
		expect(readWorkoutSettings()).toEqual(DEFAULTS);
		expect(writeWorkoutSettings({ sound: false }).saved).toBe(false);
	});
});
