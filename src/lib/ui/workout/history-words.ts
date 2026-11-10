/**
 * The words of the exercise-history sheet (ExerciseHistorySheet.svelte): each session's date and
 * sets, the best e1RM, always labelled as an estimate, and the rep PRs, each in the unit its set
 * was logged in. Pure, so it is unit-tested without a browser.
 */
import { localDay } from '#lib/domain/dates.ts';
import { convertWeight, formatWeight } from '#lib/domain/units.ts';
import type { Instant, LoggedSet } from '#lib/domain/workout/index.ts';
import type { HistoryBest, HistoryRepMax } from '#lib/client/workout/exercise-history.ts';
import { shortDate } from '#lib/ui/program/words.ts';
import { doneText, SET_STATE_WORDS } from './set-words.ts';

/** The device's own time zone: the sheet shows days as the owner lives them. */
const deviceZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** 'Wed 4 Nov', the day an instant fell on. */
export const dayOf = (at: Instant, timeZone = deviceZone()) =>
	shortDate(localDay(new Date(at), timeZone));

export interface HistorySetWords {
	/** 'Set 2' or 'Warm-up'. */
	label: string;
	/** '100 kg × 5 reps · RPE 8'; 'Not done' for a skipped set. */
	value: string;
	/** 'Extra set · 1 missed'; null for a plain set. */
	mark: string | null;
}

/** A set in words; `n` is its 1-based place when it carries no set index (a device's session). */
export function historySetWords(
	set: LoggedSet & { setIndex?: number; isSkipped?: boolean },
	n: number
): HistorySetWords {
	const marks = [
		set.isSkipped && SET_STATE_WORDS.skipped,
		set.isExtra && SET_STATE_WORDS.extra,
		set.missedReps > 0 && `${set.missedReps} missed`
	].filter(Boolean);
	return {
		label: set.isWarmup ? 'Warm-up' : `Set ${set.setIndex ?? n}`,
		value: set.isSkipped ? 'Not done' : doneText(set),
		mark: marks.join(' · ') || null
	};
}

/** 'Estimated 1RM · 117.5 kg', and the set it comes from: 'From 100 kg × 5 reps · Wed 4 Nov'. */
export function bestWords(best: HistoryBest, timeZone?: string) {
	const { set } = best;
	return {
		value: `Estimated 1RM · ${formatWeight(convertWeight(best.value, 'kg', set.unit), set.unit, 1)}`,
		from: `From ${doneText({ ...set, rpe: null })} · ${dayOf(set.performedAt, timeZone)}`
	};
}

/** A rep PR: '5 reps', '100 kg', 'Wed 4 Nov', its weight as it was logged. */
export function repMaxWords({ reps, weightKg, set }: HistoryRepMax, timeZone?: string) {
	const weight = set.weight ?? convertWeight(weightKg, 'kg', set.unit);
	return {
		label: reps === 1 ? '1 rep' : `${reps} reps`,
		value: formatWeight(weight, set.unit),
		date: dayOf(set.performedAt, timeZone)
	};
}
