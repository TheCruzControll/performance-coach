/**
 * Editing state for Profile → Schedule, built from what the services return: how many days and
 * how long, which days and when, and the commitments already in the week. Also the short
 * summaries the onboarding review and Today show. No Intl on purpose: formatter construction is
 * measurable hydration cost on phones (docs/performance.md).
 */
import {
	DISCIPLINES,
	TIMES_OF_DAY,
	TIME_OF_DAY_LABEL,
	WEEKDAYS,
	WEEKDAY_INFO,
	type Discipline,
	type Intensity,
	type TimeOfDay,
	type Weekday
} from '#lib/domain/profile/catalog.ts';
import type { FieldErrors, ScheduleInput } from '#lib/domain/profile/schemas.ts';
import type { Commitment, Schedule } from '#lib/domain/profile/types.ts';

/**
 * Where a schedule with nothing saved starts. The editor labels both as a suggestion; Save
 * stores them as they are shown, so keeping one is an answer the owner gave.
 */
export const SUGGESTED = { daysPerWeek: 4, sessionMinutes: 60 } as const;

/** One commitment as the editor holds it. */
export interface CommitmentDraft {
	/** Keeps each card (and anything half-typed in it) with its commitment; never posted. */
	key: string;
	/** The stored commitment this edits; null until it is saved. */
	id: string | null;
	discipline: Discipline;
	label: string;
	days: Weekday[];
	timeOfDay: TimeOfDay | null;
	durationMinutes: number | null;
	intensity: Intensity | null;
	/** Not edited on this screen, but kept, so a save never drops it. */
	notes: string | null;
}

export interface ScheduleDraft {
	/** Null until the owner has one: the editor then shows the suggestion. */
	daysPerWeek: number | null;
	availableDays: Weekday[];
	preferredTimes: TimeOfDay[];
	/** Null until the owner has one: the editor then shows the suggestion. */
	sessionMinutes: number | null;
	constraints: string | null;
	commitments: CommitmentDraft[];
}

export function commitmentDraft(c: Commitment): CommitmentDraft {
	return {
		key: c.id,
		id: c.id,
		discipline: c.discipline,
		label: c.label,
		days: [...c.days],
		timeOfDay: c.timeOfDay,
		durationMinutes: c.durationMinutes,
		intensity: c.intensity,
		notes: c.notes
	};
}

/** The saved schedule, copied: editing it never edits what the route loaded. */
export function scheduleDraft(saved: Schedule): ScheduleDraft {
	return {
		daysPerWeek: saved.daysPerWeek,
		availableDays: [...saved.availableDays],
		preferredTimes: [...saved.preferredTimes],
		sessionMinutes: saved.sessionMinutes,
		constraints: saved.constraints,
		commitments: saved.commitments.map(commitmentDraft)
	};
}

/**
 * The days a week suggested while the owner has none: four, or every available day when fewer
 * are picked, so a suggestion never asks for more sessions than the days allow.
 */
export function suggestedDays(availableDays: readonly Weekday[]): number {
	return availableDays.length
		? Math.min(SUGGESTED.daysPerWeek, availableDays.length)
		: SUGGESTED.daysPerWeek;
}

/**
 * What Save posts: the schedule as the screen shows it, suggestions included, without the
 * cards' keys. Commitments keep their places, so an error the schema reports
 * (`commitments.1.days`) lands on the card it is about.
 */
export function schedulePayload(draft: ScheduleDraft): ScheduleInput {
	return {
		daysPerWeek: draft.daysPerWeek ?? suggestedDays(draft.availableDays),
		availableDays: draft.availableDays,
		preferredTimes: draft.preferredTimes,
		sessionMinutes: draft.sessionMinutes ?? SUGGESTED.sessionMinutes,
		constraints: draft.constraints,
		commitments: draft.commitments.map((c) => ({
			id: c.id,
			discipline: c.discipline,
			label: c.label,
			days: c.days,
			timeOfDay: c.timeOfDay,
			durationMinutes: c.durationMinutes,
			intensity: c.intensity,
			notes: c.notes
		}))
	};
}

/**
 * A new, blank commitment keyed unlike every card in `commitments`. Muay Thai when it is in
 * play (classes are the usual commitment), else the first discipline in play.
 */
export function blankCommitment(
	disciplines: readonly Discipline[],
	commitments: readonly CommitmentDraft[]
): CommitmentDraft {
	let n = 1;
	while (commitments.some((c) => c.key === `new:${n}`)) n++;
	return {
		key: `new:${n}`,
		id: null,
		discipline: disciplines.includes('muay_thai') ? 'muay_thai' : (disciplines[0] ?? 'athletic'),
		label: '',
		days: [],
		timeOfDay: null,
		durationMinutes: null,
		intensity: null,
		notes: null
	};
}

/** The usual commitments (classes, club runs, team training, anything else). */
const COMMON: readonly Discipline[] = ['running', 'muay_thai', 'athletic', 'custom'];

/**
 * The disciplines a commitment can be, in catalog order: those in play, the usual ones and the
 * one it has already (which the coach may have set to anything).
 */
export function commitmentDisciplines(
	disciplines: readonly Discipline[],
	current?: Discipline
): Discipline[] {
	return DISCIPLINES.filter((d) => disciplines.includes(d) || COMMON.includes(d) || d === current);
}

/**
 * Field errors by card key. A save's errors name commitments by their place
 * (`commitments.1.days`), which means the cards as they were when the errors came back; pinned
 * to keys, they stay with their card when one above it is removed. Errors about the schedule or
 * the list as a whole are not here.
 */
export function commitmentErrors(
	errors: FieldErrors,
	commitments: readonly CommitmentDraft[]
): Record<string, FieldErrors> {
	const byKey: Record<string, FieldErrors> = {};
	for (const [path, message] of Object.entries(errors)) {
		const [, index, field] = /^commitments\.(\d+)\.(\w+)$/.exec(path) ?? [];
		const key = index === undefined ? undefined : commitments[Number(index)]?.key;
		if (key && field) (byKey[key] ??= {})[field] = message;
	}
	return byKey;
}

// ---- summaries -------------------------------------------------------------------------------

/** Days in week order, Monday first, however they were picked: "Tue, Thu" or "Every day". */
export function daysText(days: readonly Weekday[]): string {
	if (WEEKDAYS.every((d) => days.includes(d))) return 'Every day';
	return WEEKDAYS.filter((d) => days.includes(d))
		.map((d) => WEEKDAY_INFO[d].short)
		.join(', ');
}

/** "Tue, Thu · evening · 90 min · hard": what is known about a commitment. */
export function commitmentSummary(
	c: Pick<Commitment, 'days' | 'timeOfDay' | 'durationMinutes' | 'intensity'>
): string {
	return [
		daysText(c.days),
		c.timeOfDay === 'varies'
			? 'time varies'
			: c.timeOfDay && TIME_OF_DAY_LABEL[c.timeOfDay].toLowerCase(),
		c.durationMinutes && `${c.durationMinutes} min`,
		c.intensity
	]
		.filter(Boolean)
		.join(' · ');
}

/**
 * "4 days a week · 60 min sessions · morning or evening", or "Not set yet" until there are days.
 * "It varies" says no more than leaving the times out, so it is left out.
 */
export function scheduleSummary(
	s: Pick<Schedule, 'daysPerWeek' | 'sessionMinutes' | 'preferredTimes'>
): string {
	if (!s.daysPerWeek) return 'Not set yet';
	const times = TIMES_OF_DAY.filter((t) => t !== 'varies' && s.preferredTimes.includes(t));
	return [
		`${s.daysPerWeek} ${s.daysPerWeek === 1 ? 'day' : 'days'} a week`,
		s.sessionMinutes && `${s.sessionMinutes} min sessions`,
		times.map((t) => TIME_OF_DAY_LABEL[t].toLowerCase()).join(' or ')
	]
		.filter(Boolean)
		.join(' · ');
}
