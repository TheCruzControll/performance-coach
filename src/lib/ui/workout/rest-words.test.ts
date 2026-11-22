import { describe, expect, it } from 'vitest';
import {
	addRest,
	DEFAULT_REST_SECONDS,
	pauseRest,
	resetRest,
	skipRest,
	startRest
} from '#lib/domain/workout/timers.ts';
import { msToBoundary } from './clock';
import { readRest, REST_CLASS_WORDS, restAnchor, restBar } from './rest-words';

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

describe('restAnchor', () => {
	it('turns over on the whole seconds from the rest’s own end', () => {
		expect(msToBoundary(restAnchor(REST), T0)).toBe(1_000);
		expect(msToBoundary(restAnchor(REST), T0 + 250)).toBe(750);
		const offset = startRest(T0 + 300, 120_000);
		expect(msToBoundary(restAnchor(offset), T0 + 1_000)).toBe(300);
		// Overtime turns over on the same seconds, and so does a rest with 30 s added.
		expect(msToBoundary(restAnchor(REST), T0 + 120_900)).toBe(100);
		expect(restAnchor(addRest(REST, T0 + 400))).toBe(T0 + 150_000);
	});

	it('lands each tick where readRest shows the next second', () => {
		const now = T0 + 40_250;
		const at = now + msToBoundary(restAnchor(REST), now);
		expect(readRest(REST, at - 1).time).toBe('1:20');
		expect(readRest(REST, at).time).toBe('1:19');
	});
});

describe('restBar', () => {
	it('starts the bar as far in as the rest has run, over its whole length', () => {
		expect(restBar(REST, T0)).toEqual({ durationMs: 120_000, delayMs: 0, running: true });
		expect(restBar(REST, T0 + 40_000)).toEqual({
			durationMs: 120_000,
			delayMs: -40_000,
			running: true
		});
		// The bar's place is the reading's progress, so the two never disagree.
		const { durationMs, delayMs } = restBar(REST, T0 + 40_000);
		expect(-delayMs / durationMs).toBeCloseTo(readRest(REST, T0 + 40_000).progress);
	});

	it('counts +30 s into the whole length, from where the bar was', () => {
		const added = addRest(REST, T0 + 40_000);
		expect(restBar(added, T0 + 40_000)).toEqual({
			durationMs: 150_000,
			delayMs: -40_000,
			running: true
		});
		expect(restBar(resetRest(added, T0 + 50_000), T0 + 50_000)).toMatchObject({
			durationMs: 120_000,
			delayMs: 0
		});
	});

	it('holds a paused rest where it stopped, whatever the time', () => {
		const paused = pauseRest(REST, T0 + 40_000);
		expect(restBar(paused, T0 + 900_000)).toEqual({
			durationMs: 120_000,
			delayMs: -40_000,
			running: false
		});
	});

	it('is full and still once the rest is over or skipped', () => {
		expect(restBar(REST, T0 + 200_000)).toEqual({
			durationMs: 120_000,
			delayMs: -120_000,
			running: false
		});
		expect(restBar(skipRest(REST, T0 + 10_000), T0 + 10_000)).toMatchObject({
			delayMs: -120_000,
			running: false
		});
	});
});

describe('REST_CLASS_WORDS', () => {
	it('names every rest class once, in the order of the device defaults', () => {
		expect(REST_CLASS_WORDS.map((row) => row.restClass)).toEqual(Object.keys(DEFAULT_REST_SECONDS));
		expect(REST_CLASS_WORDS.map((row) => row.label)).toEqual([
			'Main lifts',
			'Other compounds',
			'Isolation',
			'Timed'
		]);
	});
});
