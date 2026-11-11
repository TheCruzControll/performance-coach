/**
 * The logger's height on a phone (below 1024 px, where it is stuck to the screen's foot), kept on
 * this device so the strength view's first render reserves its space before the logger's chunk
 * arrives: its place and the rest pill above it never move when it does. A layout figure, not
 * account data: sign-out leaves it.
 */

export const LOGGER_SPACE_KEY = 'pc:workout-logger-space:v1';
/** Taller than any logger on any screen: a figure past it is not a logger's. */
export const LOGGER_SPACE_MAX = 1200;

export type LoggerSpaceStorage = Pick<Storage, 'getItem' | 'setItem'>;

const pageStorage = (): LoggerSpaceStorage | null => {
	try {
		return localStorage;
	} catch {
		return null;
	}
};

const valid = (height: number) =>
	Number.isFinite(height) && height > 0 && height <= LOGGER_SPACE_MAX;

/** The height kept, in whole px, or null when none is (or storage is out of reach). */
export function readLoggerSpace(storage = pageStorage()): number | null {
	try {
		const height = Number(storage?.getItem(LOGGER_SPACE_KEY) ?? NaN);
		return valid(height) ? height : null;
	} catch {
		return null;
	}
}

/** Keeps the logger's measured height; one that is no logger's (0 while hidden) is ignored. */
export function keepLoggerSpace(height: number, storage = pageStorage()): void {
	if (!valid(height)) return;
	const rounded = String(Math.round(height));
	try {
		if (storage?.getItem(LOGGER_SPACE_KEY) !== rounded) storage?.setItem(LOGGER_SPACE_KEY, rounded);
	} catch {
		// Full or refused: the next load reserves nothing, as before.
	}
}
