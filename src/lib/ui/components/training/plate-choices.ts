/**
 * The plate calculator's choices and words over a device's bar and plates (client/plates.ts's
 * inventory): the bars it offers, each plate's row in Bar and plates (none, a number of pairs, or
 * any number), and the answer as Paper says it ('25 · 15 · 1.25', 'kg on each side, heaviest
 * first'). Pure, so the unit project tests it; the components only render it. Change the words here.
 */
import {
	STANDARD_BARS,
	STANDARD_PLATES,
	type PlateResult,
	type PlateStock
} from '#lib/domain/plates.ts';
import { cleanFloat, type WeightUnit } from '#lib/domain/units.ts';

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

/** A plate choice in words: 'None', 'Any', '1 pair', '2 pairs'. */
export const plateChoiceWords = (choice: PlateChoice): string =>
	choice === 'none'
		? 'None'
		: choice === 'any'
			? 'Any'
			: choice === '1'
				? '1 pair'
				: `${choice} pairs`;

const optionOf = (choice: PlateChoice): Option<PlateChoice> => ({
	value: choice,
	label: plateChoiceWords(choice)
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

/** The calculator's units, in words. */
export const UNIT_WORDS: Readonly<Record<WeightUnit, string>> = { kg: 'Kilograms', lb: 'Pounds' };

/** The Bar row's value: '20 kg', or 'No bar' for a machine. */
export const barValue = (bar: number, unit: WeightUnit): string =>
	bar === 0 ? 'No bar' : `${cleanFloat(bar)} ${unit}`;

/** Bar and plates' lead. */
export const inventoryLead = (unit: WeightUnit): string =>
	`What this gym has, in ${UNIT_WORDS[unit].toLowerCase()}. Any means as many pairs as a load needs.`;

/** The Bar and plates row's value: what differs from every standard plate, unlimited. */
export function inventoryValue(
	unit: WeightUnit,
	inventory: { plates: readonly PlateStock[] }
): string {
	const missing = STANDARD_PLATES[unit].filter(
		(weight) => !inventory.plates.some((p) => p.weight === weight)
	);
	const limited = inventory.plates.filter((p) => p.pairs !== undefined);
	if (missing.length === 1) return `No ${missing[0]} ${unit} plates`;
	if (missing.length === 2) return `No ${missing[0]} or ${missing[1]} ${unit} plates`;
	if (missing.length === 3)
		return `No ${missing[0]}, ${missing[1]} or ${missing[2]} ${unit} plates`;
	if (missing.length > 3) return `${missing.length} weights missing`;
	if (limited.length === 1) return `Pairs limited on ${limited[0]!.weight} ${unit}`;
	if (limited.length > 1) return `Pairs limited on ${limited.length} plates`;
	return 'What this gym has';
}

/** The calculator's answer in words (Paper: one line, its caption, and a note when short). */
export interface PlateAnswer {
	line: string;
	caption: string | null;
	note: string | null;
}

/**
 * The answer for `result`, the solver's loading of `target` on a `bar` in `unit` (the result
 * already says how far it is from the target).
 */
export function plateAnswer(
	result: PlateResult,
	target: number,
	bar: number,
	unit: WeightUnit
): PlateAnswer {
	const note =
		result.remainder < 0
			? `Below the ${cleanFloat(bar)} ${unit} bar: the bar alone is the lightest load.`
			: !result.exact
				? `Closest load is ${cleanFloat(result.achieved, 2)} ${unit}, ${cleanFloat(result.remainder, 2)} ${unit} short.`
				: null;
	if (result.perSide.length)
		return {
			line: result.perSide.map((w) => cleanFloat(w)).join(' · '),
			caption: `${unit} on each side, heaviest first`,
			note
		};
	if (bar === 0) return { line: 'Nothing to load', caption: null, note };
	return { line: 'Just the bar', caption: `The ${cleanFloat(bar)} ${unit} bar on its own`, note };
}
