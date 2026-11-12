import { describe, expect, it } from 'vitest';
import {
	deltaIcon,
	deltaTone,
	deltaWords,
	soFarWords,
	spanSentence,
	tileSentence,
	valueWords,
	verdictIcon,
	verdictTone,
	verdictWords,
	withinWords,
	type Tile,
	type TileDelta
} from './words.ts';
import { verdictParts } from './verdict-words.ts';

const against = 'the 12 weeks before';
const delta = (value: number, change: TileDelta['change'], text: string): TileDelta => ({
	value,
	change,
	text,
	against
});

describe('the delta', () => {
	it('says better for a fall in a lower-is-better metric, its arrow pointing up with better', () => {
		const faster = delta(-8, 'better', '−0:08 /km');
		expect(deltaWords(faster)).toBe('−0:08 /km better than the 12 weeks before');
		expect(deltaIcon(faster)).toBe('trend-up');
		expect(deltaTone(faster)).toBe('positive');
	});

	it('says worse for a rise in a lower-is-better metric, as a warning, its arrow pointing down', () => {
		const slower = delta(5, 'worse', '+0:05 /km');
		expect(deltaWords(slower)).toBe('+0:05 /km worse than the 12 weeks before');
		expect(deltaIcon(slower)).toBe('trend-down');
		expect(deltaTone(slower)).toBe('warning');
	});

	it('points a higher-is-better rise up and its fall down, and a metric with no better way as it moved', () => {
		expect(deltaIcon(delta(5, 'better', '+5 kg'))).toBe('trend-up');
		expect(deltaIcon(delta(-3, 'worse', '−3 sets'))).toBe('trend-down');
		expect(deltaIcon(delta(0.4, 'up', '+0.4 kg'))).toBe('trend-up');
		expect(deltaIcon(delta(-0.4, 'down', '−0.4 kg'))).toBe('trend-down');
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

	it('points a real trend’s arrow at better: a faster pace is an improvement pointing up', () => {
		const faster = { verdict: 'real_trend', direction: 'down', good: true } as const;
		expect(verdictWords(faster)).toBe('Real improvement');
		expect(verdictIcon(faster)).toBe('trend-up');
		const slower = { verdict: 'real_trend', direction: 'up', good: false } as const;
		expect(verdictWords(slower)).toBe('Real decline');
		expect(verdictIcon(slower)).toBe('trend-down');
		expect(verdictIcon({ verdict: 'real_trend', direction: 'down', good: null })).toBe(
			'trend-down'
		);
		expect(verdictIcon({ verdict: 'real_trend', direction: 'up', good: null })).toBe('trend-up');
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

	it('splits its phrase, kept on one line, from the window and count, which may wrap', () => {
		const up = { verdict: 'real_trend', direction: 'up', good: true } as const;
		expect(verdictParts(up, twelve)).toEqual(['Real improvement', ' over the last 12 weeks']);
		expect(verdictParts(up)).toEqual(['Real improvement', '']);
		expect(verdictParts({ verdict: 'normal_variation' })).toEqual(['Normal variation', '']);
		const thin = { verdict: 'insufficient_data', have: 2, need: 6, unit: 'weeks' } as const;
		expect(verdictParts(thin, twelve)).toEqual([
			'Not enough data yet',
			' · 2 of 6 weeks over the last 12 weeks'
		]);
		for (const verdict of [up, thin, { verdict: 'normal_variation' } as const])
			expect(verdictParts(verdict, twelve).join('')).toBe(verdictWords(verdict, twelve));
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
			'Squat e1RM: 142.5\u00a0kg, estimated. +5 kg better than the 12 weeks before. ' +
				'This week so far: 140 kg · 137.5 kg by Wednesday last week. ' +
				'Real improvement over the last 12 weeks.'
		);
	});

	it('says there is nothing to compare with, and leaves out what it was not given', () => {
		expect(
			tileSentence({ ...tile, delta: null, soFar: null, verdict: null, kind: 'measured' })
		).toBe('Squat e1RM: 142.5\u00a0kg, measured. No earlier period to compare with.');
	});

	it('with no earlier period, says how its own weeks moved, in the same words as its verdict', () => {
		expect(tileSentence({ ...tile, delta: null, soFar: null })).toBe(
			'Squat e1RM: 142.5\u00a0kg, estimated. Improving over 12 weeks. ' +
				'Real improvement over the last 12 weeks.'
		);
		// It never says there is no earlier period above a verdict that read twelve weeks.
		expect(tileSentence({ ...tile, delta: null })).not.toContain('No earlier period');
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

describe('a tile with no earlier period', () => {
	const twelve = { sameAsPeriod: true, weeks: 12 };

	it('describes the trend within its weeks, by better rather than by the raw sign', () => {
		const improving = { verdict: 'real_trend', direction: 'down', good: true } as const;
		expect(withinWords(improving, twelve)).toBe('Improving over 12 weeks');
		const declining = { verdict: 'real_trend', direction: 'up', good: false } as const;
		expect(withinWords(declining, twelve)).toBe('Declining over 12 weeks');
		expect(withinWords({ verdict: 'normal_variation' }, twelve)).toBe(
			'Holding steady over 12 weeks'
		);
		expect(withinWords({ verdict: 'real_trend', direction: 'up', good: null }, twelve)).toBe(
			'Rising over 12 weeks'
		);
		expect(withinWords({ verdict: 'real_trend', direction: 'down', good: null }, twelve)).toBe(
			'Falling over 12 weeks'
		);
	});

	it('counts its weeks in words that agree with the number', () => {
		const steady = { verdict: 'normal_variation' } as const;
		expect(withinWords(steady, { sameAsPeriod: true, weeks: 1 })).toBe(
			'Holding steady over 1 week'
		);
		expect(withinWords(steady, { sameAsPeriod: true, weeks: null })).toBe(
			'Holding steady over these weeks'
		);
	});

	it('says nothing of a trend it has not read: too little data, or no verdict', () => {
		const thin = { verdict: 'insufficient_data', have: 2, need: 6, unit: 'weeks' } as const;
		expect(withinWords(thin, twelve)).toBeNull();
		expect(withinWords(null, twelve)).toBeNull();
		expect(withinWords(undefined)).toBeNull();
	});
});

describe('a chart’s sentence', () => {
	it('says held at when its two ends read the same, with the headline best beside it', () => {
		expect(spanSentence('Estimated 1RM', '98.5\u00a0kg', '98.5\u00a0kg', '101.5\u00a0kg')).toBe(
			'Estimated 1RM held at 98.5\u00a0kg, with a best of 101.5\u00a0kg.'
		);
		expect(spanSentence('Estimated 1RM', '98.5\u00a0kg', '98.5\u00a0kg', '98.5\u00a0kg')).toBe(
			'Estimated 1RM held at 98.5\u00a0kg.'
		);
	});

	it('says went from and to, naming the best only when it is neither end', () => {
		expect(spanSentence('Estimated 1RM', '123.5\u00a0kg', '157\u00a0kg', '157\u00a0kg')).toBe(
			'Estimated 1RM went from 123.5\u00a0kg to 157\u00a0kg.'
		);
		expect(spanSentence('Estimated 1RM', '100\u00a0kg', '102.5\u00a0kg', '105\u00a0kg')).toBe(
			'Estimated 1RM went from 100\u00a0kg to 102.5\u00a0kg, with a best of 105\u00a0kg.'
		);
		expect(spanSentence('Estimated 1RM', '100\u00a0kg', '102.5\u00a0kg')).toBe(
			'Estimated 1RM went from 100\u00a0kg to 102.5\u00a0kg.'
		);
	});
});

describe('a value with its unit', () => {
	it('keeps the unit on the number’s line with a non-breaking space, and a percentage tight', () => {
		expect(valueWords('142.5', 'kg')).toBe('142.5\u00a0kg');
		expect(valueWords('5:42', '/km')).toBe('5:42\u00a0/km');
		expect(valueWords('100', '%')).toBe('100%');
		expect(valueWords('14')).toBe('14');
	});
});
