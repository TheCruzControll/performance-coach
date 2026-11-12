import { describe, expect, it } from 'vitest';
import { createInstanceTracker } from './instance';

describe('instance tracker', () => {
	it('marks only the first request of a process as cold', () => {
		const tracker = createInstanceTracker();
		expect(tracker.note(812.4)).toEqual({ start: 'cold', instanceAgeMs: 812 });
		expect(tracker.note(900)).toEqual({ start: 'warm', instanceAgeMs: 900 });
		expect(tracker.note(60_000)).toEqual({ start: 'warm', instanceAgeMs: 60_000 });
	});

	it('gives each process (tracker) its own first request', () => {
		const a = createInstanceTracker();
		a.note(1);
		expect(createInstanceTracker().note(2).start).toBe('cold');
	});

	it('reports the process age from performance.now() by default', () => {
		const before = Math.round(performance.now());
		const { instanceAgeMs } = createInstanceTracker().note();
		expect(instanceAgeMs).toBeGreaterThanOrEqual(before);
	});
});
