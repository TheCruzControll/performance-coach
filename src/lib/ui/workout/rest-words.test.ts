import { describe, expect, it } from 'vitest';
import { addRest, pauseRest, resetRest, skipRest, startRest } from '#lib/domain/workout/timers.ts';
import { msToNextTick, readRest } from './rest-words';

const T0 = 1_000_000;
const REST = startRest(T0, 120_000);

describe('readRest', () => {
	it('counts down from the whole rest, in seconds rounded up', () => {
		expect(readRest(REST, T0)).toEqual({
			phase: 'running',
			time: '2:00',
			label: 'Rest',
			progress: 0,
			total: '2:00'
		});
		expect(readRest(REST, T0 + 400).time).toBe('2:00');
		expect(readRest(REST, T0 + 1_000).time).toBe('1:59');
		expect(readRest(REST, T0 + 40_000).time).toBe('1:20');
		expect(readRest(REST, T0 + 40_000).progress).toBeCloseTo(1 / 3);
		expect(readRest(REST, T0 + 119_999).time).toBe('0:01');
	});

	it('once over, says how long ago it ended, counting up', () => {
		expect(readRest(REST, T0 + 120_000)).toEqual({
			phase: 'over',
			time: '0:00',
			label: 'Rest over',
			progress: 1,
			total: '2:00'
		});
		expect(readRest(REST, T0 + 162_500).time).toBe('0:42');
	});

	it('holds a paused rest where it stopped, whatever the time', () => {
		const paused = pauseRest(REST, T0 + 40_000);
		expect(readRest(paused, T0 + 40_000)).toMatchObject({ phase: 'paused', time: '1:20' });
		expect(readRest(paused, T0 + 900_000)).toMatchObject({ phase: 'paused', label: 'Paused' });
		expect(readRest(paused, T0 + 900_000).time).toBe('1:20');
	});

	it('counts +30 s into the time and the whole, and a reset takes it back', () => {
		const added = addRest(REST, T0 + 40_000);
		expect(readRest(added, T0 + 40_000)).toMatchObject({ time: '1:50', total: '2:30' });
		const reset = resetRest(added, T0 + 50_000);
		expect(readRest(reset, T0 + 50_000)).toMatchObject({ time: '2:00', total: '2:00' });
	});

	it('reads a skipped rest as over from the skip', () => {
		expect(readRest(skipRest(REST, T0 + 10_000), T0 + 15_000)).toMatchObject({
			phase: 'over',
			time: '0:05'
		});
	});
});

describe('msToNextTick', () => {
	it('waits until the shown second turns over, from the rest’s own end', () => {
		expect(msToNextTick(REST, T0)).toBe(1_000);
		expect(msToNextTick(REST, T0 + 250)).toBe(750);
		const offset = startRest(T0 + 300, 120_000);
		expect(msToNextTick(offset, T0 + 1_000)).toBe(300);
		// Overtime turns over on the same seconds.
		expect(msToNextTick(REST, T0 + 120_900)).toBe(100);
	});

	it('lands each tick where readRest shows the next second', () => {
		const now = T0 + 40_250;
		const at = now + msToNextTick(REST, now);
		expect(readRest(REST, at - 1).time).toBe('1:20');
		expect(readRest(REST, at).time).toBe('1:19');
	});
});
