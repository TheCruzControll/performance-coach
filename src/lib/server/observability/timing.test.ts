import { describe, expect, it } from 'vitest';
import { createContext } from './context';
import { serverTimingHeader } from './timing';

describe('serverTimingHeader', () => {
	it('lists each measured metric, then the total', () => {
		const ctx = createContext('req-12345678');
		ctx.timings.set('db', { dur: 1.23, count: 2 });
		expect(serverTimingHeader(ctx, 8.44)).toBe('db;dur=1.2;desc="2 ops", total;dur=8.4');
	});

	it('flags a cold or warm instance after the total', () => {
		const ctx = createContext('req-12345678');
		expect(serverTimingHeader(ctx, 601.8, 'cold')).toBe('total;dur=601.8, instance;desc="cold"');
		expect(serverTimingHeader(ctx, 3, 'warm')).toBe('total;dur=3.0, instance;desc="warm"');
	});
});
