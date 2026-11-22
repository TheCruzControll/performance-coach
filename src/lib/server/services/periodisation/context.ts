/**
 * The context every service evaluation of a week is judged with (m7/22 evaluation-context): what
 * the owner actually did, what is still planned, the goals' effective priorities, the week's kind,
 * the events ahead and the experience level, so evaluateWeek applies every M7 rule on real data.
 * Imported by path, like the rest of services/periodisation.
 *
 * - load: M7's loadModel over the HISTORY_DAYS before the week and the week itself. Logged
 *   sessions come from M6's facts (completed, undeleted workouts only, analytics/facts.ts) up to
 *   today; planned sessions of the whole range come from M3's plannedSessionsInRange (loadModel
 *   counts those before today only when logged, names the rest missed, and judges each system
 *   against them while the logs are short). A caller's facts loader (deps.facts) is reused, so
 *   the context adds no fact query to its request.
 * - priorities: effectivePriorities over the owner's profile (M2) at the week's Monday.
 * - Every read is awaited in turn: one query at a time on whichever executor runs them.
 *
 * How the reads are bounded (the periodisation-engine ADR, 'Context loading and transactions'):
 * - On the pool, in one short read-only transaction with SET LOCAL statement_timeout.
 * - Inside a caller's transaction, in a read-only savepoint with the same SET LOCAL, always rolled
 *   back to once the reads are in memory: Postgres undoes both settings there, and a cancelled
 *   statement ends with the savepoint, so the caller's transaction carries on.
 * - A cancelled statement (57014) or any other error gives null and an app_errors row; the caller
 *   then judges the week with checkWeek alone. No JS timer ever races a query.
 */
import { sql, type SQL } from 'drizzle-orm';
import { PgTransaction } from 'drizzle-orm/pg-core';
import { addDays, type IsoDate } from '../../../domain/calendar';
import { CATALOGUE } from '../../../domain/exercises/index';
import { buildProgrammingInput } from '../../../domain/programming';
import type { ContextEvent, WeekContext } from '../../../domain/programming/evaluate/concurrent';
import { catalogueTraits, type TraitsOf } from '../../../domain/programming/interference';
import {
	loadModel,
	type FatigueDay,
	type ModelPlanned
} from '../../../domain/programming/load/fatigue';
import { fromLogged, type LoggedLoad } from '../../../domain/programming/load/from-facts';
import {
	effectivePriorities,
	type GoalPriority
} from '../../../domain/programming/priority/weights';
import type { ExperienceLevel, TimeOfDay } from '../../../domain/profile/catalog';
import type { WeekKind } from '../../../domain/training/vocabulary';
import type { AnalyticsRepository } from '../../db/repositories/analytics';
import { createProgramsRepository } from '../../db/repositories/programs';
import type { Executor } from '../../db/types';
import { getDb } from '../../db';
import { createFactsLoader, type FactsLoader } from '../analytics/facts';
import { recordServerError, type ServerErrorInput } from '../errors';
import { getExercisesByIds } from '../exercises/index';
import { getTrainingProfile } from '../profile/index';
import { toStoredSessions } from '../programs/mapping';

/**
 * Decision (m7-plan, evaluation-context): the days of history before the week the load model
 * reads, so a range is at most HISTORY_DAYS + 7 = 49 days, one query at a time.
 */
export const HISTORY_DAYS = 42;

/**
 * Decision (m7-plan, 'Context loading and transactions'): the most one statement of the context
 * may run before Postgres cancels it (SQLSTATE 57014).
 */
export const STATEMENT_TIMEOUT_MS = 300;

/** The week a context is for: the version's id, the week's Monday and the owner's today. */
export interface ContextAt {
	versionId: string;
	weekStartsOn: IsoDate;
	today: IsoDate;
}

export interface EvaluationContext {
	load: {
		/** The first day modelled: HISTORY_DAYS before the week's Monday. */
		from: IsoDate;
		/** The model, `from` through the week's Sunday. */
		days: FatigueDay[];
		/** The planned sessions it read: `from` through the week's Sunday. */
		planned: ModelPlanned[];
		/** The logged sessions it read: `from` through today (or the Sunday, for a past week). */
		logged: LoggedLoad[];
	};
	priorities: GoalPriority[];
	weekKind: WeekKind | null;
	events: ContextEvent[];
	/** The experience level in the leading goal's discipline (CONTEXT_LEVEL). */
	level: ExperienceLevel | null;
	/** The owner's preferred times, as the generator reads them: the scheduler places by them. */
	preferredTimes: TimeOfDay[];
	/** Catalogue traits, then the owner's library (their own exercises, and logged sets by id). */
	traitsOf: TraitsOf;
}

/** What a recorded failure carries: the request's id, method, path, route and app version. */
export type ErrorOrigin = Pick<
	ServerErrorInput,
	'requestId' | 'method' | 'path' | 'routeId' | 'appVersion'
>;

/** Reads a context on `db`, the bounded executor it is handed. */
export type ContextReader = (
	db: Executor,
	ownerId: string,
	at: ContextAt,
	deps: Pick<ContextDeps, 'facts' | 'repository'>
) => Promise<EvaluationContext | null>;

export interface ContextDeps {
	/** The pool or a caller's transaction: the app's database unless given. */
	db?: Executor;
	/**
	 * The request's facts loader, reused for the logged sessions: no fact query of its own. Its
	 * range must cover HISTORY_DAYS before the week's Monday through today (or the Sunday, for a
	 * past week): logged days outside it are missing from the model.
	 */
	facts?: FactsLoader;
	/** The analytics reads of a loader of its own, for a test to count or fail. */
	repository?: AnalyticsRepository;
	/** Where a failure is recorded (app_errors): `db` unless given. */
	errorsDb?: Executor;
	origin?: ErrorOrigin;
	/** The reads, for a test to stall: readContext unless given. */
	reader?: ContextReader;
	/** The statement timeout, for a test on a loaded runner to raise: STATEMENT_TIMEOUT_MS unless given. */
	statementTimeoutMs?: number;
}

/**
 * Decision (m7-plan, concurrent-load-rules' hard-day cap): the level the cap is read at is the
 * owner's experience in the leading goal's first discipline; null with no goal.
 */
export const CONTEXT_LEVEL = 'leader_discipline';

/** The leader's level (CONTEXT_LEVEL). */
const levelOf = (
	priorities: readonly GoalPriority[],
	experience: Partial<Record<string, ExperienceLevel>>
): ExperienceLevel | null => {
	const discipline = priorities[0]?.disciplines[0];
	return (discipline && experience[discipline]) ?? null;
};

/** The upcoming events of the goals that shape the week, from the week's Monday on. */
const eventsOf = (priorities: readonly GoalPriority[], monday: IsoDate): ContextEvent[] =>
	priorities.flatMap((p) =>
		p.eventKind && p.eventDate && p.eventDate >= monday
			? [{ date: p.eventDate, kind: p.eventKind, title: p.title, goalId: p.goalId }]
			: []
	);

/** The logged facts of `from`–`to` from the caller's loader, or a loader of its own on `db`. */
async function loggedFacts(
	db: Executor,
	ownerId: string,
	range: { from: IsoDate; to: IsoDate; timeZone: string },
	{ facts, repository }: Pick<ContextDeps, 'facts' | 'repository'>
) {
	const loader = facts ?? createFactsLoader(db, ownerId, range, { repository });
	const workouts = (await loader.sessions()).filter(
		(s) => s.date >= range.from && s.date <= range.to
	);
	const ids = new Set(workouts.map((w) => w.id));
	const sets = (await loader.sets()).filter((s) => ids.has(s.workoutId));
	const runs = (await loader.runs()).filter((r) => ids.has(r.workout));
	return { workouts, sets, runs, timeZone: range.timeZone };
}

/** The context's reads, one at a time on `db`: null when the version has no such week. */
export const readContext: ContextReader = async (db, ownerId, at, deps) => {
	const { versionId, weekStartsOn, today } = at;
	const from = addDays(weekStartsOn, -HISTORY_DAYS);
	const sunday = addDays(weekStartsOn, 6);
	const repo = createProgramsRepository(db);
	const week = (await repo.versionWeeks(versionId)).find((w) => w.startsOn === weekStartsOn);

	// An owner with a program has a profile row (its build read it): ensureProfile writes nothing.
	const profile = await getTrainingProfile(ownerId, { db });
	const schedule = { ...profile.schedule, daysPerWeek: profile.schedule.daysPerWeek ?? 1 };
	const input = buildProgrammingInput({ ...profile, schedule }, { catalogue: CATALOGUE });
	const priorities = effectivePriorities(input, weekStartsOn);

	// Logged: from the history's first day through today, never past the week.
	const loggedTo = today < sunday ? today : sunday;
	const facts =
		loggedTo >= from
			? await loggedFacts(
					db,
					ownerId,
					{ from, to: loggedTo, timeZone: profile.profile.timeZone },
					deps
				)
			: null;

	// Planned: the whole range, as loadModel reads it.
	const rows = await repo.plannedSessionsInRange(versionId, from, sunday);
	const children = await repo.sessionChildren(rows.map((r) => r.id));
	const planned = [...toStoredSessions({ sessions: rows, ...children }).values()];

	// The owner's library: their own planned exercises, and every logged set's exercise by id.
	const ids = [
		...planned.flatMap((s) =>
			s.kind === 'strength'
				? s.exercises.flatMap(({ exercise }) => ('customId' in exercise ? [exercise.customId] : []))
				: []
		),
		...(facts?.sets.map((s) => s.exercise) ?? [])
	];
	const library = ids.length ? await getExercisesByIds(ownerId, ids, { db }) : new Map();
	const traitsOf: TraitsOf = (ref) =>
		'key' in ref ? (catalogueTraits(ref) ?? library.get(ref.key)) : library.get(ref.customId);

	const logged = facts ? fromLogged(facts, traitsOf) : [];
	return {
		load: {
			from,
			days: loadModel({ planned, logged, from, to: sunday, today, traitsOf }),
			planned,
			logged
		},
		priorities,
		weekKind: week?.kind ?? null,
		events: eventsOf(priorities, weekStartsOn),
		level: levelOf(priorities, input.experience),
		preferredTimes: [...input.preferredTimes],
		traitsOf
	};
};

const ROLLBACK = Symbol('rollback');

/** SET LOCAL takes no parameters: the whole milliseconds, as a literal. */
const timeoutSql = (ms: number) =>
	sql.raw(`set local statement_timeout = ${Math.max(1, Math.trunc(ms))}`);

/**
 * `work` in a read-only savepoint of the caller's transaction `tx`, always rolled back to: its
 * SET LOCALs end there, and so does a cancelled statement, and the transaction carries on.
 */
async function inSavepoint<T>(
	tx: Executor,
	timeout: SQL,
	work: (db: Executor) => Promise<T>
): Promise<T> {
	let result: T | undefined;
	try {
		await tx.transaction(async (savepoint) => {
			await savepoint.execute(sql`set local transaction_read_only = on`);
			await savepoint.execute(timeout);
			result = await work(savepoint);
			throw ROLLBACK;
		});
	} catch (error) {
		if (error !== ROLLBACK) throw error;
	}
	return result as T;
}

/** `work` in one short read-only transaction on the pool. */
const inReadOnly = <T>(
	pool: Executor,
	timeout: SQL,
	work: (db: Executor) => Promise<T>
): Promise<T> =>
	pool.transaction(
		async (tx) => {
			await tx.execute(timeout);
			return work(tx);
		},
		{ accessMode: 'read only' }
	);

/** The SQLSTATE of a driver error, which drizzle wraps as its cause. */
function sqlState(error: unknown): string | undefined {
	for (let e = error; e && typeof e === 'object';) {
		const { code, cause } = e as { code?: unknown; cause?: unknown };
		if (typeof code === 'string') return code;
		e = cause;
	}
	return undefined;
}

/**
 * The context of the week `at` names, its reads bounded by Postgres (above); null when they fail
 * or are cancelled, recorded in app_errors.
 */
export async function evaluationContext(
	ownerId: string,
	at: ContextAt,
	deps: ContextDeps = {}
): Promise<EvaluationContext | null> {
	const db = deps.db ?? getDb();
	const read = deps.reader ?? readContext;
	const own = { facts: deps.facts, repository: deps.repository };
	const bounded = db instanceof PgTransaction ? inSavepoint : inReadOnly;
	try {
		const timeout = timeoutSql(deps.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS);
		return await bounded(db, timeout, (tx) => read(tx, ownerId, at, own));
	} catch (error) {
		const code = sqlState(error);
		await recordServerError(
			{
				error,
				kind: 'load',
				status: 500,
				...deps.origin,
				context: { part: 'evaluation-context', ...(code && { code }) }
			},
			{ db: deps.errorsDb ?? db }
		);
		return null;
	}
}

/** One context per version and week, loaded at most once: what a request or a batch shares. */
export function createContextCache(ownerId: string, deps: ContextDeps = {}) {
	const memo = new Map<string, Promise<EvaluationContext | null>>();
	return {
		get(at: ContextAt): Promise<EvaluationContext | null> {
			const key = `${at.versionId} ${at.weekStartsOn} ${at.today}`;
			if (!memo.has(key)) memo.set(key, evaluationContext(ownerId, at, deps));
			return memo.get(key)!;
		}
	};
}
export type ContextCache = ReturnType<typeof createContextCache>;

/** The context as evaluateWeek reads it. */
export const weekContextOf = (context: EvaluationContext): WeekContext => ({
	load: { days: context.load.days, logged: context.load.logged },
	priorities: context.priorities,
	...(context.weekKind && { week: { kind: context.weekKind } }),
	events: context.events,
	...(context.level && { experience: context.level })
});
