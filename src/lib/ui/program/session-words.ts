/**
 * What the session screen says (Train → a session): when it is, what kind of session it is, the
 * facts SessionDetails lays out, each exercise's prescriptions in describe.ts's words, and the
 * baseline callout. Like words.ts, these are composed where the session is read (the session
 * route's load, on the server), so the screen's JavaScript carries none of the vocabulary and
 * no describe.ts (docs/performance.md); the components only lay the words out.
 */
import { weekdayOf, type IsoDate } from '#lib/domain/calendar.ts';
import { TIME_OF_DAY_LABEL, WEEKDAY_INFO, type TimeOfDay } from '#lib/domain/profile/catalog.ts';
import {
	BASELINE_INSTRUCTION,
	describePrescription,
	type PrescriptionOptions,
	type PrescriptionWords
} from '#lib/domain/training/describe.ts';
import type {
	CustomMetric,
	OtherDetails,
	PlannedExercisePlan,
	SessionKind
} from '#lib/domain/training/types.ts';
import {
	OTHER_SESSION_KIND_LABEL,
	SESSION_INTENSITY_LABEL,
	SESSION_TYPE_LABEL,
	type SessionIntensity,
	type SessionType
} from '#lib/domain/training/vocabulary.ts';
import { longDate, shortDate } from './words.ts';

/** 'Tuesday 10 November · Evening'; the time of day only when known (never 'varies'). */
export function whenWords(date: IsoDate, timeOfDay: TimeOfDay | null): string {
	const time = timeOfDay === null || timeOfDay === 'varies' ? null : TIME_OF_DAY_LABEL[timeOfDay];
	return time ? `${longDate(date)} · ${time}` : longDate(date);
}

/** What disciplineWords and detailsView read: a planned session, or its fields. */
type KindSource =
	| { kind: Exclude<SessionKind, 'other'>; details?: undefined }
	| { kind: 'other'; details: OtherDetails };

/**
 * The session's type ('Strength', 'Intervals'), its own discipline for a custom one, and an
 * other session's format after it ('Muay Thai · Pad work') unless the type already says it.
 */
export function disciplineWords(
	session: KindSource & { type: SessionType; customDiscipline: string | null }
): string {
	const type =
		(session.type === 'custom' && session.customDiscipline) || SESSION_TYPE_LABEL[session.type];
	if (session.kind !== 'other' || session.details.kind === 'custom') return type;
	const format = OTHER_SESSION_KIND_LABEL[session.details.kind];
	return type.toLowerCase() === format.toLowerCase() ? type : `${type} · ${format}`;
}

/** One number SessionDetails shows as a stat: '90' and 'min', with a word under it. */
export interface Fact {
	label: string;
	value: string;
	unit: string | null;
	caption: string | null;
}

/** One of an other session's metrics in words: 'Round length', '3 min'. */
export interface MetricWords {
	label: string;
	value: string;
}

/** What SessionDetails lays out. */
export interface DetailsView {
	/** The duration, then the target RPE with the session's intensity under it. */
	facts: Fact[];
	/** An other session's metrics (rounds, sparring, focus); none for strength and runs. */
	metrics: MetricWords[];
}

/** A metric's value: a number with its unit, a yes/no in words, a text as written. */
export function metricValue({ value, unit }: CustomMetric): string {
	if (typeof value === 'boolean') return value ? 'Yes' : 'No';
	return unit === null || typeof value === 'string' ? `${value}` : `${value} ${unit}`;
}

/**
 * The session's facts: an other session's own duration and target RPE come from its details
 * (the class, not the estimate), with the session's target RPE when the details set none.
 */
export function detailsView(
	session: KindSource & { estMinutes: number; targetRpe: number; intensity: SessionIntensity }
): DetailsView {
	const own = session.kind === 'other' ? session.details : null;
	return {
		facts: [
			{
				label: 'Duration',
				value: `${own?.durationMinutes ?? session.estMinutes}`,
				unit: 'min',
				caption: null
			},
			{
				label: 'Target RPE',
				value: `${own?.targetRpe ?? session.targetRpe}`,
				unit: null,
				caption: SESSION_INTENSITY_LABEL[session.intensity]
			}
		],
		metrics: (own?.metrics ?? []).map((m) => ({ label: m.label, value: metricValue(m) }))
	};
}

/** A planned exercise with its name in the owner's library: what exerciseViews reads. */
export type ExerciseSource = Pick<
	PlannedExercisePlan,
	'superset' | 'instructions' | 'notes' | 'sets'
> & { name: string };

/** One exercise as ExerciseBlock lays it out. */
export interface ExerciseView {
	/** 'A1', 'A2' in a superset; null for straight sets. */
	label: string | null;
	name: string;
	instructions: string | null;
	notes: string | null;
	/** describePrescription's words, one per set prescription. */
	sets: PrescriptionWords[];
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * The session's exercises in order, each set prescription in the owner's unit. Supersets are
 * lettered in the order they first appear and numbered within (A1, A2, then B1).
 */
export function exerciseViews(
	exercises: readonly ExerciseSource[],
	options: PrescriptionOptions
): ExerciseView[] {
	const groups: number[] = [];
	const seen = new Map<number, number>();
	return exercises.map((e) => {
		let label: string | null = null;
		if (e.superset !== null) {
			if (!groups.includes(e.superset)) groups.push(e.superset);
			const n = (seen.get(e.superset) ?? 0) + 1;
			seen.set(e.superset, n);
			label = `${LETTERS[groups.indexOf(e.superset) % LETTERS.length]}${n}`;
		}
		return {
			label,
			name: e.name,
			instructions: e.instructions,
			notes: e.notes,
			sets: e.sets.map((p) => describePrescription(p, options))
		};
	});
}

/**
 * A baseline week's strength session (week 1): how to find each lift's starting point. It ends
 * with what every baseline set asks the owner to record (BASELINE_INSTRUCTION).
 */
export const BASELINE_CALLOUT = {
	eyebrow: 'Baseline session',
	title: 'Find your starting weights',
	lead: 'This session sets the loads for the weeks ahead: each main lift works up to a target effort, not a set weight.',
	points: [
		'Warm up, then add weight set by set until the reps land on the target RPE.',
		'Stop at the target, never at failure: at RPE 7 you could still do about three more reps.',
		BASELINE_INSTRUCTION
	]
} as const;

export type BaselineCallout = typeof BASELINE_CALLOUT;

/** A day the Move sheet offers, as a card: 'Wed 11 Nov', with what is planned there under it. */
export interface MoveOption {
	date: IsoDate;
	/** 'Wed 11 Nov'. */
	label: string;
	/** 'Wednesday': where the toast says it moved. */
	day: string;
	/** 'Easy run · Muay Thai class', or 'Rest day'. */
	planned: string;
}

/** A day a session can move to (the program services' getMoveTargets), in the sheet's words. */
export function moveOption({ date, planned }: { date: IsoDate; planned: string }): MoveOption {
	return { date, label: shortDate(date), day: WEEKDAY_INFO[weekdayOf(date)].label, planned };
}

/** What the session's edit row offers, on the version shown. */
export interface SessionEdits {
	/** The version shown: an edit names it, so one made from a page left open conflicts. */
	version: number;
	/** Why the session can no longer change (EDITS_LOCKED); null while it can. */
	locked: string | null;
	/** The days Move offers, earliest first; none when no day of its week is left. */
	moveTo: MoveOption[];
}

/** What an edit sheet opens on: the session screen's session, with its edits. */
export interface EditTarget {
	lineage: string;
	title: string;
	/** 'Monday 9 November · Morning'. */
	when: string;
	/** None on an older version, which is read-only. */
	edits: SessionEdits | null;
}

/** Why a session's edits are off, as the line under its disabled edit row says. */
export const EDITS_LOCKED = {
	completed: 'You’ve logged it, so it stays as it was.',
	skipped: 'It’s skipped, so it stays off your week.',
	passed: 'Its day has passed, so it stays as it was planned.'
} as const;
