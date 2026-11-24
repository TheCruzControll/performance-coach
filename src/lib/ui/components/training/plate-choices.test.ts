import { describe, expect, it } from 'vitest';
import { defaultPlateInventory } from '#lib/client/plates.ts';
import { calculatePlates, STANDARD_PLATES, type PlateStock } from '#lib/domain/plates.ts';
import {
	barOptions,
	barValue,
	inventoryLead,
	inventoryValue,
	PAIR_CHOICES,
	plateAnswer,
	plateChoiceWords,
	plateRows,
	withChoice
} from './plate-choices';

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
		expect(rows[0]!.options.map((o) => o.label)).toEqual([
			'None',
			'1 pair',
			'2 pairs',
			'3 pairs',
			'Any'
		]);
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

describe('plateAnswer', () => {
	const KG = STANDARD_PLATES.kg.map((weight) => ({ weight }));
	const NO_SMALL = [25, 20, 15, 10, 5, 2.5].map((weight) => ({ weight }));

	it('says the plates for one side as one line, heaviest first', () => {
		expect(plateAnswer(calculatePlates(102.5, 20, KG), 102.5, 20, 'kg')).toEqual({
			line: '25 · 15 · 1.25',
			caption: 'kg on each side, heaviest first',
			note: null
		});
		expect(plateAnswer(calculatePlates(225, 45, STANDARD_PLATES.lb), 225, 45, 'lb').line).toBe(
			'45 · 45'
		);
	});

	it('names the closest load and how short, when the gym cannot make it', () => {
		expect(plateAnswer(calculatePlates(102.5, 20, NO_SMALL), 102.5, 20, 'kg')).toEqual({
			line: '25 · 15',
			caption: 'kg on each side, heaviest first',
			note: 'Closest load is 100 kg, 2.5 kg short.'
		});
	});

	it('is the bar alone at its weight, and says so below it', () => {
		expect(plateAnswer(calculatePlates(15, 20, KG), 15, 20, 'kg')).toEqual({
			line: 'Just the bar',
			caption: 'The 20 kg bar on its own',
			note: 'Below the 20 kg bar: the bar alone is the lightest load.'
		});
		expect(plateAnswer(calculatePlates(20, 20, KG), 20, 20, 'kg')).toEqual({
			line: 'Just the bar',
			caption: 'The 20 kg bar on its own',
			note: null
		});
		expect(plateAnswer(calculatePlates(0, 0, KG), 0, 0, 'kg')).toEqual({
			line: 'Nothing to load',
			caption: null,
			note: null
		});
	});
});

describe('inventoryValue', () => {
	const standard = (): PlateStock[] => STANDARD_PLATES.kg.map((weight) => ({ weight }));
	const without = (...weights: number[]) => standard().filter((p) => !weights.includes(p.weight));
	const limit = (plates: PlateStock[], weight: number, pairs: number) =>
		plates.map((p) => (p.weight === weight ? { weight, pairs } : p));

	it('is what this gym has with every standard plate, as many as a load needs', () => {
		expect(inventoryValue('kg', defaultPlateInventory('kg'))).toBe('What this gym has');
	});

	it('names up to three missing plates, then counts them', () => {
		expect(inventoryValue('kg', { plates: without(1.25) })).toBe('No 1.25 kg plates');
		expect(inventoryValue('kg', { plates: without(1.25, 0.5) })).toBe('No 1.25 or 0.5 kg plates');
		expect(inventoryValue('kg', { plates: without(1.25, 0.5, 0.25) })).toBe(
			'No 1.25, 0.5 or 0.25 kg plates'
		);
		expect(inventoryValue('kg', { plates: without(1.25, 0.5, 0.25, 2.5) })).toBe(
			'4 weights missing'
		);
	});

	it('says where pairs are limited, after any missing plate', () => {
		expect(inventoryValue('kg', { plates: limit(standard(), 15, 2) })).toBe(
			'Pairs limited on 15 kg'
		);
		expect(inventoryValue('kg', { plates: limit(limit(standard(), 15, 2), 2.5, 1) })).toBe(
			'Pairs limited on 2 plates'
		);
		expect(inventoryValue('kg', { plates: limit(without(1.25), 15, 2) })).toBe('No 1.25 kg plates');
	});
});

describe('the words of the bar and plates', () => {
	it('says a plate choice as None, its pairs or Any', () => {
		expect(['none', 'any', '1', '2'].map((c) => plateChoiceWords(c as 'none'))).toEqual([
			'None',
			'Any',
			'1 pair',
			'2 pairs'
		]);
		expect(
			plateRows('kg', [])
				.at(0)!
				.options.map((o) => o.label)
		).toEqual(['None', '1 pair', '2 pairs', '3 pairs', 'Any']);
	});

	it('says the bar by its weight, or No bar for a machine', () => {
		expect(barValue(20, 'kg')).toBe('20 kg');
		expect(barValue(0, 'kg')).toBe('No bar');
		expect(barValue(17.5, 'lb')).toBe('17.5 lb');
	});

	it("leads Bar and plates in the calculator's unit", () => {
		expect(inventoryLead('kg')).toBe(
			'What this gym has, in kilograms. Any means as many pairs as a load needs.'
		);
		expect(inventoryLead('lb')).toBe(
			'What this gym has, in pounds. Any means as many pairs as a load needs.'
		);
	});
});
