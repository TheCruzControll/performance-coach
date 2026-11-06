/**
 * The session length (PRD §2, §5; m3-plan 'Session length'). The timefit stage runs last, so the
 * sets that volume (m3/22) and progression (m3/21) add are checked again in every week.
 *
 * - estimateMinutes: the warm-up, then each set's work and rest (rules/strength.ts TIME), rounded
 *   up to a whole minute. Volume adds sets only while it stays within sessionMinutes.
 * - fitSession trims an over-long strength session: accessories (isAccessory) last first, then
 *   back-off sets one at a time from the exercise with the most, then any other exercise without
 *   a top set, last first. A top set is never trimmed, so a session too short for its top sets
 *   keeps them, and its decision gives the time it still takes.
 * - fitWeek covers every generated session but those BEYOND_SESSION_LENGTH (the long run) and
 *   commitments, which keep their own length: other sessions are cut to the session length and
 *   runs are shortened part by part, in proportion.
 *
 * Pure: no clock, no randomness, no I/O.
 */
import { sessionLoadOf } from '../training/metrics.ts';
import type {
	PlannedExercisePlan,
	SessionPlan,
	StrengthSessionPlan,
	WeekPlan
} from '../training/types.ts';
import { clip } from './demand.ts';
import { toExerciseKey } from './input.ts';
import type { ProgrammingInput } from './input.ts';
import { BEYOND_SESSION_LENGTH, isAccessory, TIME } from './rules/strength.ts';
import { exerciseOf, listing } from './selection.ts';

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

export interface Fitted<S extends SessionPlan> {
	session: S;
	/** Minutes before and after; equal when nothing was trimmed. */
	estimate: number;
	after: number;
	/** What came out, read after 'so'; null when nothing did. */
	trimmed: string | null;
}

const hasTop = (e: PlannedExercisePlan) => e.sets.some((s) => s.role === 'top');
const backOffs = (e: PlannedExercisePlan) =>
	e.sets.reduce((n, s) => n + (s.role === 'back_off' ? s.sets : 0), 0);

/** The last index in `items` that `test` accepts, or -1. */
function lastIndex<T>(items: readonly T[], test: (item: T) => boolean): number {
	for (let i = items.length - 1; i >= 0; i--) if (test(items[i]!)) return i;
	return -1;
}

/** `session` trimmed to `minutes`: accessories, then back-off sets, never a top set. */
export function fitSession(
	session: StrengthSessionPlan,
	input: ProgrammingInput,
	minutes: number
): Fitted<StrengthSessionPlan> {
	const nameOf = (e: PlannedExercisePlan) =>
		exerciseOf(input, toExerciseKey(e.exercise))?.name ?? 'An exercise';
	const exercises = session.exercises.map((e) => ({ ...e, sets: e.sets.map((s) => ({ ...s })) }));
	const over = () => estimateMinutes({ exercises }, input) > minutes;
	const removed: string[] = [];
	const cut = new Map<string, number>();
	const drop = (test: (e: PlannedExercisePlan) => boolean) => {
		for (let i = lastIndex(exercises, test); over() && i >= 0; i = lastIndex(exercises, test)) {
			removed.push(nameOf(exercises.splice(i, 1)[0]!));
		}
	};

	drop((e) => {
		const exercise = exerciseOf(input, toExerciseKey(e.exercise));
		return !hasTop(e) && (!exercise || isAccessory(exercise));
	});
	while (over()) {
		const most = Math.max(0, ...exercises.map(backOffs));
		const at = lastIndex(exercises, (e) => most > 0 && backOffs(e) === most);
		if (at < 0) break;
		const sets = exercises[at]!.sets;
		const line = lastIndex(sets, (s) => s.role === 'back_off' && s.sets > 0);
		sets[line]!.sets -= 1;
		if (sets[line]!.sets === 0) sets.splice(line, 1);
		const name = nameOf(exercises[at]!);
		cut.set(name, (cut.get(name) ?? 0) + 1);
	}
	drop((e) => !hasTop(e));

	const estimate = estimateMinutes(session, input);
	const after = estimateMinutes({ exercises }, input);
	const lost = [...cut.values()].reduce((a, b) => a + b, 0);
	const parts = [
		removed.length ? `${listing(removed)} came out` : null,
		lost ? `${lost} back-off set${lost > 1 ? 's' : ''} came off ${listing([...cut.keys()])}` : null
	].filter((part) => part !== null);
	const tops = exercises.some(hasTop) ? '; every top set stays' : '';
	return {
		session: {
			...session,
			exercises,
			estMinutes: after,
			estLoad: sessionLoadOf({ estMinutes: after, targetRpe: session.targetRpe })
		},
		estimate,
		after,
		trimmed: parts.length ? `${parts.join(', and ')}${tops}` : null
	};
}

/** A session fitted to `minutes` if fitWeek covers it; any other comes back as it is. */
function fitGenerated(
	session: SessionPlan,
	input: ProgrammingInput,
	minutes: number
): Fitted<SessionPlan> {
	const length =
		session.kind === 'other'
			? Math.max(session.estMinutes, session.details.durationMinutes)
			: session.estMinutes;
	const same = { session, estimate: length, after: length, trimmed: null };
	if (session.source === 'commitment' || BEYOND_SESSION_LENGTH.includes(session.type)) return same;
	if (session.kind === 'strength') return fitSession(session, input, minutes);
	if (length <= minutes) return same;
	const part = (value: number | null) =>
		value === null ? null : Math.max(1, Math.floor((value * minutes) / length));
	const [cut, trimmed]: [SessionPlan, string] =
		session.kind === 'other'
			? [{ ...session, details: { ...session.details, durationMinutes: minutes } }, 'it is cut']
			: [
					{
						...session,
						segments: session.segments.map((s) => ({
							...s,
							distanceMetres: part(s.distanceMetres),
							durationSeconds: part(s.durationSeconds)
						}))
					},
					'every part of it is shortened alike'
				];
	const fitted = {
		...cut,
		estMinutes: minutes,
		estLoad: sessionLoadOf({ ...cut, estMinutes: minutes })
	};
	return { session: fitted, estimate: length, after: minutes, trimmed };
}

export interface Trim {
	/** The session's index in the week. */
	index: number;
	facts: { session: string; minutes: number; estimate: number; after: number; trimmed: string };
}

/** `week` with sessionMinutes applied to every session it covers, and what each trim took. */
export function fitWeek(
	week: WeekPlan,
	input: ProgrammingInput
): { week: WeekPlan; trims: Trim[] } {
	const minutes = input.sessionMinutes;
	const trims: Trim[] = [];
	const sessions = week.sessions.map((session, index) => {
		const { session: fitted, estimate, after, trimmed } = fitGenerated(session, input, minutes);
		if (trimmed)
			trims.push({
				index,
				facts: { session: session.title, minutes, estimate, after, trimmed: clip(trimmed, 200) }
			});
		return fitted;
	});
	return { week: { ...week, sessions }, trims };
}
