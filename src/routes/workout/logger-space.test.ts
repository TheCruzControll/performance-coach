import { describe, expect, it } from 'vitest';
import {
	keepLoggerSpace,
	LOGGER_SPACE_KEY,
	LOGGER_SPACE_MAX,
	readLoggerSpace,
	type LoggerSpaceStorage
} from './logger-space.ts';

function memory(initial: Record<string, string> = {}) {
	const items = new Map(Object.entries(initial));
	let writes = 0;
	const storage: LoggerSpaceStorage = {
		getItem: (key) => items.get(key) ?? null,
		setItem: (key, value) => {
			writes++;
			items.set(key, value);
		}
	};
	return { storage, items, writes: () => writes };
}

describe('the logger space kept on the device', () => {
	it('keeps the measured height in whole px and reads it back', () => {
		const { storage, items } = memory();
		expect(readLoggerSpace(storage)).toBeNull();
		keepLoggerSpace(318.4, storage);
		expect(items.get(LOGGER_SPACE_KEY)).toBe('318');
		expect(readLoggerSpace(storage)).toBe(318);
	});

	it('writes only a change', () => {
		const { storage, writes } = memory();
		keepLoggerSpace(318, storage);
		keepLoggerSpace(318.2, storage);
		expect(writes()).toBe(1);
		keepLoggerSpace(402, storage);
		expect(writes()).toBe(2);
	});

	it('ignores a height that is no logger’s, and reads none back from a bad one', () => {
		const { storage, writes } = memory();
		for (const height of [0, -4, NaN, Infinity, LOGGER_SPACE_MAX + 1])
			keepLoggerSpace(height, storage);
		expect(writes()).toBe(0);
		for (const kept of ['', 'tall', '0', '-1', String(LOGGER_SPACE_MAX + 1)]) {
			expect(readLoggerSpace(memory({ [LOGGER_SPACE_KEY]: kept }).storage), kept).toBeNull();
		}
	});

	it('reserves nothing, and never throws, when storage refuses', () => {
		const refusing: LoggerSpaceStorage = {
			getItem: () => {
				throw new DOMException('denied', 'SecurityError');
			},
			setItem: () => {
				throw new DOMException('full', 'QuotaExceededError');
			}
		};
		expect(readLoggerSpace(refusing)).toBeNull();
		expect(() => keepLoggerSpace(318, refusing)).not.toThrow();
		expect(readLoggerSpace(null)).toBeNull();
	});
});
