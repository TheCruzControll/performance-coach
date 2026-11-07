/**
 * Validation for the program-plan contract (./types.ts), on zod/mini. The generator checks its
 * output with programPlanSchema and createProgramFromPlan parses with it; edits and their sheets
 * reuse the part schemas; the training log's writes (m3/30, m3/35) have theirs at the end.
 * Import this file by path (servers always, browsers on demand), never through ./index.ts, so no
 * page carries zod in its initial JavaScript.
 *
 * - Each schema's output is exactly its ./types.ts type; nullable fields are given as null.
 * - Errors carry dotted paths through ../validation.ts, such as
 *   `blocks.0.weeks.0.sessions.2.exercises.0.sets.1.loadValue`.
 * - Open vocabularies are checked here, not by Postgres. The prescriptions tables' CHECKs mirror
 *   the structural rules, so a change to PRESCRIPTION_LIMITS or LOAD_NEEDS changes them too.
 */
import * as z from 'zod/mini';
import { addDays, daysBetween, mondayOf } from '../calendar.ts';
import { DISCIPLINES, EQUIPMENT, LIFTS, TIMES_OF_DAY, WEIGHT_UNITS } from '../profile/catalog.ts';
import { toMetres, type DistanceUnit } from '../units.ts';
import type { BaselineLift, ProgramPlan, SessionKind, SetPrescription } from './types.ts';
import * as v from './vocabulary.ts';

/**
 * Week 1 may begin mid-week on firstPlannedDay (the Build preview's 'This week'), the days
 * before it unplanned. This is the plan's default while the owner decides (m3-plan open
 * question 'Program start'); false requires a full Monday-to-Sunday week 1.
 */
export const PARTIAL_FIRST_WEEK = true;

/** Inclusive bounds, kept in step with the prescriptions tables' CHECKs (m3/14). */
export const PRESCRIPTION_LIMITS = {
	sets: [1, 20],
	reps: [1, 100],
	seconds: [1, 3600],
	metres: [1, 10_000],
	rpe: [5, 10],
	restSeconds: [0, 900],
	/** percent_1rm and from_e1rm loads, as a fraction of the 1RM. */
	loadFraction: [0.3, 1],
	/** Absolute loads and 1RM snapshots, bounded as M2 bounds a 1RM. */
	weight: { kg: [1, 500], lb: [2, 1100] }
} as const;
const L = PRESCRIPTION_LIMITS;

const SNAKE_CASE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const CAMEL_CASE = /^[a-z][a-zA-Z0-9]*$/;
const RULE_KEY = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
const N = '(0|[1-9]\\d*)';
const PLAN_PATH = new RegExp(
	`^blocks\\.${N}(?:\\.weeks\\.${N}(?:\\.sessions\\.${N}(?:\\.exercises\\.${N})?)?)?$`
);

// ---- building blocks ------------------------------------------------------------------------

const text = (max: number) =>
	z
		.string('Required')
		.check(z.trim(), z.minLength(1, 'Required'), z.maxLength(max, `Up to ${max} characters`));
const optText = (max: number) => z.nullable(text(max));
const between = (min: number, max: number, message: string) =>
	z.number(message).check(z.minimum(min, message), z.maximum(max, message));
const whole = (min: number, max: number, message: string) =>
	z.int(message).check(z.minimum(min, message), z.maximum(max, message));
const halves = (min: number, max: number, message: string) =>
	between(min, max, message).check(z.refine((n) => Number.isInteger(n * 2), message));
const list = <S extends z.ZodMiniType>(item: S, max: number) =>
	z.array(item).check(z.maxLength(max, `Up to ${max}`));
const uniqueList = <S extends z.ZodMiniType>(item: S, max: number) =>
	list(item, max).check(z.refine((all) => new Set(all).size === all.length, 'Each one once'));
const keyed = <S extends z.ZodMiniType>(value: S, max: number) =>
	z
		.record(z.string().check(z.regex(CAMEL_CASE), z.maxLength(40)), value)
		.check(z.refine((r) => Object.keys(r).length <= max, `Up to ${max} entries`));

const isoDate = z.iso.date('Use a real date');
const uuid = z.uuid('Unknown id');
const slug = (message: string) => z.string().check(z.regex(SNAKE_CASE, message), z.maxLength(40));
const reps = whole(...L.reps, `Reps between ${L.reps[0]} and ${L.reps[1]}`);
const sessionRpe = halves(1, 10, 'RPE between 1 and 10, in half steps');
const unit = z.enum(WEIGHT_UNITS, 'Pick kg or lb');
const BASELINE_LIFTS = LIFTS.filter((lift): lift is BaselineLift => lift !== 'custom');

type Fail = (path: PropertyKey[], message: string) => void;

/**
 * A cross-field rule: `fail` reports a problem at a path below the checked value. It runs once
 * every field has the right type, even if one is out of range, so the owner sees every problem
 * at once; with `whenValid`, only when the whole value is valid.
 */
const rules = <T>(check: (value: T, fail: Fail) => void, params?: z.core.$ZodSuperRefineParams) =>
	z.superRefine<T>((value, ctx) => {
		check(value, (path, message) => ctx.addIssue({ code: 'custom', message, path, input: value }));
	}, params);
const whenValid = { when: (payload: z.core.ParsePayload) => payload.issues.length === 0 };

/** Both ends of a range or neither, low to high. */
function checkRange(min: number | null, max: number | null, at: [string, string], fail: Fail) {
	if ((min === null) !== (max === null)) fail([min === null ? at[0] : at[1]], 'Give both ends');
	else if (min !== null && max !== null && min > max) fail([at[1]], 'The range runs low to high');
}

// ---- exercises ------------------------------------------------------------------------------

export const exerciseRefSchema = z.union(
	[z.strictObject({ key: slug('Not a catalogue key') }), z.strictObject({ customId: uuid })],
	'Pick an exercise'
);

export const customExerciseSchema = z
	.object({
		name: text(80),
		aliases: z._default(uniqueList(text(80), 10), []),
		pattern: z.enum(v.MOVEMENT_PATTERNS, 'Pick a movement pattern'),
		primaryMuscles: uniqueList(z.enum(v.MUSCLES), 6).check(z.minLength(1, 'Pick a muscle')),
		secondaryMuscles: z._default(uniqueList(z.enum(v.MUSCLES), 10), []),
		equipment: z._default(uniqueList(z.enum(EQUIPMENT), 10), []),
		substitutionGroup: z._default(z.nullable(slug('Not a substitution group')), null),
		/** The owner's own exercise is one they can already do. */
		skillLevel: z._default(z.enum(v.SKILL_LEVELS, 'Pick a skill level'), 'beginner'),
		repMin: z._default(z.nullable(reps), null),
		repMax: z._default(z.nullable(reps), null),
		defaultSeconds: z._default(z.nullable(whole(...L.seconds, 'Up to an hour')), null),
		unilateral: z._default(z.boolean(), false),
		measure: z.enum(v.MEASURES, 'Reps, time or distance?'),
		loadType: z.enum(v.LOAD_TYPES, 'Pick how it is loaded'),
		tags: z._default(uniqueList(z.enum(v.EXERCISE_TAGS), 14), []),
		disciplines: z._default(uniqueList(z.enum(DISCIPLINES), 12), [])
	})
	.check(
		rules((e, fail) => {
			if (e.secondaryMuscles.some((m) => e.primaryMuscles.includes(m))) {
				fail(['secondaryMuscles'], 'A muscle is primary or secondary, not both');
			}
			if (e.measure !== 'reps' && (e.repMin !== null || e.repMax !== null)) {
				fail(['repMin'], 'Reps are for an exercise measured in reps');
			} else checkRange(e.repMin, e.repMax, ['repMin', 'repMax'], fail);
			if (e.measure !== 'time' && e.defaultSeconds !== null) {
				fail(['defaultSeconds'], 'Seconds are for an exercise measured in time');
			}
			// The exercises table requires them, as the catalogue format does.
			if (e.measure === 'time' && e.defaultSeconds === null) {
				fail(['defaultSeconds'], 'How long is one bout or hold?');
			}
		})
	);

// ---- strength prescriptions -----------------------------------------------------------------

/** What each load kind needs, leaving every other load field null (a set_prescriptions CHECK). */
export const LOAD_NEEDS = {
	absolute: ['loadValue', 'loadUnit'],
	percent_1rm: ['loadValue', 'loadBasis', 'reference1rm', 'reference1rmUnit'],
	from_e1rm: ['loadValue'],
	rpe_based: []
} as const satisfies Record<v.LoadKind, readonly string[]>;

const MISSING = {
	loadValue: 'Enter the load',
	loadUnit: 'Pick kg or lb',
	loadBasis: 'Is the 1RM measured or estimated?',
	reference1rm: 'Which 1RM is it a percentage of?',
	reference1rmUnit: 'Pick kg or lb'
} as const;
const LOAD_FIELDS = Object.keys(MISSING) as (keyof typeof MISSING)[];

const outOfRange = (value: number, unit: keyof typeof L.weight) =>
	value < L.weight[unit][0] || value > L.weight[unit][1];

function checkLoad(p: SetPrescription, fail: Fail) {
	const needs: readonly string[] = LOAD_NEEDS[p.loadKind];
	for (const field of LOAD_FIELDS) {
		if (needs.includes(field) && p[field] === null) fail([field], MISSING[field]);
		if (!needs.includes(field) && p[field] !== null) fail([field], 'Not used by this load');
	}
	if (p.loadKind === 'rpe_based' && p.targetRpe === null) fail(['targetRpe'], 'Set an RPE');
	if (p.loadValue === null) return;
	if (p.loadKind === 'absolute' && p.loadUnit && outOfRange(p.loadValue, p.loadUnit)) {
		fail(['loadValue'], `Between ${L.weight[p.loadUnit].join(' and ')} ${p.loadUnit}`);
	}
	const [min, max] = L.loadFraction;
	const relative = p.loadKind === 'percent_1rm' || p.loadKind === 'from_e1rm';
	if (relative && (p.loadValue < min || p.loadValue > max)) {
		fail(['loadValue'], `Between ${min * 100} % and ${max * 100} % of a 1RM`);
	}
	if (
		p.reference1rm !== null &&
		p.reference1rmUnit &&
		outOfRange(p.reference1rm, p.reference1rmUnit)
	) {
		fail(['reference1rm'], 'That 1RM is out of range');
	}
}

export const setPrescriptionSchema = z
	.object({
		role: z.enum(v.SET_ROLES, 'Pick what the set is for'),
		sets: whole(...L.sets, `Between ${L.sets[0]} and ${L.sets[1]} sets`),
		repsMin: z.nullable(reps),
		repsMax: z.nullable(reps),
		seconds: z.nullable(whole(...L.seconds, 'Up to an hour')),
		metres: z.nullable(whole(...L.metres, `Up to ${L.metres[1] / 1000} km`)),
		targetRpe: z.nullable(halves(...L.rpe, `RPE ${L.rpe.join(' to ')}, in half steps`)),
		loadKind: z.enum(v.LOAD_KINDS, 'Pick how the load is set'),
		loadValue: z.nullable(z.number().check(z.positive('Above 0'))),
		loadUnit: z.nullable(unit),
		loadBasis: z.nullable(z.enum(v.LOAD_BASES, 'Measured or estimated?')),
		reference1rm: z.nullable(z.number().check(z.positive('Above 0'))),
		reference1rmUnit: z.nullable(unit),
		restSeconds: z.nullable(whole(...L.restSeconds, 'Rest up to 15 minutes')),
		tempo: z.nullable(z.string().check(z.regex(/^[0-9X]{4}$/, 'Four digits, X for explosive'))),
		notes: optText(200)
	})
	.check(
		rules((p, fail) => {
			const measures = [p.repsMin ?? p.repsMax, p.seconds, p.metres];
			const given = ['repsMin', 'seconds', 'metres'].filter((_, i) => measures[i] !== null);
			if (given.length === 0) fail(['repsMin'], 'Prescribe reps, seconds or metres');
			if (given.length > 1) fail([given[1]!], 'Reps, seconds or metres: one of them');
			checkRange(p.repsMin, p.repsMax, ['repsMin', 'repsMax'], fail);
			checkLoad(p, fail);
		})
	);

export const plannedExerciseSchema = z
	.object({
		exercise: exerciseRefSchema,
		baselineLift: z.nullable(z.enum(BASELINE_LIFTS, 'Pick a lift')),
		superset: z.nullable(whole(1, 10, 'Superset 1 to 10')),
		substitutedFrom: z.nullable(exerciseRefSchema),
		substitutionReason: z.nullable(z.enum(v.SUBSTITUTION_REASONS, 'Pick a reason')),
		instructions: optText(500),
		notes: optText(300),
		sets: list(setPrescriptionSchema, 10).check(z.minLength(1, 'Prescribe a set'))
	})
	.check(
		rules((e, fail) => {
			if ((e.substitutedFrom === null) !== (e.substitutionReason === null)) {
				fail(['substitutionReason'], 'A substitution names what it replaced and why');
			}
			const relative = e.sets.some(
				(s) => s.loadKind === 'percent_1rm' || s.loadKind === 'from_e1rm'
			);
			if (relative && e.baselineLift === null) {
				fail(['baselineLift'], 'Name the lift whose 1RM the percentage is of');
			}
		})
	);

// ---- runs and other sessions ----------------------------------------------------------------

const pace = z.nullable(whole(120, 1500, 'Pace between 2:00 and 25:00 per km'));

export const runSegmentSchema = z
	.object({
		kind: z.enum(v.RUN_SEGMENT_KINDS, 'Pick a segment type'),
		repeatGroup: z.nullable(whole(1, 20, 'Repeat group 1 to 20')),
		repeats: z.nullable(whole(2, 50, 'Repeats between 2 and 50')),
		distanceMetres: z.nullable(whole(1, 100_000, 'Up to 100 km')),
		durationSeconds: z.nullable(whole(1, 6 * 3600, 'Up to 6 hours')),
		paceMinSecondsPerKm: pace,
		paceMaxSecondsPerKm: pace,
		hrZone: z.nullable(z.literal([1, 2, 3, 4, 5], 'Heart-rate zone 1 to 5')),
		targetRpe: z.nullable(sessionRpe)
	})
	.check(
		rules((s, fail) => {
			if (s.distanceMetres === null && s.durationSeconds === null) {
				fail(['distanceMetres'], 'Give a distance or a duration');
			}
			if ((s.repeatGroup === null) !== (s.repeats === null)) {
				fail([s.repeats === null ? 'repeats' : 'repeatGroup'], 'Repeats come with a group');
			}
			const range: [string, string] = ['paceMinSecondsPerKm', 'paceMaxSecondsPerKm'];
			checkRange(s.paceMinSecondsPerKm, s.paceMaxSecondsPerKm, range, fail);
		})
	);

/** A run's segments in order: a repeat group's segments sit together and repeat alike. */
export const runSegmentsSchema = list(runSegmentSchema, 40).check(
	z.minLength(1, 'A run needs a segment'),
	rules((segments, fail) =>
		segments.forEach((s, k) => {
			const first = segments.findIndex((o) => o.repeatGroup === s.repeatGroup);
			if (s.repeatGroup === null) return;
			if (k > first && segments[k - 1]!.repeatGroup !== s.repeatGroup) {
				fail([k, 'repeatGroup'], 'Keep a repeat group’s segments together');
			} else if (segments[first]!.repeats !== s.repeats) {
				fail([k, 'repeats'], 'A repeat group’s segments repeat alike');
			}
		})
	)
);

const metricSchema = z.object({
	key: slug('Use a snake_case key'),
	label: text(40),
	unit: optText(12),
	value: z.union([z.number(), text(80), z.boolean()], 'A number, a short text or yes/no')
});

export const customMetricsSchema = list(metricSchema, 20).check(
	rules((metrics, fail) =>
		metrics.forEach((m, i) => {
			if (metrics.findIndex((o) => o.key === m.key) < i) fail([i, 'key'], 'Each metric once');
		})
	)
);

export const otherDetailsSchema = z.object({
	kind: z.enum(v.OTHER_SESSION_KINDS, 'Pick a session type'),
	durationMinutes: whole(10, 300, 'Between 10 and 300 minutes'),
	targetRpe: z.nullable(sessionRpe),
	metrics: customMetricsSchema,
	notes: optText(300)
});

// ---- sessions -------------------------------------------------------------------------------

const sessionBase = {
	date: isoDate,
	timeOfDay: z.nullable(z.enum(TIMES_OF_DAY, 'Pick a time')),
	orderInDay: whole(1, 4, 'Up to four sessions a day'),
	type: z.enum(v.SESSION_TYPES, 'Pick a session type'),
	title: text(60),
	discipline: z.enum(DISCIPLINES, 'Pick a discipline'),
	customDiscipline: optText(40),
	intensity: z.enum(v.SESSION_INTENSITIES, 'Pick an intensity'),
	estMinutes: whole(5, 600, 'Between 5 and 600 minutes'),
	estLoad: between(0, 6000, 'Load between 0 and 6000'),
	targetRpe: sessionRpe,
	source: z.enum(['generator', 'commitment']),
	commitmentRef: z.nullable(uuid),
	instructions: optText(500),
	notes: optText(300)
};

const exercises = list(plannedExerciseSchema, 20).check(z.minLength(1, 'Add an exercise'));

export const sessionPlanSchema = z
	.discriminatedUnion(
		'kind',
		[
			z.object({ kind: z.literal('strength'), ...sessionBase, exercises }),
			z.object({ kind: z.literal('run'), ...sessionBase, segments: runSegmentsSchema }),
			z.object({ kind: z.literal('other'), ...sessionBase, details: otherDetailsSchema })
		],
		'Strength, run or other?'
	)
	.check(
		rules((s, fail) => {
			if ((s.source === 'commitment') !== (s.commitmentRef !== null)) {
				fail(['commitmentRef'], 'Only a commitment session names its commitment');
			}
			if ((s.discipline === 'custom') !== (s.customDiscipline !== null)) {
				fail(['customDiscipline'], 'Only a custom discipline has a name');
			}
		})
	);

// ---- the plan -------------------------------------------------------------------------------

export const decisionPlanSchema = z.object({
	kind: z.enum(v.DECISION_KINDS, 'Unknown decision kind'),
	ruleKey: z.string().check(z.regex(RULE_KEY, 'Use a dotted snake_case key'), z.maxLength(80)),
	summary: text(200),
	why: text(1000),
	decidedBy: z.enum(v.DECIDERS, 'Who decided?'),
	refs: list(z.string().check(z.regex(PLAN_PATH, 'Not a path into the plan')), 50),
	evidence: keyed(z.union([z.number(), z.string().check(z.maxLength(200)), z.boolean()]), 20)
});

const weekPlanSchema = z.object({
	kind: z.enum(v.WEEK_KINDS, 'Pick a week type'),
	startsOn: isoDate,
	endsOn: isoDate,
	targets: z.object({
		rpeCap: halves(5, 10, 'RPE cap 5 to 10, in half steps'),
		volumeFactor: between(0, 2, 'Between 0 and 2'),
		loadStep: between(-0.5, 0.5, 'Between −50 % and +50 %'),
		runVolumeFactor: between(0, 2, 'Between 0 and 2')
	}),
	sessions: list(sessionPlanSchema, 21)
});

const blockPlanSchema = z.object({
	phase: z.enum(v.PHASES, 'Pick a phase'),
	name: text(60),
	startsOn: isoDate,
	endsOn: isoDate,
	outline: z.boolean(),
	goalRefs: uniqueList(uuid, 20),
	progression: keyed(z.number(), 30),
	weeks: list(weekPlanSchema, 52)
});

/** True when `path` names a block, week, session or strength exercise the plan has. */
function resolves(plan: ProgramPlan, path: string): boolean {
	const [, b, w, s, e] = (PLAN_PATH.exec(path) ?? []).map((n) => (n ? Number(n) : undefined));
	const week = w === undefined ? undefined : plan.blocks[b!]?.weeks[w];
	const session = s === undefined ? undefined : week?.sessions[s];
	if (!plan.blocks[b ?? -1] || (w !== undefined && !week) || (s !== undefined && !session)) {
		return false;
	}
	return e === undefined || (session?.kind === 'strength' && session.exercises[e] !== undefined);
}

function checkPlan(plan: ProgramPlan, fail: Fail) {
	if (mondayOf(plan.startsOn) !== plan.startsOn) fail(['startsOn'], 'Start on a Monday');
	const offset = daysBetween(plan.startsOn, plan.firstPlannedDay);
	if (offset < 0 || offset > (PARTIAL_FIRST_WEEK ? 6 : 0)) fail(['firstPlannedDay'], 'In week 1');
	let next = plan.startsOn;
	plan.blocks.forEach((block, b) => {
		const days = daysBetween(block.startsOn, block.endsOn) + 1;
		if (block.startsOn !== next) fail(['blocks', b, 'startsOn'], `Start on ${next}`);
		if (days < 7 || days % 7) fail(['blocks', b, 'endsOn'], 'Whole weeks, ending on a Sunday');
		next = addDays(block.endsOn, 1);
		if (block.outline ? b === 0 : plan.blocks[b - 1]?.outline) {
			fail(['blocks', b, 'outline'], 'Planned blocks come first, then the outline');
		}
		if (!block.outline && !block.weeks.length) fail(['blocks', b, 'weeks'], 'Plan its weeks');
		if (block.weeks.length && block.weeks.length * 7 !== days) {
			fail(['blocks', b, 'weeks'], 'The weeks fill the block');
		}
		block.weeks.forEach((week, w) => {
			const at = (...path: PropertyKey[]) => ['blocks', b, 'weeks', w, ...path];
			const startsOn = addDays(block.startsOn, 7 * w);
			if (week.startsOn !== startsOn) fail(at('startsOn'), `Start on ${startsOn}`);
			if (week.endsOn !== addDays(week.startsOn, 6)) fail(at('endsOn'), 'End on its Sunday');
			if (block.outline && week.sessions.length) fail(at('sessions'), 'An outline has no sessions');
			week.sessions.forEach((s, i) => {
				const date = at('sessions', i, 'date');
				if (s.date < week.startsOn || s.date > week.endsOn) fail(date, 'In its week');
				else if (s.date < plan.firstPlannedDay) fail(date, 'Not before the first planned day');
				const same = week.sessions.findIndex(
					(o) => o.date === s.date && o.orderInDay === s.orderInDay
				);
				if (same < i) fail(at('sessions', i, 'orderInDay'), 'Another session has this place');
			});
		});
	});
	plan.decisions.forEach((d, n) =>
		d.refs.forEach((ref, r) => {
			if (!resolves(plan, ref)) fail(['decisions', n, 'refs', r], 'Nothing in the plan is there');
		})
	);
}

export const programPlanSchema = z
	.object({
		title: text(80),
		startsOn: isoDate,
		firstPlannedDay: isoDate,
		blocks: list(blockPlanSchema, 12).check(z.minLength(1, 'Plan a block')),
		decisions: list(decisionPlanSchema, 500)
	})
	.check(rules(checkPlan, whenValid));

// ---- the training log -----------------------------------------------------------------------

/**
 * Inclusive bounds a logged set is held to (m3/30), inside the set_records CHECKs. A weight has
 * the column's two decimals, so a replay compares equal to the stored row.
 */
export const LOG_LIMITS = {
	position: [1, 50],
	/** Completed: 0 for a missed single (1 missed). */
	reps: [0, 100],
	missedReps: [0, 50],
	seconds: [1, 86_400],
	metres: [1, 100_000],
	weight: { kg: 1000, lb: 2200 }
} as const;
const G = LOG_LIMITS;

const SESSION_KINDS = ['strength', 'run', 'other'] as const satisfies readonly SessionKind[];

/** An instant as a device sends it (toISOString), read as a Date. */
const instant = z.pipe(
	z.iso.datetime({ offset: true, message: 'Use a date and time' }),
	z.transform((value: string) => new Date(value))
);
const hundredths = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;

/** A load in the set's unit, with the weight column's two decimals. */
const load = (message: string) =>
	z.number(message).check(z.positive('Above 0'), z.refine(hundredths, 'Two decimals'));

/**
 * A set's values, all of them: what a logged set records and an edit replaces. One amount, by the
 * exercise's measure (reps, seconds or metres); the load a weight (external, or a bodyweight
 * exercise's added weight) or an assisted exercise's assistance, either optional here: which one
 * the exercise takes is checkSet's to say, once the service has the exercise. Assistance may be
 * left out (null), for callers that never log an assisted set.
 */
const setValues = {
	weight: z.nullable(load('Enter the weight')),
	assistance: z._default(z.nullable(load('Enter the assistance')), null),
	unit,
	reps: z.nullable(whole(...G.reps, `Reps between ${G.reps[0]} and ${G.reps[1]}`)),
	missedReps: whole(...G.missedReps, `Up to ${G.missedReps[1]} missed reps`),
	seconds: z.nullable(whole(...G.seconds, 'Up to a day')),
	metres: z.nullable(whole(...G.metres, `Up to ${G.metres[1] / 1000} km`)),
	rpe: z.nullable(sessionRpe),
	isWarmup: z.boolean(),
	isExtra: z.boolean(),
	isSkipped: z.boolean()
};
type SetValues = z.output<z.ZodMiniObject<typeof setValues>>;

const AMOUNTS = ['reps', 'seconds', 'metres'] as const;

function checkSetValues(s: SetValues, fail: Fail) {
	const amounts = AMOUNTS.filter((amount) => s[amount] !== null);
	if (!s.isSkipped && amounts.length === 0) fail(['reps'], 'Record reps, a time or a distance');
	if (amounts.length > 1) fail([amounts[1]!], 'Reps, a time or a distance: one of them');
	// As set_records_missed_reps_ck: missed reps only where reps are counted.
	if (s.missedReps > 0 && s.reps === null) {
		fail(['missedReps'], 'Missed reps go with the reps done');
	}
	for (const field of ['weight', 'assistance'] as const) {
		const value = s[field];
		if (value !== null && value > G.weight[s.unit]) {
			fail([field], `Up to ${G.weight[s.unit]} ${s.unit}`);
		}
	}
	// As set_records_load_ck: help is never beside a weight.
	if (s.weight !== null && s.assistance !== null) {
		fail(['assistance'], 'A weight or the assistance, not both');
	}
}

/**
 * A workout as it starts, under the device's id; a planned one names its session's row, pinned
 * as the device's kit had it. It may also name the lineage and program the kit took from that
 * row, which the service checks against it; left out, they are taken from the row.
 */
export const startWorkoutSchema = z.object({
	clientId: uuid,
	kind: z.enum(SESSION_KINDS, 'Strength, run or other?'),
	discipline: z.enum(DISCIPLINES, 'Pick a discipline'),
	sessionType: z.enum(v.SESSION_TYPES, 'Pick a session type'),
	title: text(60),
	plannedSessionId: z.nullable(uuid),
	plannedLineageId: z.optional(z.nullable(uuid)),
	programId: z.optional(z.nullable(uuid)),
	startedAt: instant
});

/** One set as performed, under the device's id, in its workout (by the workout's client id). */
export const logSetSchema = z
	.object({
		clientMutationId: uuid,
		workoutClientId: uuid,
		exerciseId: uuid,
		plannedExerciseLineageId: z.nullable(uuid),
		exercisePosition: whole(...G.position, 'Exercise 1 to 50'),
		setIndex: whole(...G.position, 'Set 1 to 50'),
		...setValues,
		performedAt: instant
	})
	.check(rules(checkSetValues));

/** An edit of a set: every value after the edit, never a difference. */
export const editSetSchema = z.object(setValues).check(rules(checkSetValues));

/** Finishing (or abandoning) a workout; a summary field left out keeps its value, null clears it. */
export const finishWorkoutSchema = z.object({
	status: z.enum(['completed', 'abandoned'], 'Completed or abandoned?'),
	finishedAt: instant,
	durationSeconds: z.optional(z.nullable(whole(1, 86_400, 'Up to a day'))),
	sessionRpe: z.optional(z.nullable(sessionRpe)),
	notes: z.optional(optText(500))
});

/**
 * An exercise swapped in a workout, under the device's id, in its slot (the exercise's 1-based
 * place, as its sets' exercisePosition; null when the caller names none): it stays on the workout.
 */
export const substitutionSchema = z
	.object({
		clientMutationId: uuid,
		workoutClientId: uuid,
		plannedExerciseLineageId: z.nullable(uuid),
		exercisePosition: z._default(z.nullable(whole(...G.position, 'Exercise 1 to 50')), null),
		fromExerciseId: uuid,
		toExerciseId: uuid,
		reason: z.enum(v.SUBSTITUTION_REASONS, 'Pick a reason')
	})
	.check(
		rules((s, fail) => {
			if (s.fromExerciseId === s.toExerciseId) fail(['toExerciseId'], 'Pick a different exercise');
		})
	);

// ---- runs, other sessions and recovery notes (m3/35) ----------------------------------------

/**
 * Inclusive bounds a logged run, other session or recovery note is held to, inside their tables'
 * CHECKs. A distance is held to `metres` once converted, whatever unit it was entered in.
 */
export const RECORD_LIMITS = {
	metres: 500_000,
	seconds: [1, 86_400],
	heartRate: [20, 250],
	segments: 100,
	otherMinutes: [1, 600],
	sleepHours: [0, 24],
	scale: [1, 5]
} as const;
const R = RECORD_LIMITS;

const DISTANCE_UNITS = ['km', 'mi', 'm'] as const satisfies readonly DistanceUnit[];
const decimals = (places: number) => (n: number) =>
	Math.abs(n * 10 ** places - Math.round(n * 10 ** places)) < 1e-6;

/** A distance as entered; the service stores it in metres through toMetres (5 mi is 8046.72). */
export const distanceSchema = z
	.object({
		value: z
			.number('Enter the distance')
			.check(z.positive('Above 0'), z.refine(decimals(3), 'Three decimals')),
		unit: z.enum(DISTANCE_UNITS, 'Pick km, mi or m')
	})
	.check(
		rules((d, fail) => {
			if (toMetres(d.value, d.unit) > R.metres) fail(['value'], `Up to ${R.metres / 1000} km`);
		})
	);

/** What a run and each of its segments record, beside the run's notes; any may wait. */
const runValues = {
	distance: z.nullable(distanceSchema),
	durationSeconds: z.nullable(whole(...R.seconds, 'Up to a day')),
	avgHr: z.nullable(whole(...R.heartRate, `Heart rate between ${R.heartRate.join(' and ')}`)),
	rpe: z.nullable(sessionRpe)
};

/** A segment's values, all of them: what it records and an edit replaces. */
const segmentValues = {
	position: whole(1, R.segments, `Segment 1 to ${R.segments}`),
	kind: z.enum(v.RUN_SEGMENT_KINDS, 'Pick a segment type'),
	...runValues
};

// As run_record_segments_measure_ck.
const measuredSegment = rules<{ distance: unknown; durationSeconds: unknown }>((s, fail) => {
	if (s.distance === null && s.durationSeconds === null) {
		fail(['distance'], 'Give a distance or a duration');
	}
});

/** One segment as run, under the device's id, at its 1-based place in the run. */
export const runSegmentLogSchema = z
	.object({ clientMutationId: uuid, ...segmentValues })
	.check(measuredSegment);

/** An edit of a segment: every value after the edit, never a difference. */
export const editRunSegmentSchema = z.object(segmentValues).check(measuredSegment);

/** A run's own values, all of them: what logRun records and editRun replaces. */
const runFields = { ...runValues, notes: optText(500) };

/**
 * A run as logged in its run workout (by the workout's client id): its own values, any of them
 * left out (null) until the run ends. Its segments may come with it (M3's form) or one at a time
 * through addRunSegment (M4's run.segment), so they may be left out too.
 */
export const logRunSchema = z.object({
	workoutClientId: uuid,
	distance: z._default(runFields.distance, null),
	durationSeconds: z._default(runFields.durationSeconds, null),
	avgHr: z._default(runFields.avgHr, null),
	rpe: z._default(runFields.rpe, null),
	notes: z._default(runFields.notes, null),
	segments: z._default(
		list(runSegmentLogSchema, R.segments).check(
			rules((segments, fail) =>
				segments.forEach((s, k) => {
					if (segments.findIndex((o) => o.position === s.position) < k) {
						fail([k, 'position'], 'Each position once');
					}
					if (segments.findIndex((o) => o.clientMutationId === s.clientMutationId) < k) {
						fail([k, 'clientMutationId'], 'Each segment once');
					}
				})
			)
		),
		[]
	)
});

/** An edit of a run's own values: every value after the edit, never a difference. */
export const editRunSchema = z.object(runFields);

/** An other session's values, all of them: what it records and an edit replaces. */
const otherValues = {
	kind: z.enum(v.OTHER_SESSION_KINDS, 'Pick a session type'),
	durationMinutes: whole(...R.otherMinutes, `Between ${R.otherMinutes.join(' and ')} minutes`),
	rpe: z.nullable(sessionRpe),
	metrics: customMetricsSchema,
	notes: optText(500)
};

/** An other session as logged in its workout: what it was, how long and hard, what was tracked. */
export const logOtherSessionSchema = z.object({ workoutClientId: uuid, ...otherValues });

/** An edit of an other session: every value after the edit, never a difference. */
export const editOtherSessionSchema = z.object(otherValues);

const scale = z.nullable(whole(...R.scale, `From ${R.scale.join(' to ')}`));

/** A recovery note's values, all of them: what it records and an edit replaces. */
const recoveryValues = {
	/** The owner's calendar day, as the device has it. */
	notedOn: isoDate,
	sleepHours: z.nullable(
		between(...R.sleepHours, `Between ${R.sleepHours.join(' and ')} hours`).check(
			z.refine(decimals(1), 'One decimal')
		)
	),
	soreness: scale,
	energy: scale,
	stress: scale,
	note: optText(1000)
};
type RecoveryValues = z.output<z.ZodMiniObject<typeof recoveryValues>>;

function checkRecovery(n: RecoveryValues, fail: Fail) {
	// As recovery_notes_content_ck: something recorded.
	if ([n.sleepHours, n.soreness, n.energy, n.stress, n.note].every((value) => value === null)) {
		fail(['sleepHours'], 'Record sleep, soreness, energy, stress or a note');
	}
}

/** How the owner felt on a day, under the device's id. Body weight stays M2's saveBody. */
export const recoveryNoteSchema = z
	.object({ clientMutationId: uuid, ...recoveryValues })
	.check(rules(checkRecovery));

/** An edit of a recovery note: every value after the edit, never a difference. */
export const editRecoveryNoteSchema = z.object(recoveryValues).check(rules(checkRecovery));
