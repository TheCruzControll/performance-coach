import { describe, expect, it } from 'vitest';
import {
	deltaIcon,
	deltaTone,
	deltaWords,
	soFarWords,
	tileSentence,
	verdictIcon,
	verdictTone,
	verdictWords,
	type Tile,
	type TileDelta
} from './words.ts';

const against = 'the 12 weeks before';
const delta = (value: number, change: TileDelta['change'], text: string): TileDelta => ({
	value,
	change,
	text,
	against
});

describe('the delta', () => {
	it('says better for a fall in a lower-is-better metric, with a falling icon and a positive tone', () => {
		const faster = delta(-8, 'better', '−0:08 /km');
		expect(deltaWords(faster)).toBe('−0:08 /km better than the 12 weeks before');
		expect(deltaIcon(faster)).toBe('trend-down');
		expect(deltaTone(faster)).toBe('positive');
	});

	it('says worse for a rise in a lower-is-better metric, as a warning', () => {
		const slower = delta(5, 'worse', '+0:05 /km');
		expect(deltaWords(slower)).toBe('+0:05 /km worse than the 12 weeks before');
		expect(deltaIcon(slower)).toBe('trend-up');
		expect(deltaTone(slower)).toBe('warning');
	});

	it('is neutral for a metric with no better way, and for a change the trend calls noise', () => {
		const heavier = delta(0.4, 'up', '+0.4 kg');
		expect(deltaWords(heavier)).toBe('+0.4 kg higher than the 12 weeks before');
		expect(deltaTone(heavier)).toBe('neutral');
		const fewer = delta(-3, 'worse', '−3 sets');
		expect(deltaTone(fewer, { verdict: 'normal_variation' })).toBe('neutral');
		expect(deltaTone(fewer, { verdict: 'real_trend', direction: 'down', good: false })).toBe(
			'warning'
		);
	});

	it('draws no change as level', () => {
		const same = delta(0, 'same', '0 kg');
		expect(deltaWords(same)).toBe('0 kg the same as the 12 weeks before');
		expect(deltaIcon(same)).toBe('trend-flat');
	});
});

describe('the so-far line', () => {
	it('names the weekday it compares up to', () => {
		const words = soFarWords({ value: '6,200 kg', lastWeek: '5,900 kg', through: '2026-11-04' });
		expect(words).toBe('This week so far: 6,200 kg · 5,900 kg by Wednesday last week');
		expect(soFarWords({ value: null, lastWeek: null, through: '2026-11-02' })).toBe(
			'This week so far: nothing yet · nothing by Monday last week'
		);
	});
});

describe('the verdict', () => {
	const twelve = { sameAsPeriod: false, weeks: 12 };

	it('adds its window only when it differs from the period', () => {
		const up = { verdict: 'real_trend', direction: 'up', good: true } as const;
		expect(verdictWords(up, twelve)).toBe('Real improvement over the last 12 weeks');
		expect(verdictWords(up, { sameAsPeriod: true, weeks: 12 })).toBe('Real improvement');
		expect(verdictWords({ verdict: 'normal_variation' }, twelve)).toBe(
			'Normal variation over the last 12 weeks'
		);
		expect(verdictIcon(up)).toBe('trend-up');
		expect(verdictTone(up)).toBe('positive');
	});

	it('words a decline, a direction-free trend and too little data', () => {
		const down = { verdict: 'real_trend', direction: 'down', good: false } as const;
		expect(verdictWords(down)).toBe('Real decline');
		expect(verdictTone(down)).toBe('warning');
		expect(verdictWords({ verdict: 'real_trend', direction: 'up', good: null })).toBe('Real rise');
		const thin = { verdict: 'insufficient_data', have: 2, need: 6, unit: 'weeks' } as const;
		expect(verdictWords(thin, twelve)).toBe(
			'Not enough data yet · 2 of 6 weeks over the last 12 weeks'
		);
		expect(verdictWords(thin)).toBe('Not enough data yet · 2 of 6 weeks');
		expect(verdictIcon(thin)).toBe('clock');
		expect(verdictTone(thin)).toBe('neutral');
	});
});

describe('the tile as one sentence', () => {
	const tile: Tile = {
		label: 'Squat e1RM',
		value: '142.5',
		unit: 'kg',
		canonical: 142.5,
		kind: 'estimated',
		delta: delta(5, 'better', '+5 kg'),
		soFar: { value: '140 kg', lastWeek: '137.5 kg', through: '2026-11-04' },
		verdict: { verdict: 'real_trend', direction: 'up', good: true },
		window: { sameAsPeriod: false, weeks: 12 }
	};

	it('reads its value, kind, delta, week so far and verdict in order', () => {
		expect(tileSentence(tile)).toBe(
			'Squat e1RM: 142.5 kg, estimated. +5 kg better than the 12 weeks before. ' +
				'This week so far: 140 kg · 137.5 kg by Wednesday last week. ' +
				'Real improvement over the last 12 weeks.'
		);
	});

	it('says there is nothing to compare with, and leaves out what it was not given', () => {
		expect(
			tileSentence({ ...tile, delta: null, soFar: null, verdict: null, kind: 'measured' })
		).toBe('Squat e1RM: 142.5 kg, measured. No earlier period to compare with.');
	});

	it('keeps Stat’s contract with no value: no data yet, never a number', () => {
		const empty = { ...tile, value: null, canonical: null, soFar: null };
		const thin = { verdict: 'insufficient_data', have: 0, need: 6, unit: 'weeks' } as const;
		expect(tileSentence({ ...empty, verdict: thin })).toBe(
			'Squat e1RM: no data yet. Not enough data yet · 0 of 6 weeks over the last 12 weeks.'
		);
		expect(tileSentence({ ...empty, verdict: null })).toBe('Squat e1RM: no data yet.');
	});

	it('still reads a first week’s week so far when no complete period has a value', () => {
		const first = { ...tile, value: null, canonical: null, delta: null, verdict: null };
		expect(tileSentence(first)).toBe(
			'Squat e1RM: no data yet. This week so far: 140 kg · 137.5 kg by Wednesday last week.'
		);
	});
});
