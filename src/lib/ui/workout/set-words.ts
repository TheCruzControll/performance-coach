/**
 * The words the strength view shows for an exercise and its sets (PRD §7): what a set asks for,
 * what was done, the rest, the load to use, and each set row's state. The prescription lines
 * themselves are the kit's (M3's describePrescription headlines), never rebuilt here, so no
 * describe code reaches the workout pages. Pure and Intl-free.
 */
import type { IsoDate } from '#lib/domain/calendar.ts';
import type { LoadType } from '#lib/domain/training/vocabulary.ts';
import { formatDuration, formatWeight } from '#lib/domain/units.ts';
import type { KitSet, LoggedSet, PrescribedWeight } from '#lib/domain/workout/index.ts';
import type { PlannedSet } from '#lib/domain/workout/selectors.ts';

/**
 * What a load type tells the owner when the plan gives no weight (the M4 plan's open question 23,
 * load types): a bodyweight exercise may take added weight, and an assisted one logs its help,
 * where less help is harder. External loads say nothing here: their weight is the prescribed one
 * or the baseline instruction, never an invented number. Change the words here.
 */
export const LOAD_NOTE: Readonly<Partial<Record<LoadType, string>>> = {
	bodyweight: 'Bodyweight · add weight if you like',
	assisted: 'Assistance · less is harder'
};

/** A set row's state, each shown in words, never by colour alone. */
export type SetRowState =
	'todo' | 'current' | 'done' | 'skipped' | 'extra' | 'missed' | 'not-saved';

/** Each state in words; a set with missed reps says how many: '2 missed'. */
export const SET_STATE_WORDS: Readonly<Record<Exclude<SetRowState, 'missed'>, string>> = {
	todo: 'To do',
	current: 'Now',
	done: 'Done',
	skipped: 'Skipped',
	extra: 'Extra set',
	'not-saved': 'Not saved on this device'
};

const amount = (reps: number | null, seconds: number | null, metres: number | null) =>
	reps !== null
		? `${reps} reps`
		: seconds !== null
			? formatDuration(seconds)
			: metres !== null
				? `${metres} m`
				: null;

/** A prescribed weight: '100 kg', or '≈ 100 kg' when it rests on an estimated 1RM. */
export const weightText = ({ value, unit, basis }: PrescribedWeight): string =>
	`${basis === 'estimated' ? '≈ ' : ''}${formatWeight(value, unit)}`;

/** What a planned set asks for: '5 reps · ≈ 100 kg', '6–10 reps · RPE 8', '0:45'. */
export function targetText(set: KitSet): string {
	const { repsMin: min, repsMax: max, prescribedWeight: weight, targetRpe } = set;
	const reps = min !== null && max !== null && min !== max ? `${min}–${max} reps` : null;
	const parts = [
		reps ?? amount(min ?? max, set.seconds, set.metres),
		weight && weightText(weight),
		targetRpe !== null ? `RPE ${targetRpe}` : null
	];
	return parts.filter(Boolean).join(' · ');
}

/** What was done: '100 kg × 5 reps · RPE 8', '8 reps', '0:45', '5 reps · 20 kg assist'. */
export function doneText(set: LoggedSet): string {
	const done = amount(set.reps, set.seconds, set.metres) ?? SET_STATE_WORDS.done;
	const load =
		set.weight !== null
			? `${formatWeight(set.weight, set.unit)} × ${done}`
			: set.assistance !== null
				? `${done} · ${formatWeight(set.assistance, set.unit)} assist`
				: done;
	return set.rpe !== null ? `${load} · RPE ${set.rpe}` : load;
}

/** A set's rest: 'Rest 2:00', 'No rest' (the next exercise follows straight on), or none given. */
export const restText = (seconds?: number | null): string | null =>
	seconds == null ? null : seconds === 0 ? 'No rest' : `Rest ${formatDuration(seconds)}`;

/**
 * The previous session's heading, counted from the workout's day: 'Last time · 7 days ago',
 * 'yesterday', 'today'. Whole calendar days between two IsoDates, so no time zone enters it.
 * Without the workout's day (a workout from another device, before its kit), 'Last time'.
 */
export function lastTimeText(date: IsoDate, today?: IsoDate): string {
	if (!today) return 'Last time';
	const days = Math.round((Date.parse(today) - Date.parse(date)) / 86_400_000);
	return `Last time · ${days < 1 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`}`;
}

/** How to load a set: its prescribed weight, else its instruction, else its load type's note. */
export type LoadLine = { kind: 'weight' | 'instruction' | 'note'; text: string };

export function loadLine(set: KitSet | undefined, loadType?: LoadType): LoadLine | null {
	if (set?.prescribedWeight) return { kind: 'weight', text: weightText(set.prescribedWeight) };
	if (set?.instruction) return { kind: 'instruction', text: set.instruction };
	const note = loadType && LOAD_NOTE[loadType];
	return note ? { kind: 'note', text: note } : null;
}

/** What ExerciseCard shows of the current exercise. */
export interface ExerciseWords {
	name: string;
	/** 'A1' in a superset; none for a straight exercise. */
	label?: string | null;
	/** 'Exercise 4 of 5'. */
	place: string;
	/** The kit's prescription lines, each once, in order (shown joined by ' · '). */
	lines: string[];
	load: LoadLine | null;
	rest: string | null;
	/** 'Last time · 7 days ago' and its sets in words; null when nothing was logged before. */
	previous: { heading: string; sets: string[] } | null;
}

export interface SetRowWords {
	setIndex: number;
	state: SetRowState;
	/** What was done once logged; what the plan asks for until then. */
	text: string;
	/** Its state in words: SET_STATE_WORDS, or '2 missed' for a set with missed reps. */
	word: string;
}

/**
 * A slot's set rows (selectors.ts's plannedVsLogged) in words. The current row is the first
 * planned set with nothing logged, unless the exercise has ended (skipped, or stopped for pain).
 * 'not-saved' is SetRow's from the start; log-set marks the sets this device could not save.
 */
export function setRows(rows: readonly PlannedSet[], ended = false): SetRowWords[] {
	const current = ended ? -1 : rows.findIndex((row) => row.planned && !row.logged);
	return rows.map(({ setIndex, planned, logged }, i) => {
		const state: SetRowState = !logged
			? i === current
				? 'current'
				: 'todo'
			: logged.isSkipped
				? 'skipped'
				: !planned || logged.isExtra
					? 'extra'
					: logged.missedReps > 0
						? 'missed'
						: 'done';
		return {
			setIndex,
			state,
			// A skipped set keeps what it asked for; its state says it was skipped.
			text: logged && !logged.isSkipped ? doneText(logged) : planned ? targetText(planned) : '',
			word: state === 'missed' ? `${logged!.missedReps} missed` : SET_STATE_WORDS[state]
		};
	});
}
