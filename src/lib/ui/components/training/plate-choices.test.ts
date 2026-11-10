import { describe, expect, it } from 'vitest';
import { STANDARD_PLATES } from '#lib/domain/plates.ts';
import { barOptions, PAIR_CHOICES, plateRows, withChoice } from './plate-choices';

describe('barOptions', () => {
	it('offers the common bars, named as Train always has', () => {
		expect(barOptions('kg', 20)).toEqual([
			{ value: '20', label: '20 kg bar' },
			{ value: '15', label: '15 kg bar' },
			{ value: '10', label: '10 kg bar' }
		]);
		expect(barOptions('lb', 35).map((o) => o.label)).toEqual([
			'45 lb bar',
			'35 lb bar',
			'25 lb bar'
		]);
	});

	it("adds the device's own bar after them, and a machine with no bar as 'No bar'", () => {
		expect(barOptions('kg', 7.5).at(-1)).toEqual({ value: '7.5', label: '7.5 kg bar' });
		expect(barOptions('kg', 7.5)).toHaveLength(4);
		expect(barOptions('lb', 0).at(-1)).toEqual({ value: '0', label: 'No bar' });
	});
});

describe('plateRows', () => {
	const values = (row: { options: { value: string }[] }) => row.options.map((o) => o.value);

	it('lists every standard plate heaviest first, each choice read from the inventory', () => {
		const rows = plateRows('kg', [
			{ weight: 20, pairs: 1 },
			{ weight: 10 },
			{ weight: 2.5, pairs: 2 }
		]);
		expect(rows.map((r) => r.weight)).toEqual(STANDARD_PLATES.kg);
		expect(Object.fromEntries(rows.map((r) => [r.weight, r.choice]))).toMatchObject({
			25: 'none',
			20: '1',
			15: 'none',
			10: 'any',
			2.5: '2'
		});
		expect(values(rows[0]!)).toEqual(['none', ...PAIR_CHOICES.map(String), 'any']);
		expect(rows[0]!.options.map((o) => o.label)).toEqual(['None', '1', '2', '3', 'Any']);
	});

	it('keeps a plate and a pair count the editor does not offer, in their places', () => {
		const rows = plateRows('lb', [{ weight: 55, pairs: 6 }, { weight: 45 }]);
		expect(rows[0]).toMatchObject({ weight: 55, choice: '6' });
		expect(values(rows[0]!)).toEqual(['none', '1', '2', '3', '6', 'any']);
		expect(rows.map((r) => r.weight)).toEqual([55, ...STANDARD_PLATES.lb]);
	});
});

describe('withChoice', () => {
	const plates = [{ weight: 25 }, { weight: 20, pairs: 2 }, { weight: 10 }];

	it('removes a plate, limits its pairs, or lets it be any number, heaviest first', () => {
		expect(withChoice(plates, 25, 'none')).toEqual([{ weight: 20, pairs: 2 }, { weight: 10 }]);
		expect(withChoice(plates, 20, '1')).toEqual([
			{ weight: 25 },
			{ weight: 20, pairs: 1 },
			{ weight: 10 }
		]);
		expect(withChoice(plates, 20, 'any')).toEqual([{ weight: 25 }, { weight: 20 }, { weight: 10 }]);
		expect(withChoice(plates, 15, '3')).toEqual([
			{ weight: 25 },
			{ weight: 20, pairs: 2 },
			{ weight: 15, pairs: 3 },
			{ weight: 10 }
		]);
	});
});
