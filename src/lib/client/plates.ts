/**
 * This device's bar and plates (PRD §8), in localStorage under pc:plates:v1: one inventory per
 * unit, which the workout's plate sheet and Train's calculator share, so M1's exact solver
 * (domain/plates.ts) answers with what this gym can actually load.
 *
 * - Until the owner changes it, a unit's inventory is M1's Olympic bar and standard plates with
 *   no pair limit: exactly what the calculator has always used.
 * - Like theme and units, it is a device preference, not account data, so sign-out keeps it
 *   (docs/security.md, 'Sign-out').
 * - Each unit, and its bar and plates, are validated on their own, so a corrupt or partial value
 *   falls back field by field; storage that is missing, blocked or full is never an error.
 * Plain .ts with no runes; `storage` is an argument, so Vitest's unit project runs it.
 */
import { STANDARD_BARS, STANDARD_PLATES, type PlateStock } from '#lib/domain/plates.ts';
import type { WeightUnit } from '#lib/domain/units.ts';

export const PLATES_KEY = 'pc:plates:v1';

export interface PlateInventory {
	/** The bar's weight; 0 for a plate-loaded machine with no bar. */
	bar: number;
	/** Distinct plate weights, heaviest first; a plate without `pairs` has as many as a load needs. */
	plates: PlateStock[];
}

/**
 * The bounds, per unit where they differ: the heaviest bar and plate, the most pairs of one
 * plate, and how many plate weights an inventory holds. Weights are kept to thousandths, the
 * solver's resolution.
 */
export const PLATE_LIMITS = {
	bar: { kg: 100, lb: 220 },
	plate: { kg: 50, lb: 100 },
	pairs: 20,
	kinds: 20
} as const satisfies {
	bar: Record<WeightUnit, number>;
	plate: Record<WeightUnit, number>;
	pairs: number;
	kinds: number;
};

const UNITS = ['kg', 'lb'] as const satisfies readonly WeightUnit[];

/** A unit's inventory until the owner changes it: M1's first bar and every standard plate. */
export function defaultPlateInventory(unit: WeightUnit): PlateInventory {
	return {
		bar: STANDARD_BARS[unit][0]!.weight,
		plates: STANDARD_PLATES[unit].map((weight) => ({ weight }))
	};
}

/** The part of localStorage the inventory uses. */
export type DeviceStorage = Pick<Storage, 'getItem' | 'setItem'>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** A weight from `min` to `max` (above `min` when `above`), to thousandths. */
const isWeight = (value: unknown, min: number, max: number, above = false): value is number =>
	typeof value === 'number' &&
	(above ? value > min : value >= min) &&
	value <= max &&
	Math.abs(Math.round(value * 1000) - value * 1000) < 1e-6;

const isPairs = (value: unknown): value is number =>
	Number.isInteger(value) && (value as number) >= 1 && (value as number) <= PLATE_LIMITS.pairs;

/**
 * The usable plates of a stored list, heaviest first; undefined when it is not a list, or when it
 * had plates and none is usable. An empty list is a bar with no plates.
 */
function platesOf(value: unknown, unit: WeightUnit): PlateStock[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const plates = new Map<number, PlateStock>();
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const { weight, pairs } = entry;
		if (!isWeight(weight, 0, PLATE_LIMITS.plate[unit], true) || plates.has(weight)) continue;
		plates.set(weight, isPairs(pairs) ? { weight, pairs } : { weight });
	}
	if (value.length > 0 && plates.size === 0) return undefined;
	return [...plates.values()].sort((a, b) => b.weight - a.weight).slice(0, PLATE_LIMITS.kinds);
}

/**
 * `base` (always a fresh inventory) with the valid bar and plates of `input` over it; a field that
 * is not valid keeps the base's.
 */
function overlay(base: PlateInventory, input: unknown, unit: WeightUnit): PlateInventory {
	const given = isRecord(input) ? input : {};
	return {
		bar: isWeight(given.bar, 0, PLATE_LIMITS.bar[unit]) ? given.bar : base.bar,
		plates: platesOf(given.plates, unit) ?? base.plates
	};
}

/** The page's localStorage, or null where there is none or touching it throws (blocked storage). */
function pageStorage(): DeviceStorage | null {
	try {
		return (globalThis as { localStorage?: Storage }).localStorage ?? null;
	} catch {
		return null;
	}
}

/** Every stored unit's raw value; an empty record when nothing usable is stored. */
function stored(storage: DeviceStorage | null): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(storage?.getItem(PLATES_KEY) ?? 'null');
		return isRecord(value) ? value : {};
	} catch {
		return {};
	}
}

/** The device's inventory for `unit`, every field valid; the defaults for whatever it lacks. */
export function readPlateInventory(
	unit: WeightUnit,
	storage: DeviceStorage | null = pageStorage()
): PlateInventory {
	return overlay(defaultPlateInventory(unit), stored(storage)[unit], unit);
}

/**
 * Applies `change` over the device's inventory for `unit` and keeps it; the other unit's is left
 * as it is. A field of `change` that is not valid is ignored. `saved` is false when the browser
 * could not keep it (private mode, a full or blocked storage): it still applies to this page.
 */
export function writePlateInventory(
	unit: WeightUnit,
	change: Partial<PlateInventory>,
	storage: DeviceStorage | null = pageStorage()
): { inventory: PlateInventory; saved: boolean } {
	const all = stored(storage);
	const inventory = overlay(overlay(defaultPlateInventory(unit), all[unit], unit), change, unit);
	const next: Record<string, unknown> = {};
	for (const each of UNITS) next[each] = each === unit ? inventory : all[each];
	try {
		storage?.setItem(PLATES_KEY, JSON.stringify(next));
		return { inventory, saved: storage !== null };
	} catch {
		return { inventory, saved: false };
	}
}
