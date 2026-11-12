/**
 * A re-plan's preview (m7-plan replan-preview; PRD §5; the replans-as-versions ADR): what a
 * directive would change, week by week, from today's profile and the training actually done, with
 * the first changed weeks judged before and after. The coach, Profile and the weekly review show
 * it, and the accept runs it again inside its own transaction to store what it shows. Imported by
 * path, like the rest of services/periodisation. Nothing is written.
 *
 * - Refused before the engine runs: no active program (no_program), or every planned week is over
 *   (block_complete: the cycle review plans the next block). The engine refuses the rest with its
 *   sentence (rules/replan.ts REFUSALS).
 * - The skeleton is taken from buildProgrammingInput on today's profile, so its fingerprint covers
 *   the profile, the directive, the base version and `from`, never the actuals: logging a set does
 *   not invalidate a proposal. A regenerating or splicing re-plan starts on replanStart's Monday,
 *   past any week with a session done, begun or skipped; a deload on its own week.
 * - The plan is generated from that input with the actuals overlaid (M6's actualsOverlay): each
 *   baseline lift's latest e1RM and the actual mileage over the program's last ACTUALS_WEEKS
 *   complete weeks, once it has one.
 * - describeChanges gives the weeks, the impact and the summary lines in the owner's units; for a
 *   deload, `ahead` lists the target week's sessions still ahead (dated today or later, not done,
 *   begun or skipped), the only ones it changes.
 * - The first SCORED_WEEKS changed weeks are judged by evaluateWeek with the evaluation context
 *   (whose reads follow the pool or savepoint rule, context.ts). Both sides are judged on the load
 *   of the days before the week, so neither carries the other's sessions. Once a context read
 *   fails (recorded), the rest is judged by checkWeek alone, with no second wait.
 * - Every read goes through deps.db, awaited in turn: given a transaction, it runs on it and never
 *   takes a second connection. Owner-scoped: another owner's program is never read.
 */
import { addDays, daysBetween, mondayOf, type IsoDate } from '../../../domain/calendar';
import { bestEfforts, longRuns, runPace, weeklyRunning } from '../../../domain/analytics/running';
import { e1rmSeries, measuredMaxes } from '../../../domain/analytics/strength';
import { catalogueByKey } from '../../../domain/exercises/index';
import { evaluateWeek, type EvaluatedSession } from '../../../domain/programming/evaluate/week';
import type { ProgrammingInput } from '../../../domain/programming/input';
import { catalogueTraits, type TraitsOf } from '../../../domain/programming/interference';
import {
	actualsOverlay,
	type OverlayAssumption,
	type ResultsSnapshot
} from '../../../domain/programming/next-block/input';
import {
	generateReplan,
	replanSkeleton,
	replanStart,
	type Replan,
	type ReplanRefusal
} from '../../../domain/programming/periodisation/replan';
import {
	describeChanges,
	type ChangeExercise,
	type WeekChange,
	type WeekImpact
} from '../../../domain/programming/replan/changes';
import type {
	ReplanMechanism,
	ReplanRefusalReason
} from '../../../domain/programming/rules/replan';
import { exerciseRefKey } from '../../../domain/training/metrics';
import type { ReplanDirective } from '../../../domain/training/replan';
import type {
	BaselineLift,
	ExerciseRef,
	ProgramPlan,
	SessionPlan
} from '../../../domain/training/types';
import type { WeekKind } from '../../../domain/training/vocabulary';
import { createProgramsRepository } from '../../db/repositories/programs';
import type { Executor } from '../../db/types';
import { getDb } from '../../db';
import { measure } from '../../observability/timing';
import { createFactsLoader } from '../analytics/facts';
import { getExercisesByIds, type ExerciseDef } from '../exercises/index';
import { getAthleteProfile } from '../profile/index';
import { programmingInputFor } from '../programs/alternatives';
import type { ProgramVersion, StoredSession } from '../programs/mapping';
import { getProgramVersion } from '../programs/index';
import { listActiveWorkouts } from '../workouts/canonical';
import {
	evaluationContext,
	weekContextOf,
	type ContextDeps,
	type EvaluationContext
} from './context';

/**
 * Decision (m7-plan replan-preview): how many changed weeks are judged before and after, the
 * first ones, where a re-plan starts to bite.
 */
export const SCORED_WEEKS = 2;

/**
 * Decision (m7-plan replan-preview): the actuals overlay reads the program's complete weeks, at
 * most this many before today's week, as the cycle review reads a four- to eight-week block.
 */
export const ACTUALS_WEEKS = 12;

/** Why a preview is refused: the engine's reasons, and the two the service finds first. */
export type PreviewRefusalReason = ReplanRefusalReason | 'no_program' | 'block_complete';

/** The service's own refusals, in the owner's words. */
export const PREVIEW_REFUSALS = {
	no_program: 'There is no plan to change yet: build one first.',
	block_complete:
		'Every planned week is behind you, so the next block comes from your cycle review instead.'
} as const satisfies Partial<Record<PreviewRefusalReason, string>>;

export interface PreviewRefusal {
	refusal: PreviewRefusalReason;
	why: string;
}

/** A changed week's evaluateWeek score (0 to 100), as planned now and after the re-plan. */
export interface WeekScore {
	weekStart: IsoDate;
	before: number;
	after: number;
}

/** A deload's session still ahead: the only kind it changes. */
export interface AheadSession {
	lineage: string;
	date: IsoDate;
	title: string;
}

export interface ReplanPreview {
	directive: ReplanDirective;
	mechanism: ReplanMechanism;
	/** The first day the new version may differ on: a Monday. */
	from: IsoDate;
	/** The current version the re-plan is made on. */
	baseVersionNumber: number;
	/** describeChanges: only the weeks that change, oldest first. */
	weeks: WeekChange[];
	impact: WeekImpact[];
	summaryLines: string[];
	/** The first SCORED_WEEKS changed weeks, judged. */
	scores: WeekScore[];
	/** The lowest of `scores` before and after; null with no week changed. */
	scoreBefore: number | null;
	scoreAfter: number | null;
	/** 'checkWeek' when the evaluation context could not be read (recorded). */
	judged: 'context' | 'checkWeek';
	/** Today's profile input, the directive, the base version and `from`: never the actuals. */
	fingerprint: string;
	/** The new plan's shape from `from`, never its loads. */
	shapeDigest: string;
	/** For a deload: the target week's sessions still ahead. */
	ahead?: AheadSession[];
	/** The new version as the engine made it, for the accept to store. */
	replan: Replan;
	/** What it was generated from: today's profile with the actuals overlaid, and each change. */
	input: ProgrammingInput;
	assumptions: OverlayAssumption[];
}

export interface PreviewDeps extends Pick<
	ContextDeps,
	'errorsDb' | 'origin' | 'reader' | 'statementTimeoutMs'
> {
	/** The pool or a caller's transaction: the app's database unless given. */
	db?: Executor;
}

const refuse = (refusal: keyof typeof PREVIEW_REFUSALS): PreviewRefusal => ({
	refusal,
	why: PREVIEW_REFUSALS[refusal]
});

/** The stored version as the engine reads a plan: its blocks, and the decisions a rule made. */
const planOf = (version: ProgramVersion): ProgramPlan => ({
	title: version.title,
	startsOn: version.startsOn,
	firstPlannedDay: version.firstPlannedDay,
	blocks: version.blocks,
	// Stored decisions name lineages, not plan paths; the engine reads only their kind and evidence.
	decisions: version.decisions.flatMap(({ kind, ruleKey, summary, why, decidedBy, evidence }) =>
		ruleKey === null ? [] : [{ kind, ruleKey, summary, why, decidedBy, evidence, refs: [] }]
	)
});

const sessionsOf = (plan: ProgramPlan, monday?: IsoDate) =>
	plan.blocks.flatMap((b) =>
		b.weeks.flatMap((w) => (monday === undefined || w.startsOn === monday ? w.sessions : []))
	);

/**
 * What the program's complete weeks showed (at most ACTUALS_WEEKS of them), as the actuals
 * overlay reads it; null before its first complete week.
 */
async function actualsOf(
	db: Executor,
	ownerId: string,
	{ today, startsOn, timeZone }: { today: IsoDate; startsOn: IsoDate; timeZone: string }
): Promise<ResultsSnapshot | null> {
	const weekStart = mondayOf(today);
	const earliest = addDays(weekStart, -7 * ACTUALS_WEEKS);
	const first = mondayOf(startsOn) > earliest ? mondayOf(startsOn) : earliest;
	if (first >= weekStart) return null;
	const facts = createFactsLoader(db, ownerId, { from: first, to: today, timeZone });
	const sets = await facts.sets();
	const ids = [...new Set(sets.map((s) => s.exercise))];
	const defs = ids.length ? await getExercisesByIds(ownerId, ids, { db }) : new Map();
	const setsOf = Map.groupBy(sets, (s) => s.exercise);
	const e1rms = [...defs.values()].flatMap((def: ExerciseDef) => {
		const last = def.baselineLift && e1rmSeries(setsOf.get(def.id) ?? [], def, timeZone).at(-1);
		return last ? [{ lift: def.baselineLift as BaselineLift, point: last }] : [];
	});
	const runs = await facts.runs();
	const window = {
		weeks: { from: first, to: addDays(weekStart, -1), count: daysBetween(first, weekStart) / 7 },
		inProgress: { weekStart, through: today, days: daysBetween(weekStart, today) + 1 }
	};
	const running = runs.length
		? {
				weeks: weeklyRunning(runs, window, 'km', timeZone).weeks.filter((w) => !w.inProgress),
				longRuns: longRuns(runs, window, timeZone),
				paces: runs.flatMap((r) => runPace(r) ?? []),
				efforts: bestEfforts(runs, await facts.races())
			}
		: null;
	const maxes = measuredMaxes(await facts.baselines());
	return { timeZone, e1rms, maxes, running };
}

/** Every exercise either plan names, by exerciseRefKey, and their traits for the judge. */
async function exercisesOf(db: Executor, ownerId: string, plans: readonly ProgramPlan[]) {
	const refs: ExerciseRef[] = plans.flatMap((p) =>
		sessionsOf(p).flatMap((s) => (s.kind === 'strength' ? s.exercises.map((e) => e.exercise) : []))
	);
	const ids = [...new Set(refs.flatMap((r) => ('customId' in r ? [r.customId] : [])))];
	const custom = ids.length ? await getExercisesByIds(ownerId, ids, { db }) : new Map();
	const lookup = new Map<string, ChangeExercise>();
	for (const ref of refs) {
		const def = 'key' in ref ? catalogueByKey.get(ref.key) : custom.get(ref.customId);
		if (def) lookup.set(exerciseRefKey(ref), def);
	}
	const traitsOf: TraitsOf = (ref) =>
		'key' in ref ? catalogueTraits(ref) : custom.get(ref.customId);
	return { lookup, traitsOf };
}

/** The context as the judge reads it for `monday`: the load before the week, and `kind`. */
function judgeContext(context: EvaluationContext, monday: IsoDate, kind: WeekKind | undefined) {
	const { week: _stored, ...rest } = weekContextOf(context);
	const days = context.load.days.filter((d) => d.date < monday);
	return { ...rest, load: { days, logged: context.load.logged }, ...(kind && { week: { kind } }) };
}

/** The first SCORED_WEEKS changed weeks judged before and after, and how. */
async function scoresOf(
	ownerId: string,
	at: { versionId: string; today: IsoDate; mondays: IsoDate[] },
	plans: { before: ProgramPlan; after: ProgramPlan },
	traitsOf: TraitsOf,
	deps: PreviewDeps & { db: Executor }
): Promise<{ scores: WeekScore[]; judged: ReplanPreview['judged'] }> {
	const { versionId, today } = at;
	const own = {
		db: deps.db,
		errorsDb: deps.errorsDb,
		origin: deps.origin,
		reader: deps.reader,
		statementTimeoutMs: deps.statementTimeoutMs
	};
	let judged: ReplanPreview['judged'] = 'context';
	const scores: WeekScore[] = [];
	for (const monday of at.mondays.slice(0, SCORED_WEEKS)) {
		const context =
			judged === 'context'
				? await evaluationContext(ownerId, { versionId, weekStartsOn: monday, today }, own)
				: null;
		if (!context) judged = 'checkWeek';
		const openDates = Array.from({ length: 7 }, (_, i) => addDays(monday, i)).filter(
			(d) => d >= today
		);
		const judge = (plan: ProgramPlan) => {
			const week = plan.blocks.flatMap((b) => b.weeks).find((w) => w.startsOn === monday);
			const sessions: readonly (SessionPlan | EvaluatedSession)[] = sessionsOf(plan, monday);
			return evaluateWeek(sessions, {
				traitsOf: context?.traitsOf ?? traitsOf,
				openDates,
				today,
				...(context && { context: judgeContext(context, monday, week?.kind) })
			}).score;
		};
		scores.push({ weekStart: monday, before: judge(plans.before), after: judge(plans.after) });
	}
	return { scores, judged };
}

/**
 * What `directive` would change in the owner's current plan on `today`, or why it cannot. Reads
 * only, one query at a time on deps.db (a caller's transaction included).
 */
export async function previewReplan(
	ownerId: string,
	{ today, directive }: { today: IsoDate; directive: ReplanDirective },
	deps: PreviewDeps = {}
): Promise<ReplanPreview | PreviewRefusal> {
	const db = deps.db ?? getDb();
	return measure('replan', async () => {
		const repo = createProgramsRepository(db);
		const found = await repo.currentProgram(ownerId);
		if (!found) return refuse('no_program');
		const number = found.version.number;
		const version = await getProgramVersion(ownerId, found.program.id, number, { db });
		const lastPlanned = version.blocks.reduce<IsoDate | null>(
			(last, b) => (!b.outline && (last === null || b.endsOn > last) ? b.endsOn : last),
			null
		);
		if (lastPlanned === null || today > lastPlanned) return refuse('block_complete');

		// The sessions from this week on that a workout began or finished, or the owner skipped.
		const stored = version.blocks.flatMap((b) => b.weeks.flatMap((w) => w.sessions));
		const recent = stored.filter((s) => s.date >= mondayOf(today));
		const done = await repo.completedLineages(
			ownerId,
			recent.map((s) => s.lineage)
		);
		const { workouts } = await listActiveWorkouts(ownerId, { db });
		const begun = new Set<string | null>(workouts.map((w) => w.plannedLineage));
		const touched = (s: StoredSession) =>
			done.has(s.lineage) || begun.has(s.lineage) || s.status === 'skipped';
		const started = recent.filter(touched);

		const profile = await getAthleteProfile(ownerId, { db });
		const base = await programmingInputFor(ownerId, { db });
		const current = planOf(version);
		const skeleton = replanSkeleton(base, {
			today,
			from: replanStart(
				today,
				started.map((s) => s.date)
			),
			current,
			directive,
			baseVersionNumber: number,
			started
		});
		if ('refusal' in skeleton) return skeleton satisfies ReplanRefusal;

		const timeZone = profile.timeZone;
		const actual = await actualsOf(db, ownerId, { today, startsOn: version.startsOn, timeZone });
		const { input, assumptions } = actual
			? actualsOverlay(base, actual)
			: { input: base, assumptions: [] };
		const replan = generateReplan(input, skeleton, { results: [], unit: profile.weightUnit });

		const exercises = await exercisesOf(db, ownerId, [current, replan.plan]);
		const { from, mechanism } = skeleton;
		const units = { unit: profile.weightUnit, distanceUnit: profile.distanceUnit };
		const changes = describeChanges(current, replan.plan, {
			units,
			from,
			exercises: exercises.lookup
		});
		const { scores, judged } = await scoresOf(
			ownerId,
			{ versionId: found.version.id, today, mondays: changes.weeks.map((w) => w.weekStart) },
			{ before: current, after: replan.plan },
			exercises.traitsOf,
			{ ...deps, db }
		);
		const lowest = (side: 'before' | 'after') =>
			scores.length ? Math.min(...scores.map((s) => s[side])) : null;
		const ahead =
			mechanism === 'in_place'
				? recent
						.filter((s) => s.date >= today && s.date <= addDays(from, 6) && s.date >= from)
						.filter((s) => !touched(s))
						.map(({ lineage, date, title }) => ({ lineage, date, title }))
				: undefined;
		return {
			directive,
			mechanism,
			from,
			baseVersionNumber: number,
			weeks: changes.weeks,
			impact: changes.impact,
			summaryLines: changes.summaryLines,
			scores,
			scoreBefore: lowest('before'),
			scoreAfter: lowest('after'),
			judged,
			fingerprint: replan.fingerprint,
			shapeDigest: replan.shapeDigest,
			...(ahead && { ahead }),
			replan,
			input,
			assumptions
		};
	});
}
