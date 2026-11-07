/**
 * A proposal in plain words (PRD §14): the card's before → after rows, its impact on the weeks it
 * touches, and the short summary lines coach_proposals.summary, the inbox and
 * get_coach_proposals show. Everything here is computed by code from the payload and the plan it
 * was made on, never written by the model.
 *
 * - Program ops are applied in order to a copy of the base version's weeks, as the edit services
 *   would apply them, so each row's 'before' is what the owner sees at that point.
 * - The impact is M3's metrics (plannedHardSets, sessionLoadOf) on each touched week, before and
 *   after: hard sets per muscle group, planned minutes, session load and run metres.
 * - Wording goes through M3's describe helpers, in the owner's units.
 * - Names, muscles and the minutes estimate arrive as data in the context: this module never
 *   imports domain/exercises or domain/programming. Interference warnings need the database, so
 *   the proposals service adds them when it creates the proposal.
 *
 * Server-only (eslint's coach rule) and pure: no clock, no I/O. It expects a proposal that has
 * passed checkProposal against the same plan; an id the context lacks throws a RangeError.
 */
import { weekdayOf, type IsoDate } from '../calendar.ts';
import {
	disciplineLabel,
	GOAL_STATUS_LABEL,
	TIME_OF_DAY_LABEL,
	WEEKDAY_INFO
} from '../profile/catalog.ts';
import type { GoalKind, Sentiment } from '../profile/catalog.ts';
import type { GoalData } from '../profile/schemas.ts';
import type { Goal, ProfileDistanceUnit } from '../profile/types.ts';
import { describePrescription, describeSegment } from '../training/describe.ts';
import {
	exerciseRefKey,
	plannedHardSets,
	sessionLoadOf,
	type ExerciseMuscles
} from '../training/metrics.ts';
import { PRESCRIPTION_LIMITS } from '../training/schemas.ts';
import type {
	BaselineLift,
	ExerciseRef,
	OtherDetails,
	OtherSessionPlan,
	PlannedExercisePlan,
	RunSegment,
	RunSessionPlan,
	SetPrescription,
	StrengthSessionPlan,
	WeekPlan
} from '../training/types.ts';
import {
	MUSCLE_GROUP_LABEL,
	MUSCLE_GROUPS,
	PHASE_LABEL,
	SET_ROLE_LABEL
} from '../training/vocabulary.ts';
import type { MuscleGroup } from '../training/vocabulary.ts';
import { cleanFloat, fromMetres, type WeightUnit } from '../units.ts';
import type { GoalOp, ProgramOp, Proposal } from './proposals.ts';
import type { SourceRef } from './sources.ts';

// ---- The context ----------------------------------------------------------------------------

/** An exercise the plan or the proposal names, with what the metrics and the words need. */
export interface DiffExercise extends ExerciseMuscles {
	id: string;
	/** The catalogue key; null for one of the owner's own (its ref is `{ customId: id }`). */
	key: string | null;
	name: string;
	baselineLift: BaselineLift | null;
	/** The owner's current like or dislike, if any. */
	sentiment?: Sentiment | null;
}

export type DiffPlannedExercise = PlannedExercisePlan & { lineage: string };
/** A session of the base version by lineage; services/programs' StoredSession fits. */
export type DiffSession = (
	| (Omit<StrengthSessionPlan, 'exercises'> & { exercises: DiffPlannedExercise[] })
	| RunSessionPlan
	| OtherSessionPlan
) & { lineage: string };
export type DiffWeek = Omit<WeekPlan, 'sessions'> & { sessions: DiffSession[] };

/** What a goal edit can change (a profile Goal fits), so its rows show each changed field. */
export type DiffGoalFields = Pick<Goal, 'kind' | 'title' | 'disciplines' | 'customDiscipline'> &
	Pick<Goal, keyof typeof GOAL_FIELD_LABEL>;
export type DiffGoal = DiffGoalFields & Pick<Goal, 'id' | 'status'>;

export interface DiffContext {
	/** The owner's local today: a never-again swap changes every session from it. */
	today: IsoDate;
	unit: WeightUnit;
	distanceUnit: ProfileDistanceUnit;
	/** The base version's weeks from today, skipped sessions left out. */
	weeks: readonly DiffWeek[];
	/** Every exercise in those weeks and every one the proposal names. */
	exercises: readonly DiffExercise[];
	/**
	 * A strength or run session's planned minutes, as the edit services work them out again
	 * (services/programming's estimate); injected so this module never imports it.
	 */
	estimateMinutes: (session: DiffSession) => number;
	/** The owner's goals, top priority first. */
	goals: readonly DiffGoal[];
	blocks: readonly { lineage: string; name: string }[];
	/** The active program, if any. */
	program: { title: string } | null;
}

// ---- Rows and impact ------------------------------------------------------------------------

/** What a row changes, so a card can group or mark it. */
export type DiffArea =
	| 'session'
	| 'exercise'
	| 'set'
	| 'segment'
	| 'details'
	| 'goal'
	| 'preference'
	| 'program'
	| 'cycle';

/** One card row: what changes, from what to what. A null side is 'nothing' (an added goal). */
export interface DiffRow {
	area: DiffArea;
	label: string;
	before: string | null;
	after: string | null;
	/** The day it concerns, if one. */
	date: IsoDate | null;
	/** What tapping the row opens (sourceAction). */
	link: SourceRef | null;
}

/** One week's change, after minus before; only weeks that change are listed. */
export interface WeekImpact {
	weekStart: IsoDate;
	hardSets: Partial<Record<MuscleGroup, number>>;
	minutes: number;
	/** Session load in AU (M1's sessionLoad). */
	load: number;
	runMetres: number;
}

export interface ProposalDiff {
	rows: DiffRow[];
	/** A week each, oldest first. */
	impact: WeekImpact[];
}

/** M3 made coach_proposals.summary NOT NULL; the first summary line fills it. */
export const SUMMARY_LINE_MAX = 200;
export const SUMMARY_LINES_MAX = 3;

/** How a swapped exercise's loads read: kept within the same baseline lift, otherwise by RPE. */
export const LOAD_WORDS = { kept: 'same loads', byRpe: 'loads set by RPE' } as const;

// ---- Words ----------------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 'Thu 12 Nov'. */
const day = (date: IsoDate) =>
	`${WEEKDAY_INFO[weekdayOf(date)].short} ${Number(date.slice(8))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;
const words = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(', ');
const distance = (metres: number, unit: ProfileDistanceUnit) =>
	metres < 1000 ? `${metres} m` : `${cleanFloat(fromMetres(metres, unit), 2)} ${unit}`;
/** '+3', '−2.5', with a real minus sign. */
const signed = (value: number) => `${value < 0 ? '−' : '+'}${cleanFloat(Math.abs(value), 1)}`;

const setWords = (set: SetPrescription, unit: WeightUnit) => {
	const w = describePrescription(set, { unit });
	return words(w.headline, w.load ?? w.basis, w.rest?.toLowerCase());
};
const segmentWords = (s: RunSegment, distanceUnit: ProfileDistanceUnit) => {
	const w = describeSegment(s, { distanceUnit });
	const line = words(w.headline, w.pace, w.target);
	return s.repeats === null ? line : `${s.repeats} × ${line}`;
};
const detailWords = ({ details }: OtherSessionPlan) =>
	details.targetRpe === null
		? `${details.durationMinutes} min`
		: `${details.durationMinutes} min @ RPE ${details.targetRpe}`;
/** A row; `date` and `link` only when it concerns a day or something the owner can open. */
const diffRow = (
	area: DiffArea,
	label: string,
	before: string | null,
	after: string | null,
	date: IsoDate | null = null,
	link: SourceRef | null = null
): DiffRow => ({ area, label, before, after, date, link });
const sessionLink = (s: DiffSession): SourceRef => ({
	type: 'session',
	id: s.lineage,
	label: s.title,
	date: s.date
});
const when = (s: Pick<DiffSession, 'date' | 'timeOfDay'>) =>
	words(
		day(s.date),
		s.timeOfDay && s.timeOfDay !== 'varies' ? TIME_OF_DAY_LABEL[s.timeOfDay] : null
	);

// ---- Applying program ops -------------------------------------------------------------------

type Strength = Extract<DiffSession, { kind: 'strength' }>;

function exercisesOf(context: DiffContext) {
	const byId = new Map(context.exercises.map((e) => [e.id, e]));
	const byRef = new Map(context.exercises.map((e) => [e.key ?? `custom:${e.id}`, e]));
	const find = <K>(map: Map<K, DiffExercise>, id: K) => {
		const found = map.get(id);
		if (!found) throw new RangeError(`No exercise '${String(id)}' in the context`);
		return found;
	};
	return {
		byId: (id: string) => find(byId, id),
		byRef: (ref: ExerciseRef) => find(byRef, exerciseRefKey(ref)),
		muscles: byRef as ReadonlyMap<string, ExerciseMuscles>
	};
}

const refOf = (e: DiffExercise): ExerciseRef => (e.key ? { key: e.key } : { customId: e.id });

/**
 * The planned exercise as `to` (services/programs/edits.ts swapped, M4's prefill for a
 * substitution): its loads stay only within the same baseline lift; otherwise every set is
 * RPE-based at its own target RPE, or the session's within set bounds.
 */
function swapIn(session: Strength, planned: DiffPlannedExercise, to: DiffExercise, keep: boolean) {
	const [low, high] = PRESCRIPTION_LIMITS.rpe;
	const sessionRpe = Math.min(high, Math.max(low, Math.round(session.targetRpe * 2) / 2));
	planned.exercise = refOf(to);
	if (keep) return;
	planned.baselineLift = to.baselineLift;
	planned.sets = planned.sets.map((set) =>
		set.loadKind === 'rpe_based'
			? set
			: {
					...set,
					loadKind: 'rpe_based',
					loadValue: null,
					loadUnit: null,
					loadBasis: null,
					reference1rm: null,
					reference1rmUnit: null,
					targetRpe: set.targetRpe ?? sessionRpe
				}
	);
}

/** What an op addresses its row by, rather than changes. */
const ADDRESS = new Set(['op', 'sessionLineage', 'plannedExerciseLineage', 'position', 'reason']);
/** The values an adjustment changes, without the ones left out. */
const given = <T>(op: object) =>
	Object.fromEntries(
		Object.entries(op).filter(([key, v]) => v !== undefined && !ADDRESS.has(key))
	) as Partial<T>;

class Plan {
	readonly weeks: DiffWeek[];
	readonly skipped = new Set<string>();
	readonly context: DiffContext;
	readonly ex: ReturnType<typeof exercisesOf>;
	constructor(context: DiffContext, ex: ReturnType<typeof exercisesOf>) {
		this.context = context;
		this.ex = ex;
		this.weeks = structuredClone(context.weeks) as DiffWeek[];
	}

	session(lineage: string): DiffSession {
		for (const week of this.weeks) {
			const found = week.sessions.find((s) => s.lineage === lineage);
			if (found) return found;
		}
		throw new RangeError(`No session '${lineage}' in the context`);
	}

	planned(lineage: string, plannedLineage: string) {
		const session = this.session(lineage);
		const planned =
			session.kind === 'strength' && session.exercises.find((e) => e.lineage === plannedLineage);
		if (!planned) throw new RangeError(`No planned exercise '${plannedLineage}'`);
		return { session: session as Strength, planned };
	}

	/** Its minutes and load worked out again, as the edit services save them. */
	retime(session: DiffSession) {
		if (session.kind === 'other') {
			session.estMinutes = session.details.durationMinutes;
			session.targetRpe = session.details.targetRpe ?? session.targetRpe;
		} else session.estMinutes = this.context.estimateMinutes(session);
		session.estLoad = sessionLoadOf(session);
	}

	apply(op: ProgramOp): DiffRow {
		const { unit, distanceUnit } = this.context;
		const session = this.session(op.sessionLineage);
		const row = (area: DiffArea, label: string, before: string, after: string) =>
			diffRow(area, label, before, after, session.date, sessionLink(session));
		switch (op.op) {
			case 'move': {
				const before = when(session);
				session.date = op.toDate;
				if (op.timeOfDay !== undefined) session.timeOfDay = op.timeOfDay;
				const after = when(session);
				return diffRow('session', session.title, before, after, op.toDate, sessionLink(session));
			}
			case 'skip':
				this.skipped.add(session.lineage);
				return row('session', session.title, when(session), 'Skipped');
			case 'swap': {
				const { planned } = this.planned(op.sessionLineage, op.plannedExerciseLineage);
				const from = this.ex.byRef(planned.exercise);
				const to = this.ex.byId(op.toExerciseId);
				const keep = planned.baselineLift !== null && planned.baselineLift === to.baselineLift;
				const fromKey = exerciseRefKey(planned.exercise);
				const all = op.scope === 'never_again' ? this.occurrences(fromKey) : [];
				for (const at of all.length ? all : [{ session: session as Strength, planned }]) {
					swapIn(at.session, at.planned, to, keep);
				}
				const label =
					op.scope === 'never_again'
						? `${from.name}, every session from ${day(this.context.today)}`
						: `Exercise in ${session.title}`;
				return row(
					'exercise',
					label,
					from.name,
					`${to.name} · ${keep ? LOAD_WORDS.kept : LOAD_WORDS.byRpe}`
				);
			}
			case 'adjust_set': {
				const { position } = op;
				const { planned } = this.planned(op.sessionLineage, op.plannedExerciseLineage);
				const before = planned.sets[position - 1];
				if (!before) throw new RangeError(`No set ${position}`);
				const after = { ...before, ...given<SetPrescription>(op) };
				planned.sets = planned.sets.with(position - 1, after);
				this.retime(session);
				const label = `${this.ex.byRef(planned.exercise).name}, ${SET_ROLE_LABEL[before.role].toLowerCase()}`;
				return row('set', label, setWords(before, unit), setWords(after, unit));
			}
			case 'adjust_run_segment': {
				const { position } = op;
				const before = session.kind === 'run' ? session.segments[position - 1] : undefined;
				if (session.kind !== 'run' || !before) throw new RangeError(`No segment ${position}`);
				const after = { ...before, ...given<RunSegment>(op) };
				const group = before.repeatGroup;
				session.segments = session.segments.map((s, k) =>
					k === position - 1
						? after
						: group !== null && s.repeatGroup === group
							? { ...s, repeats: after.repeats }
							: s
				);
				this.retime(session);
				const label = `${session.title}, segment ${position}`;
				return row(
					'segment',
					label,
					segmentWords(before, distanceUnit),
					segmentWords(after, distanceUnit)
				);
			}
			case 'adjust_details': {
				if (session.kind !== 'other') throw new RangeError('No session details');
				const before = detailWords(session);
				session.details = { ...session.details, ...given<OtherDetails>(op) };
				this.retime(session);
				return row('details', session.title, before, detailWords(session));
			}
		}
	}

	/** Every planned `key` from today on (NEVER_AGAIN_REPLACES_UPCOMING in the edit service). */
	occurrences(key: string) {
		return this.weeks.flatMap((week) =>
			week.sessions.flatMap((session) =>
				session.kind === 'strength' && session.date >= this.context.today
					? session.exercises
							.filter((planned) => exerciseRefKey(planned.exercise) === key)
							.map((planned) => ({ session, planned }))
					: []
			)
		);
	}
}

// ---- Impact ---------------------------------------------------------------------------------

function weekMetrics(
	week: DiffWeek,
	skipped: ReadonlySet<string>,
	muscles: ReadonlyMap<string, ExerciseMuscles>
) {
	const sessions = week.sessions.filter((s) => !skipped.has(s.lineage));
	const sum = (value: (s: DiffSession) => number) => sessions.reduce((t, s) => t + value(s), 0);
	return {
		groups: plannedHardSets({ ...week, sessions }, muscles).groups,
		minutes: sum((s) => s.estMinutes),
		load: sum((s) => sessionLoadOf(s)),
		runMetres: sum((s) =>
			s.kind === 'run'
				? s.segments.reduce((t, g) => t + (g.distanceMetres ?? 0) * (g.repeats ?? 1), 0)
				: 0
		)
	};
}

function impactOf(context: DiffContext, plan: Plan, muscles: ReadonlyMap<string, ExerciseMuscles>) {
	return context.weeks.flatMap((week, i): WeekImpact[] => {
		const before = weekMetrics(week, new Set(), muscles);
		const after = weekMetrics(plan.weeks[i]!, plan.skipped, muscles);
		const hardSets: WeekImpact['hardSets'] = {};
		for (const group of MUSCLE_GROUPS) {
			const delta = cleanFloat((after.groups[group] ?? 0) - (before.groups[group] ?? 0));
			if (delta !== 0) hardSets[group] = delta;
		}
		const impact = {
			weekStart: week.startsOn,
			hardSets,
			minutes: after.minutes - before.minutes,
			load: cleanFloat(after.load - before.load),
			runMetres: after.runMetres - before.runMetres
		};
		const changed =
			Object.keys(hardSets).length || impact.minutes || impact.load || impact.runMetres;
		return changed ? [impact] : [];
	});
}

/** The impact, a line a week: 'Week of Mon 9 Nov: Quads −3 hard sets, −45 min, load −320'. */
export function describeImpact(
	weeks: readonly WeekImpact[],
	{ distanceUnit }: { distanceUnit: ProfileDistanceUnit }
): string[] {
	return weeks.map((w) => {
		const sets = MUSCLE_GROUPS.filter((g) => w.hardSets[g] !== undefined).map(
			(g) => `${MUSCLE_GROUP_LABEL[g]} ${signed(w.hardSets[g]!)} hard sets`
		);
		const run = Math.abs(w.runMetres);
		return `Week of ${day(w.weekStart)}: ${words(
			...sets,
			w.minutes ? `${signed(w.minutes)} min` : null,
			w.load ? `load ${signed(w.load)}` : null,
			run ? `running ${w.runMetres < 0 ? '−' : '+'}${distance(run, distanceUnit)}` : null
		)}`;
	});
}

// ---- Other kinds ----------------------------------------------------------------------------

/** A goal edit's row per field it changes, in this order; title, kind and disciplines lead. */
const GOAL_FIELD_LABEL = {
	eventType: 'event',
	eventDate: 'event date',
	weightClass: 'weight class',
	targetPerformance: 'target',
	requirements: 'requirements',
	focus: 'focus',
	measure: 'measure',
	targetDate: 'target date',
	notes: 'notes'
} as const;
const GOAL_KIND_LABEL: Record<GoalKind, string> = { event: 'Event', general: 'General goal' };
/** A field the goal leaves empty. */
export const NO_VALUE = 'None';

/** The fields an edited goal saves, as the goal service writes them (goalColumns). */
const editedFields = (g: GoalData): DiffGoalFields => ({
	...{ eventType: null, eventDate: null, weightClass: null, targetPerformance: null },
	...{ requirements: null, focus: null, measure: null, targetDate: null },
	...g,
	customDiscipline: g.disciplines.includes('custom') ? g.customDiscipline : null
});

/** '1 Mar 2027'. */
const fullDate = (date: string) =>
	`${Number(date.slice(8))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;

function goalFieldWords(g: DiffGoalFields): [string, string][] {
	return [
		['title', g.title],
		['kind', GOAL_KIND_LABEL[g.kind]],
		['disciplines', g.disciplines.map((d) => disciplineLabel(d, g.customDiscipline)).join(', ')],
		...Object.entries(GOAL_FIELD_LABEL).map(([key, label]): [string, string] => {
			const value = g[key as keyof typeof GOAL_FIELD_LABEL];
			return [label, !value ? NO_VALUE : key.endsWith('Date') ? fullDate(value) : value];
		})
	];
}

function goalRows(ops: readonly GoalOp[], context: DiffContext): DiffRow[] {
	const goal = (id: string) => {
		const found = context.goals.find((g) => g.id === id);
		if (!found) throw new RangeError(`No goal '${id}' in the context`);
		return found;
	};
	const row = (label: string, before: string | null, after: string, id?: string) =>
		diffRow('goal', label, before, after, null, id ? { type: 'goal', id, label: goal(id).title } : null);
	const ranked = (ids: readonly string[]) =>
		ids.map((id, i) => `${i + 1}. ${goal(id).title}`).join(' · ');
	return ops.flatMap((op) => {
		switch (op.op) {
			case 'add':
				return row('New goal', null, op.goal.title);
			case 'edit': {
				const g = goal(op.goalId);
				const after = goalFieldWords(editedFields(op.goal));
				// A status left out is kept (the goal service's changeGoal).
				const status = op.goal.status ?? g.status;
				const changed = [
					...goalFieldWords(g).map(([field, before], i) => [field, before, after[i]![1]]),
					['status', GOAL_STATUS_LABEL[g.status], GOAL_STATUS_LABEL[status]]
				].filter(([, before, next]) => before !== next);
				if (!changed.length) return row(g.title, g.title, g.title, op.goalId);
				return changed.map(([field, before, next]) =>
					row(`${g.title}, ${field}`, before!, next!, op.goalId)
				);
			}
			case 'set_status': {
				const g = goal(op.goalId);
				return row(g.title, GOAL_STATUS_LABEL[g.status], GOAL_STATUS_LABEL[op.status], op.goalId);
			}
			case 'reorder': {
				const open = context.goals.filter((g) => op.ids.includes(g.id)).map((g) => g.id);
				return row('Goal priority', ranked(open), ranked(op.ids));
			}
		}
	});
}

const SENTIMENT_WORDS: Record<Sentiment, string> = { like: 'Like', dislike: 'Dislike' };

function cycleRows(
	p: Extract<Proposal, { kind: 'next_cycle' }>['payload'],
	context: DiffContext,
	ex: ReturnType<typeof exercisesOf>
) {
	const block = context.blocks.find((b) => b.lineage === p.fromBlockLineage);
	if (!block) throw new RangeError(`No block '${p.fromBlockLineage}' in the context`);
	const row = (label: string, after: string, before: string | null = null) =>
		diffRow('cycle', label, before, after);
	const t = p.targets;
	const { distanceUnit } = context;
	return [
		row(
			'Next block',
			`${PHASE_LABEL[p.phase]}, ${p.weeks} ${p.weeks === 1 ? 'week' : 'weeks'}`,
			block.name
		),
		row('Focus', p.focus),
		...(p.emphasis.length
			? [row('Emphasis', p.emphasis.map((g) => MUSCLE_GROUP_LABEL[g]).join(', '))]
			: []),
		row(
			'Targets',
			`RPE cap ${t.rpeCap}, volume ×${t.volumeFactor}, loads ${signed(t.loadStep * 100)} % a week, running ×${t.runVolumeFactor}`
		),
		...p.rotation.map((r) =>
			row('Rotate', ex.byId(r.toExerciseId).name, ex.byId(r.fromExerciseId).name)
		),
		...(p.running
			? [
					row(
						'Running',
						words(
							p.running.weeklyMetres === null
								? null
								: `${distance(p.running.weeklyMetres, distanceUnit)} a week`,
							p.running.longRunMetres === null
								? null
								: `long run ${distance(p.running.longRunMetres, distanceUnit)}`
						) || 'As planned'
					)
				]
			: []),
		...(p.ending === 'none'
			? []
			: [row('Ends with', p.ending === 'deload' ? 'A deload week' : 'A taper')]),
		...p.constraints.map((c) => row('Keep', c))
	];
}

// ---- The proposal ---------------------------------------------------------------------------

/** The proposal as card rows, and its impact on each week it changes. */
export function describeProposal(proposal: Proposal, context: DiffContext): ProposalDiff {
	const ex = exercisesOf(context);
	switch (proposal.kind) {
		case 'program_adjustment':
		case 'workout_update': {
			const plan = new Plan(context, ex);
			const rows = proposal.payload.ops.map((op) => plan.apply(op));
			return { rows, impact: impactOf(context, plan, ex.muscles) };
		}
		case 'session_substitution': {
			const p = proposal.payload;
			const plan = new Plan(context, ex);
			const { session, planned } = plan.planned(p.sessionLineage, p.plannedExerciseLineage);
			const from = ex.byId(p.fromExerciseId);
			const to = ex.byId(p.toExerciseId);
			swapIn(session, planned, to, false);
			const row = diffRow(
				'exercise',
				`${session.title}, this session only`,
				from.name,
				`${to.name} · ${LOAD_WORDS.byRpe}`,
				session.date,
				sessionLink(session)
			);
			return { rows: [row], impact: impactOf(context, plan, ex.muscles) };
		}
		case 'new_program': {
			const p = proposal.payload;
			return {
				rows: [
					diffRow('program', 'Program', context.program?.title ?? null, 'A new program'),
					diffRow('program', 'First session', null, day(p.firstPlannedDay), p.firstPlannedDay)
				],
				impact: []
			};
		}
		case 'next_cycle':
			return { rows: cycleRows(proposal.payload, context, ex), impact: [] };
		case 'goal_update':
			return { rows: goalRows(proposal.payload.ops, context), impact: [] };
		case 'preference_update': {
			const p = proposal.payload;
			const exercise = ex.byId(p.exerciseId);
			const before = exercise.sentiment ? SENTIMENT_WORDS[exercise.sentiment] : 'No preference';
			const link: SourceRef = { type: 'exercise', id: exercise.id, label: exercise.name };
			const row = diffRow(
				'preference',
				exercise.name,
				before,
				SENTIMENT_WORDS[p.sentiment],
				null,
				link
			);
			return { rows: [row], impact: [] };
		}
	}
}

/** A line no longer than SUMMARY_LINE_MAX, cut at a word with an ellipsis. */
function clip(line: string): string {
	if (line.length <= SUMMARY_LINE_MAX) return line;
	const cut = line.slice(0, SUMMARY_LINE_MAX - 1);
	const space = cut.lastIndexOf(' ');
	return `${(space > SUMMARY_LINE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const rowLine = (row: DiffRow) =>
	`${row.label}: ${row.before === null ? '' : `${row.before} → `}${row.after ?? ''}`;

/**
 * Up to SUMMARY_LINES_MAX short lines: the first row (and how many more there are), then the
 * impact, or the next rows when nothing is measured. The first fills coach_proposals.summary.
 */
export function summaryLines(proposal: Proposal, context: DiffContext): string[] {
	const { rows, impact } = describeProposal(proposal, context);
	const [first, ...rest] = rows;
	const more = rest.length
		? ` (+${rest.length} more ${rest.length === 1 ? 'change' : 'changes'})`
		: '';
	const head = first ? `${rowLine(first)}${more}` : proposal.title;
	const tail = impact.length ? describeImpact(impact, context) : rest.map(rowLine);
	return [head, ...tail].slice(0, SUMMARY_LINES_MAX).map(clip);
}
