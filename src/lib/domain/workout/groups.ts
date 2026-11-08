/**
 * A strength kit's straight exercises and supersets, with their A1/A2 labels. Apart from flow.ts
 * so the strength view's first render, which only labels, does not carry the flow's rules.
 */
import type { KitExercise } from './types.ts';

/** One straight exercise, or a superset. */
export interface ExerciseGroup {
	/** 'A', 'B'… 'Z', 'AA' for a superset, in workout order; null for a straight exercise. */
	letter: string | null;
	/** Its exercises in order, labelled 'A1', 'A2'… in a superset; null when straight. */
	members: { position: number; label: string | null }[];
}

type Grouped = Pick<KitExercise, 'position' | 'superset'>;

/** 0 → 'A', 25 → 'Z', 26 → 'AA'. */
const letterOf = (n: number): string =>
	(n < 26 ? '' : letterOf(Math.floor(n / 26) - 1)) + String.fromCharCode(65 + (n % 26));

/** Runs of consecutive exercises with one superset number, by position; a run of one is straight. */
export function runsOf<T extends Grouped>(items: readonly T[]): T[][] {
	const runs: T[][] = [];
	for (const item of [...items].sort((a, b) => a.position - b.position)) {
		const run = runs.at(-1);
		if (run && item.superset !== null && item.superset === run[0]!.superset) run.push(item);
		else runs.push([item]);
	}
	return runs;
}

/** A strength kit's straight exercises and supersets, in order, with their labels. */
export function groups(kit: { exercises: readonly Grouped[] }): ExerciseGroup[] {
	let supersets = 0;
	return runsOf(kit.exercises).map((run) => {
		const letter = run.length > 1 ? letterOf(supersets++) : null;
		return {
			letter,
			members: run.map(({ position }, i) => ({ position, label: letter && `${letter}${i + 1}` }))
		};
	});
}
