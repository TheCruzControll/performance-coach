import { describe, expect, it } from 'vitest';
import type { CustomMetric } from '#lib/domain/training/types.ts';
import { OTHER_SESSION_KINDS } from '#lib/domain/training/vocabulary.ts';
import {
	effortSentence,
	effortWord,
	keptSummary,
	KIND_CHOICES,
	metricValue,
	notesValue,
	ownSessionLine
} from './session-words.ts';

const metric = (label: string, value: CustomMetric['value'], unit: string | null = null) => ({
	key: label.toLowerCase().replace(/ /g, '_'),
	label,
	unit,
	value
});

describe('the "What kind" list', () => {
	it('is Paper’s order', () => {
		expect(KIND_CHOICES.map((k) => k.value)).toEqual([
			'class',
			'pad_work',
			'sparring',
			'technical',
			'conditioning',
			'mobility',
			'strength_conditioning',
			'custom'
		]);
	});

	it('offers every session type', () => {
		expect(KIND_CHOICES.map((k) => k.value).sort()).toEqual([...OTHER_SESSION_KINDS].sort());
	});

	it('names each in its words', () => {
		const label = (kind: string) => KIND_CHOICES.find((k) => k.value === kind)?.label;
		expect(label('custom')).toBe('Something else');
		expect(label('strength_conditioning')).toBe('Strength and conditioning');
		expect(label('pad_work')).toBe('Pad work');
	});
});

describe('effort', () => {
	it('is a word for each band of 1 to 10', () => {
		expect([1, 3, 4, 6, 7, 8, 9, 10].map(effortWord)).toEqual([
			'Easy',
			'Easy',
			'Moderate',
			'Moderate',
			'Hard',
			'Hard',
			'Very hard',
			'All out'
		]);
	});

	it('says what the number means under the scale', () => {
		expect(effortSentence(8)).toBe('8 is hard. It shows as Hard on the session.');
		expect(effortSentence(10)).toBe('10 is all out. It shows as All out on the session.');
		expect(effortSentence(null)).toBe('Tap a number. 1 is easy, 10 is all out.');
	});
});

describe('the rows’ values', () => {
	it('More to keep: the metrics’ names, the first capitalised, or Add', () => {
		expect(keptSummary([])).toBe('Add');
		expect(keptSummary([metric('Rounds', 5), metric('Clinch', true)])).toBe('Rounds, clinch');
		expect(keptSummary([metric('Bike calories', 0)])).toBe('Bike calories');
	});

	it('a metric: its number and unit, yes or no, its text, or Add', () => {
		expect(metricValue(metric('Rounds', 5))).toBe('5');
		expect(metricValue(metric('Calories', 120.5, 'kcal'))).toBe('120.5 kcal');
		expect(metricValue(metric('Sparred', true))).toBe('Yes');
		expect(metricValue(metric('Sparred', false))).toBe('No');
		expect(metricValue(metric('Focus', ''))).toBe('Add');
		expect(metricValue(metric('Stance', 'Southpaw'))).toBe('Southpaw');
	});

	it('Notes: Edit once there are some', () => {
		expect(notesValue(null)).toBe('Add');
		expect(notesValue('  ')).toBe('Add');
		expect(notesValue('Clinch work')).toBe('Edit');
	});
});

describe('ownSessionLine', () => {
	// Local time, so the days hold in any time zone.
	const at = (d: number, h = 9) => new Date(2026, 10, d, h).getTime();

	it('says today, yesterday or the date the session started', () => {
		expect(ownSessionLine(new Date(at(21, 7)).toISOString(), at(21))).toBe(
			'Today · your own session'
		);
		expect(ownSessionLine(new Date(at(20)).toISOString(), at(21))).toBe(
			'Yesterday · your own session'
		);
		expect(ownSessionLine(new Date(at(16)).toISOString(), at(21))).toBe(
			'Monday 16 November · your own session'
		);
	});

	it('counts days by the calendar, not by 24 hours', () => {
		expect(ownSessionLine(new Date(at(20, 23)).toISOString(), at(21, 0))).toBe(
			'Yesterday · your own session'
		);
		expect(ownSessionLine(new Date(at(21, 0)).toISOString(), at(21, 23))).toBe(
			'Today · your own session'
		);
	});
});
