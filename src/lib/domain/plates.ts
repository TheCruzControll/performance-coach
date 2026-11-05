/**
 * Plate calculator: which plates to load on each side of a bar to reach a target weight.
 *
 * Solved exactly with a bounded-knapsack DP over integer "ticks" (the GCD of all plate weights),
 * so limited plate inventories are handled correctly where a greedy fill fails (e.g. 30 kg per
 * side with no 5s and a single pair of 25s: greedy loads 25 and gives up; the DP finds 20+10).
 * Among exact solutions it prefers fewer plates, then the heaviest plates first, matching how
 * lifters load a bar.
 */
import { cleanFloat, type WeightUnit } from './units';

export interface PlateStock {
	/** Plate weight in the calculation unit. */
	weight: number;
	/** Pairs available (one plate per side). Omit for unlimited. */
	pairs?: number;
}

export interface PlateResult {
	/** Plates for ONE side, heaviest first. */
	perSide: number[];
	/** Total achievable weight including the bar. */
	achieved: number;
	/** target − achieved: 0 when exact, > 0 when the target cannot be loaded exactly. */
	remainder: number;
	exact: boolean;
}

export const STANDARD_PLATES: Record<WeightUnit, number[]> = {
	kg: [25, 20, 15, 10, 5, 2.5, 1.25, 0.5, 0.25],
	lb: [45, 35, 25, 10, 5, 2.5, 1.25]
};

export const STANDARD_BARS: Record<WeightUnit, { label: string; weight: number }[]> = {
	kg: [
		{ label: 'Olympic bar', weight: 20 },
		{ label: "Women's bar", weight: 15 },
		{ label: 'Technique bar', weight: 10 }
	],
	lb: [
		{ label: 'Olympic bar', weight: 45 },
		{ label: "Women's bar", weight: 35 },
		{ label: 'Technique bar', weight: 25 }
	]
};

const SCALE = 1000; // work in thousandths to keep everything integral

function gcd(a: number, b: number): number {
	while (b) [a, b] = [b, a % b];
	return a;
}

/**
 * Compute plates per side for `target` on a bar weighing `bar`. Never exceeds the target;
 * when the target is not loadable exactly, returns the heaviest achievable load below it.
 */
export function calculatePlates(
	target: number,
	bar: number,
	stock: PlateStock[] | number[]
): PlateResult {
	const plates: PlateStock[] = (stock as (PlateStock | number)[])
		.map((p) => (typeof p === 'number' ? { weight: p } : p))
		.filter((p) => p.weight > 0 && (p.pairs === undefined || p.pairs > 0))
		// Ascending: heavier plates are considered last and win ties (see `<=` below).
		.sort((a, b) => a.weight - b.weight);

	if (!(target > bar) || plates.length === 0) {
		return {
			perSide: [],
			achieved: bar,
			remainder: cleanFloat(target - bar),
			exact: cleanFloat(target - bar) === 0
		};
	}

	const ints = plates.map((p) => Math.round(p.weight * SCALE));
	const tick = ints.reduce((g, w) => gcd(g, w));
	const units = ints.map((w) => w / tick);
	const perSideTarget = Math.floor(Math.round(((target - bar) / 2) * SCALE) / tick);

	// dp[s] = minimal plate count to make exactly s ticks; choice[s] = [plateIndex, count]
	const INF = Number.MAX_SAFE_INTEGER;
	let dp: number[] = new Array(perSideTarget + 1).fill(INF);
	dp[0] = 0;
	const choices: Int32Array[] = [];
	for (let i = 0; i < units.length; i++) {
		const w = units[i]!;
		const limit = Math.min(plates[i]!.pairs ?? Infinity, Math.floor(perSideTarget / w));
		const next = dp.slice();
		const pick = new Int32Array(perSideTarget + 1);
		for (let s = 0; s <= perSideTarget; s++) {
			for (let k = 1; k <= limit && k * w <= s; k++) {
				const prev = dp[s - k * w]!;
				if (prev !== INF && prev + k <= next[s]!) {
					next[s] = prev + k;
					pick[s] = k;
				}
			}
		}
		choices.push(pick);
		dp = next;
	}

	let best = perSideTarget;
	while (best > 0 && dp[best] === INF) best--;

	const perSide: number[] = [];
	let s = best;
	for (let i = units.length - 1; i >= 0; i--) {
		const k = choices[i]![s]!;
		for (let j = 0; j < k; j++) perSide.push(plates[i]!.weight);
		s -= k * units[i]!;
	}
	perSide.sort((a, b) => b - a);

	const achieved = cleanFloat(bar + 2 * perSide.reduce((sum, w) => sum + w, 0));
	return {
		perSide,
		achieved,
		remainder: cleanFloat(target - achieved),
		exact: cleanFloat(target - achieved) === 0
	};
}
