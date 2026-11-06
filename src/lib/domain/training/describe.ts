/**
 * Plans in plain words (PRD §5, §7): what Train, Today, History and the coach (M5) show for a set
 * prescription, a run segment and a session. The copy is product voice and all of it lives
 * here, so the wording and the load rounding never drift between screens.
 *
 * - It never invents a number. A load is shown only when it can be computed: an absolute load,
 *   or a fraction of a 1RM that is known. An estimated 1RM is never called measured.
 * - It reuses M1's units and redefines none: roundToIncrement to DEFAULT_LOAD_INCREMENT and
 *   formatWeight for loads, formatDuration for rests and times, convertPace and paceSecondsPer
 *   for paces, fromMetres for distances.
 * - A field kept in minutes reads '45 min'; one kept in seconds reads as a clock, 'Rest 1:30'.
 * - It ships in Train's and Today's initial JavaScript: it stays small, imports only domain
 *   modules and uses no Intl of its own.
 */
import { TIME_OF_DAY_LABEL } from '../profile/catalog.ts';
import type { ProfileDistanceUnit } from '../profile/types.ts';
import {
	cleanFloat,
	convertPace,
	convertWeight,
	DEFAULT_LOAD_INCREMENT,
	formatDuration,
	formatWeight,
	fromMetres,
	paceSecondsPer,
	roundToIncrement
} from '../units.ts';
import type { WeightUnit } from '../units.ts';
import type {
	ExerciseRef,
	OtherDetails,
	OtherSessionPlan,
	PlannedExercisePlan,
	RunSegment,
	RunSessionPlan,
	SetPrescription,
	StrengthSessionPlan
} from './types.ts';
import { RUN_SEGMENT_KIND_LABEL, SESSION_TYPE_LABEL } from './vocabulary.ts';
import type { OtherSessionKind } from './vocabulary.ts';

/** The parts that apply, joined; '' when none does. */
const join = (separator: string, parts: readonly (string | null)[]) =>
	parts.filter((part) => part !== null).join(separator);

// ---- Strength prescriptions -----------------------------------------------------------------

/** What a baseline set asks the owner to log; exported so the generator's instructions agree. */
export const BASELINE_INSTRUCTION =
	'Record the weight, reps and RPE you reach, so your 1RM can be estimated.';

/** What a relative load is a fraction of. Only a measured 1RM is ever called measured. */
const FRACTION_OF = {
	measured: 'your measured 1RM',
	estimated: 'your estimated 1RM',
	e1rm: 'your week-1 estimate'
} as const;

export interface PrescriptionOptions {
	/** The owner's weight unit: every load reads in it. */
	unit: WeightUnit;
	/**
	 * The baseline lift's latest estimated 1RM in kg, from logged sets: what a from_e1rm load is
	 * a fraction of. A percent_1rm load always uses its own 1RM snapshot, so no later number can
	 * pass for the 1RM it was planned from.
	 */
	oneRepMaxKg?: number | null;
}

/** One set prescription in words; a part that does not apply is null. */
export interface PrescriptionWords {
	/** '3 × 5 @ RPE 7', '3 × 8–12', '3 × 0:45'; a baseline set: 'Work up to a set of 5 @ RPE 7'. */
	headline: string;
	/** The load in the owner's unit, '125 kg', only when it can be computed. */
	load: string | null;
	/** What a relative load is a fraction of: '70 % of your measured 1RM'. */
	basis: string | null;
	/** 'Rest 2:00', or 'No rest' when the next exercise follows straight on. */
	rest: string | null;
	tempo: string | null;
	/** BASELINE_INSTRUCTION, on a baseline set. */
	instruction: string | null;
}

/**
 * A baseline set works up to a target RPE with no load given: its weight, reps and RPE give the
 * estimated 1RM that later sets are a fraction of (week 1, when a lift's 1RM is unknown).
 */
const isBaseline = (p: SetPrescription) =>
	p.loadKind === 'rpe_based' && (p.role === 'top' || p.role === 'ramp') && p.repsMin !== null;

/**
 * The load in the owner's unit, or null when it cannot be computed: an RPE-based set, a
 * from_e1rm set with no estimate yet, or a row missing what its kind needs. A computed load is
 * rounded to the owner's plates; an absolute load already in the owner's unit stays as given.
 */
export function prescribedLoad(
	p: SetPrescription,
	{ unit, oneRepMaxKg }: PrescriptionOptions
): number | null {
	const plates = (value: number, from: WeightUnit) =>
		roundToIncrement(convertWeight(value, from, unit), DEFAULT_LOAD_INCREMENT[unit]);
	const value = p.loadValue;
	if (value === null) return null;
	switch (p.loadKind) {
		case 'absolute':
			if (p.loadUnit === null) return null;
			return p.loadUnit === unit ? value : plates(value, p.loadUnit);
		case 'percent_1rm':
			if (p.reference1rm === null || p.reference1rmUnit === null) return null;
			return plates(value * p.reference1rm, p.reference1rmUnit);
		case 'from_e1rm': {
			const e1rm = oneRepMaxKg ?? Number.NaN;
			return Number.isFinite(e1rm) && e1rm > 0 ? plates(value * e1rm, 'kg') : null;
		}
		case 'rpe_based':
			return null;
	}
}

function basisOf(p: SetPrescription): string | null {
	if (p.loadValue === null || (p.loadKind !== 'percent_1rm' && p.loadKind !== 'from_e1rm')) {
		return null;
	}
	const of =
		p.loadKind === 'from_e1rm'
			? FRACTION_OF.e1rm
			: p.loadBasis === 'measured'
				? FRACTION_OF.measured
				: FRACTION_OF.estimated;
	return `${cleanFloat(p.loadValue * 100, 1)} % of ${of}`;
}

/** What one set counts: reps (a range low to high), a held time or a distance. */
function amount(p: SetPrescription): string {
	if (p.seconds !== null) return formatDuration(p.seconds);
	if (p.metres !== null) return `${p.metres} m`;
	const [min, max] = [p.repsMin ?? p.repsMax, p.repsMax ?? p.repsMin];
	return min === max ? `${min}` : `${min}–${max}`;
}

export function describePrescription(
	p: SetPrescription,
	options: PrescriptionOptions
): PrescriptionWords {
	const rpe = p.targetRpe === null ? '' : ` @ RPE ${p.targetRpe}`;
	const baseline = isBaseline(p);
	const load = prescribedLoad(p, options);
	const rest = p.restSeconds;
	return {
		headline: baseline
			? `Work up to ${p.sets === 1 ? 'a set' : `${p.sets} sets`} of ${amount(p)}${rpe}`
			: `${p.sets} × ${amount(p)}${rpe}`,
		load: load === null ? null : formatWeight(load, options.unit),
		basis: basisOf(p),
		rest: rest === null ? null : rest === 0 ? 'No rest' : `Rest ${formatDuration(rest)}`,
		tempo: p.tempo === null ? null : `Tempo ${p.tempo}`,
		instruction: baseline ? BASELINE_INSTRUCTION : null
	};
}

// ---- Runs -----------------------------------------------------------------------------------

export interface DistanceOptions {
	/** The owner's distance unit: paces, and distances of a kilometre or more, read in it. */
	distanceUnit: ProfileDistanceUnit;
}

export interface SegmentWords {
	/** Its kind and size: 'Warm-up 10:00', 'Interval 400 m', 'Tempo 5 km in 22:30'. */
	headline: string;
	/** The target pace, '3:45–4:00 /km', or the pace a distance in a time implies. */
	pace: string | null;
	/** The effort to hold: 'HR zone 2', 'RPE 3', or both. */
	target: string | null;
}

/** A segment, or a repeat group's segments, as one step of the run. */
export interface RunStep {
	/** How many times its segments run: a repeat group's repeats, otherwise 1. */
	repeats: number;
	/** The step in one line: 'Warm-up 10:00', '6 × (Interval 400 m + Recovery 1:30)'. */
	headline: string;
	segments: SegmentWords[];
}

/** A distance in the owner's unit; under a kilometre it reads in metres, as track reps do. */
const distance = (metres: number, unit: ProfileDistanceUnit) =>
	metres < 1000 ? `${metres} m` : `${cleanFloat(fromMetres(metres, unit), 2)} ${unit}`;

function paceOf(s: RunSegment, unit: ProfileDistanceUnit): string | null {
	const clock = (secondsPerKm: number) => formatDuration(convertPace(secondsPerKm, 'km', unit));
	let pace: string | null = null;
	if (s.paceMinSecondsPerKm !== null && s.paceMaxSecondsPerKm !== null) {
		const [fast, slow] = [clock(s.paceMinSecondsPerKm), clock(s.paceMaxSecondsPerKm)];
		pace = fast === slow ? fast : `${fast}–${slow}`;
	} else if (s.distanceMetres !== null && s.durationSeconds !== null) {
		const implied = paceSecondsPer(s.durationSeconds, s.distanceMetres, unit);
		pace = implied === null ? null : formatDuration(implied);
	}
	return pace === null ? null : `${pace} /${unit}`;
}

export function describeSegment(s: RunSegment, { distanceUnit }: DistanceOptions): SegmentWords {
	const size = join(' in ', [
		s.distanceMetres === null ? null : distance(s.distanceMetres, distanceUnit),
		s.durationSeconds === null ? null : formatDuration(s.durationSeconds)
	]);
	const target = join(' · ', [
		s.hrZone === null ? null : `HR zone ${s.hrZone}`,
		s.targetRpe === null ? null : `RPE ${s.targetRpe}`
	]);
	return {
		headline: join(' ', [RUN_SEGMENT_KIND_LABEL[s.kind], size || null]),
		pace: paceOf(s, distanceUnit),
		target: target || null
	};
}

/** A run's segments as steps, each repeat group's consecutive segments in one step. */
export function describeSegments(
	segments: readonly RunSegment[],
	options: DistanceOptions
): RunStep[] {
	const groups: RunSegment[][] = [];
	for (const s of segments) {
		const last = groups.at(-1);
		if (last && s.repeatGroup !== null && last[0]!.repeatGroup === s.repeatGroup) last.push(s);
		else groups.push([s]);
	}
	return groups.map((group) => {
		const words = group.map((s) => describeSegment(s, options));
		const line = words.map((w) => w.headline).join(' + ');
		const repeats = group[0]!.repeats ?? 1;
		const each = group.length > 1 ? `(${line})` : line;
		return { repeats, headline: repeats > 1 ? `${repeats} × ${each}` : line, segments: words };
	});
}

// ---- Sessions -------------------------------------------------------------------------------

/** How many exercises a strength session's line names before it counts the rest. */
export const SESSION_LINE_EXERCISES = 3;

/** An other-session format as it reads after its session type: 'Muay Thai' + 'pad work'. */
const FORMAT_WORDS: Readonly<Record<OtherSessionKind, string | null>> = {
	pad_work: 'pad work',
	sparring: 'sparring',
	technical: 'technique',
	conditioning: 'conditioning',
	class: 'class',
	mobility: 'mobility',
	strength_conditioning: 'S&C',
	custom: null
};

/** What describeSession reads: a SessionPlan, or a stored session with the same fields. */
export type SessionLineSource =
	| (Pick<StrengthSessionPlan, 'kind' | 'timeOfDay'> & {
			exercises: readonly Pick<PlannedExercisePlan, 'exercise'>[];
	  })
	| (Pick<RunSessionPlan, 'kind' | 'type' | 'timeOfDay' | 'estMinutes'> & {
			segments: readonly Pick<RunSegment, 'distanceMetres' | 'repeats'>[];
	  })
	| (Pick<OtherSessionPlan, 'kind' | 'type' | 'title' | 'timeOfDay'> & {
			details: Pick<OtherDetails, 'kind' | 'durationMinutes'>;
	  });

export interface SessionLineOptions extends DistanceOptions {
	/** An exercise's name in the owner's library: callers resolve keys and custom ids. */
	exerciseName: (ref: ExerciseRef) => string;
}

/** What the session is, before its time of day. */
function content(session: SessionLineSource, options: SessionLineOptions): string[] {
	switch (session.kind) {
		case 'strength': {
			const names = session.exercises.map((e) => options.exerciseName(e.exercise));
			const more = names.length - SESSION_LINE_EXERCISES;
			return more > 0 ? [...names.slice(0, SESSION_LINE_EXERCISES), `+${more} more`] : names;
		}
		case 'run': {
			// A run given only in distances reads in distance; any timed part makes it minutes.
			const timed = session.segments.some((s) => s.distanceMetres === null);
			const metres = session.segments.reduce(
				(sum, s) => sum + (s.distanceMetres ?? 0) * (s.repeats ?? 1),
				0
			);
			const size =
				timed || metres === 0
					? `${session.estMinutes} min`
					: distance(metres, options.distanceUnit);
			return [`${size} ${SESSION_TYPE_LABEL[session.type].toLowerCase()}`];
		}
		case 'other': {
			const type = SESSION_TYPE_LABEL[session.type];
			const format = FORMAT_WORDS[session.details.kind];
			const name =
				session.type === 'custom'
					? session.title
					: format === null || type.toLowerCase().includes(format.toLowerCase())
						? type
						: `${type} ${format}`;
			return [name, `${session.details.durationMinutes} min`];
		}
	}
}

/**
 * The session in one card line: 'Squat · Bench · Row', '45 min easy run', 'Muay Thai class ·
 * 90 min · Evening'. M2's time-of-day label ends it when the time is known, never for 'varies'.
 */
export function describeSession(session: SessionLineSource, options: SessionLineOptions): string {
	const time = session.timeOfDay;
	return join(' · ', [
		...content(session, options),
		time === null || time === 'varies' ? null : TIME_OF_DAY_LABEL[time]
	]);
}
