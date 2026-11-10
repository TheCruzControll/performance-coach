/**
 * The plate calculator's choices over a device's bar and plates (client/plates.ts's inventory):
 * the bars it offers, and each plate's row in the inventory editor (none, a number of pairs, or
 * any number). Pure, so the unit project tests it; the components only render it.
 */
import { STANDARD_BARS, STANDARD_PLATES, type PlateStock } from '#lib/domain/plates.ts';
import type { WeightUnit } from '#lib/domain/units.ts';

/**
 * The pair counts the editor offers for one plate, between None and Any. A gym with more pairs
 * than the last of them is 'Any' to the solver too, short of a very heavy target. Change them here.
 */
export const PAIR_CHOICES = [1, 2, 3] as const;

/** One plate's choice: 'none' (not in this gym), 'any' (as many as a load needs), or its pairs. */
export type PlateChoice = 'none' | 'any' | `${number}`;

export interface Option<T extends string> {
	value: T;
	label: string;
}

/** The bar's weight in words: '20 kg bar', or 'No bar' for a plate-loaded machine. */
const barLabel = (weight: number, unit: WeightUnit) =>
	weight === 0 ? 'No bar' : `${weight} ${unit} bar`;

/** The common bars of `unit`, and the device's own `bar` after them when it is none of them. */
export function barOptions(unit: WeightUnit, bar: number): Option<string>[] {
	const presets = STANDARD_BARS[unit].map((preset) => preset.weight);
	const weights = presets.includes(bar) ? presets : [...presets, bar];
	return weights.map((weight) => ({ value: String(weight), label: barLabel(weight, unit) }));
}

export interface PlateRow {
	weight: number;
	choice: PlateChoice;
	options: Option<PlateChoice>[];
}

const optionOf = (choice: PlateChoice): Option<PlateChoice> => ({
	value: choice,
	label: choice === 'none' ? 'None' : choice === 'any' ? 'Any' : choice
});

/**
 * One row per plate weight, heaviest first: every standard plate of `unit` and any other the
 * device keeps. A stored pair count the editor does not offer is offered too, in its place.
 */
export function plateRows(unit: WeightUnit, plates: readonly PlateStock[]): PlateRow[] {
	const weights = [...new Set([...STANDARD_PLATES[unit], ...plates.map((p) => p.weight)])];
	return weights
		.sort((a, b) => b - a)
		.map((weight) => {
			const stock = plates.find((p) => p.weight === weight);
			const choice: PlateChoice = !stock
				? 'none'
				: stock.pairs === undefined
					? 'any'
					: `${stock.pairs}`;
			const counts = new Set<number>(PAIR_CHOICES);
			if (stock?.pairs !== undefined) counts.add(stock.pairs);
			const pairs = [...counts].sort((a, b) => a - b).map((n): PlateChoice => `${n}`);
			return { weight, choice, options: (['none', ...pairs, 'any'] as const).map(optionOf) };
		});
}

/** `plates` with the plate of `weight` set to `choice`, heaviest first. */
export function withChoice(
	plates: readonly PlateStock[],
	weight: number,
	choice: PlateChoice
): PlateStock[] {
	const others = plates.filter((p) => p.weight !== weight);
	if (choice === 'none') return others;
	const stock = choice === 'any' ? { weight } : { weight, pairs: Number(choice) };
	return [...others, stock].sort((a, b) => b.weight - a.weight);
}
