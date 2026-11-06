/**
 * This device's workout settings (PRD §8), in localStorage under pc:workout:v1: the rest per rest
 * class when a prescription names none, whether a completed set starts the rest timer, and the
 * tone, the vibration and the screen kept awake during rest.
 *
 * - Like theme and units (preferences.svelte.ts), they are device preferences, not account data,
 *   so sign-out keeps them (docs/security.md, 'Sign-out').
 * - Every field is validated on its own: a corrupt, partial or out-of-bounds value falls back
 *   field by field, so no stored value can break a screen.
 * - Storage that is missing, blocked or full is never an error: reads give the defaults, and a
 *   write answers saved: false.
 * Plain .ts with no runes; `storage` is an argument, so Vitest's unit project runs it.
 */
import { DEFAULT_REST_SECONDS, type RestDefaults } from '#lib/domain/workout/timers.ts';
import type { RestClass } from '#lib/domain/workout/types.ts';

export const WORKOUT_SETTINGS_KEY = 'pc:workout:v1';

export interface WorkoutSettings {
	/** Rest in seconds per rest class, for a set whose prescription names none (restFor). */
	rest: RestDefaults;
	/** Completing a set starts the rest timer. */
	autoStartRest: boolean;
	/** A short tone when a rest is over, where Web Audio is allowed. */
	sound: boolean;
	/** A vibration when a rest is over, where the Vibration API exists. */
	vibration: boolean;
	/** The screen stays on during rest, where the Screen Wake Lock exists. */
	keepAwake: boolean;
}

/** What a write changes; every field it leaves out keeps its current value. */
export type WorkoutSettingsChange = Partial<Omit<WorkoutSettings, 'rest'>> & {
	rest?: Partial<RestDefaults>;
};

/** A rest setting: whole seconds from 0:15 to 15:00, the longest rest a prescription names. */
export const REST_SETTING_LIMITS = { min: 15, max: 900 } as const;

/**
 * What a device starts with, until the owner changes it (owner decisions, the M4 plan's open
 * questions): the rest per class from timers.ts, and the rest starting by itself, the tone, the
 * vibration and keep-awake all on. An iPhone has no vibration and its auto-lock would lock it
 * mid-rest, where a web app cannot sound, so the tone and keep-awake are what alert it; the
 * silent switch still mutes the tone.
 */
export const DEFAULT_WORKOUT_SETTINGS: Readonly<WorkoutSettings> = Object.freeze({
	rest: DEFAULT_REST_SECONDS,
	autoStartRest: true,
	sound: true,
	vibration: true,
	keepAwake: true
});

/** The part of localStorage these settings use. */
export type DeviceStorage = Pick<Storage, 'getItem' | 'setItem'>;

const REST_CLASSES = Object.keys(DEFAULT_REST_SECONDS) as RestClass[];
const TOGGLES = ['autoStartRest', 'sound', 'vibration', 'keepAwake'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const isRestSeconds = (value: unknown): value is number =>
	Number.isInteger(value) &&
	(value as number) >= REST_SETTING_LIMITS.min &&
	(value as number) <= REST_SETTING_LIMITS.max;

/** `base` with every valid field of `input` over it; a field that is not valid keeps the base's. */
function overlay(base: WorkoutSettings, input: unknown): WorkoutSettings {
	const given = isRecord(input) ? input : {};
	const givenRest = isRecord(given.rest) ? given.rest : {};
	const rest = { ...base.rest };
	for (const key of REST_CLASSES) {
		const seconds = givenRest[key];
		if (isRestSeconds(seconds)) rest[key] = seconds;
	}
	const settings: WorkoutSettings = { ...base, rest };
	for (const key of TOGGLES) {
		const on = given[key];
		if (typeof on === 'boolean') settings[key] = on;
	}
	return settings;
}

/** The page's localStorage, or null where there is none or touching it throws (blocked storage). */
function pageStorage(): DeviceStorage | null {
	try {
		return (globalThis as { localStorage?: Storage }).localStorage ?? null;
	} catch {
		return null;
	}
}

function stored(storage: DeviceStorage | null): unknown {
	try {
		return JSON.parse(storage?.getItem(WORKOUT_SETTINGS_KEY) ?? 'null');
	} catch {
		return null;
	}
}

/** The device's settings, every field valid; the defaults for whatever it does not hold. */
export function readWorkoutSettings(
	storage: DeviceStorage | null = pageStorage()
): WorkoutSettings {
	return overlay(DEFAULT_WORKOUT_SETTINGS, stored(storage));
}

/**
 * Applies `change` over the device's settings and keeps the result. A field of `change` that is
 * not valid is ignored. `saved` is false when the browser could not keep it (private mode, a full
 * or blocked storage): the settings still apply to this page.
 */
export function writeWorkoutSettings(
	change: WorkoutSettingsChange,
	storage: DeviceStorage | null = pageStorage()
): { settings: WorkoutSettings; saved: boolean } {
	const settings = overlay(readWorkoutSettings(storage), change);
	try {
		storage?.setItem(WORKOUT_SETTINGS_KEY, JSON.stringify(settings));
		return { settings, saved: storage !== null };
	} catch {
		return { settings, saved: false };
	}
}
