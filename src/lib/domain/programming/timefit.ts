/**
 * How long a strength session takes (PRD §2, §5; m3-plan 'Session length'): the warm-up, then
 * each set's work and rest (rules/strength.ts TIME), rounded up to a whole minute. The strength
 * stage gives each session its estimate, and volume (m3/22) adds sets only while it fits.
 *
 * Pure: no clock, no randomness, no I/O.
 */
import type { StrengthSessionPlan } from '../training/types.ts';
import { toExerciseKey } from './input.ts';
import type { ProgrammingInput } from './input.ts';
import { TIME } from './rules/strength.ts';
import { exerciseOf } from './selection.ts';

/** About how long the session's exercises take, in whole minutes, its warm-up included. */
export function estimateMinutes(
	session: Pick<StrengthSessionPlan, 'exercises'>,
	input: ProgrammingInput
): number {
	let seconds = TIME.warmUpMinutes * 60;
	for (const planned of session.exercises) {
		const sides = exerciseOf(input, toExerciseKey(planned.exercise))?.unilateral ? 2 : 1;
		for (const line of planned.sets) {
			const work =
				line.seconds ??
				(line.metres === null
					? (line.repsMax ?? line.repsMin ?? 0) * TIME.secondsPerRep
					: line.metres * TIME.secondsPerMetre);
			seconds += line.sets * (work * sides + (line.restSeconds ?? 0));
		}
	}
	return Math.ceil(seconds / 60);
}
