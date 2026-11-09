/**
 * Coach run read builders (M5, PRD §12, §15): each keyed query repositories/agent-runs.ts runs,
 * shaped for the indexes in schema/agent-runs.ts.
 * - Every predicate repeats the owner, so a run is found only through its owner.
 * - AGENT_RUN_INDEXES names the index each builder is shaped for; the integration test checks
 *   that each exists.
 * Nothing runs until a builder is awaited; await them in turn on one connection.
 */
import { and, desc, eq, getTableColumns, isNull, sql } from 'drizzle-orm';
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core';
import {
	agentModelCalls,
	agentRuns,
	agentToolCalls,
	athleteProfiles,
	coachMessages
} from '../schema';
import type { Executor } from '../types';

/** The index each builder is shaped for. */
export const AGENT_RUN_INDEXES = {
	run: 'agent_runs_pkey',
	runningRun: 'agent_runs_thread_running_uq',
	ownerMessage: 'coach_messages_pkey',
	runPage: 'agent_runs_owner_started_idx',
	dayCapCost: ['agent_runs_owner_started_idx', 'agent_model_calls_run_call_uq'],
	summary: 'agent_runs_owner_started_idx',
	toolFrequency: 'agent_tool_calls_run_idx'
} as const;

/** A run as the turn, the cancel endpoint and the usage view read it: every column but its owner. */
const { ownerId: _ownerId, ...columns } = getTableColumns(agentRuns);
export const runColumns = columns;

export const ownRun = (ownerId: string, runId: string) =>
	and(eq(agentRuns.id, runId), eq(agentRuns.ownerId, ownerId));

/** A sum of a bigint column, as a number (0 over no rows). */
const total = (column: AnyPgColumn) => sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number);

export function run(db: Executor, ownerId: string, runId: string) {
	return db.select(runColumns).from(agentRuns).where(ownRun(ownerId, runId));
}

/** The thread's running run, if any (at most one: the partial unique index). */
export function runningRun(db: Executor, ownerId: string, threadId: string) {
	return db
		.select({ id: agentRuns.id, startedAt: agentRuns.startedAt })
		.from(agentRuns)
		.where(
			and(
				eq(agentRuns.threadId, threadId),
				eq(agentRuns.ownerId, ownerId),
				eq(agentRuns.status, 'running')
			)
		);
}

/** The owner's message in the thread a run answers. */
export function ownerMessage(db: Executor, ownerId: string, threadId: string, messageId: string) {
	return db
		.select({ id: coachMessages.id })
		.from(coachMessages)
		.where(
			and(
				eq(coachMessages.id, messageId),
				eq(coachMessages.threadId, threadId),
				eq(coachMessages.ownerId, ownerId),
				eq(coachMessages.kind, 'owner_message')
			)
		);
}

const cursor = alias(agentRuns, 'cursor');

/** The owner's runs, newest first, keyset-paged on (started_at, id) after run `before`. */
export function runPage(
	db: Executor,
	ownerId: string,
	{ before, limit }: { before?: string; limit: number }
) {
	const after =
		before === undefined
			? undefined
			: sql`(${agentRuns.startedAt}, ${agentRuns.id}) < ((${db
					.select({ at: cursor.startedAt })
					.from(cursor)
					.where(and(eq(cursor.id, before), eq(cursor.ownerId, ownerId)))}), ${before}::uuid)`;
	return db
		.select(runColumns)
		.from(agentRuns)
		.where(and(eq(agentRuns.ownerId, ownerId), after))
		.orderBy(desc(agentRuns.startedAt), desc(agentRuns.id))
		.limit(limit);
}

/**
 * The owner's midnight is never further than this before `now` (a local day lasts at most 25
 * hours, 26 in a rare zone change). The planner can estimate a bound from `now` alone, which it
 * cannot the midnight read from the profile, so dayCapCost repeats it as a redundant filter and
 * the plan reads only the owner's newest runs and their calls (pnpm db:explain gates it).
 */
const DAY_CAP_HORIZON_S = 2 * 86_400;

/**
 * The cap cost of the owner's model calls made since the start of the owner's day at `now`, in
 * the time zone on their profile (UTC without one). Only runs started up to `lookbackMs` before
 * that midnight can hold such calls, which keeps the scan on the owner's newest runs.
 */
export function dayCapCost(db: Executor, ownerId: string, now: Date, lookbackMs: number) {
	const zone = sql`coalesce((select ${athleteProfiles.timeZone} from ${athleteProfiles} where ${athleteProfiles.ownerId} = ${ownerId}), 'UTC')`;
	const midnight = sql`(date_trunc('day', ${now.toISOString()}::timestamptz at time zone ${zone}) at time zone ${zone})`;
	const horizon = sql`${now.toISOString()}::timestamptz - make_interval(secs => ${DAY_CAP_HORIZON_S})`;
	const lookback = sql`make_interval(secs => ${lookbackMs / 1000})`;
	return db
		.select({ micros: total(agentModelCalls.capCostMicros) })
		.from(agentRuns)
		.innerJoin(agentModelCalls, eq(agentModelCalls.runId, agentRuns.id))
		.where(
			and(
				eq(agentRuns.ownerId, ownerId),
				sql`${agentRuns.startedAt} >= ${midnight} - ${lookback}`,
				sql`${agentRuns.startedAt} >= ${horizon} - ${lookback}`,
				eq(agentModelCalls.ownerId, ownerId),
				sql`${agentModelCalls.createdAt} >= ${midnight}`,
				sql`${agentModelCalls.createdAt} >= ${horizon}`
			)
		);
}

const percentile = (fraction: number) =>
	sql<
		number | null
	>`percentile_disc(${sql.raw(String(fraction))}) within group (order by ${agentRuns.latencyMs})`.mapWith(
		(value) => (value === null ? null : Number(value))
	);

/** Every run's totals, and the finished runs' latency at p50 and p95. */
export function runTotals(db: Executor, ownerId: string) {
	return db
		.select({
			runs: sql<number>`count(*)`.mapWith(Number),
			modelCalls: total(agentRuns.modelCalls),
			toolCalls: total(agentRuns.toolCalls),
			inputTokens: total(agentRuns.inputTokens),
			outputTokens: total(agentRuns.outputTokens),
			cacheReadTokens: total(agentRuns.cacheReadTokens),
			cacheWriteTokens: total(agentRuns.cacheWriteTokens),
			costMicros: total(agentRuns.costMicros),
			capCostMicros: total(agentRuns.capCostMicros),
			unpricedRuns: sql<number>`count(*) filter (where ${isNull(agentRuns.costMicros)})`.mapWith(
				Number
			),
			latencyP50Ms: percentile(0.5),
			latencyP95Ms: percentile(0.95)
		})
		.from(agentRuns)
		.where(eq(agentRuns.ownerId, ownerId));
}

export function statusCounts(db: Executor, ownerId: string) {
	return db
		.select({ status: agentRuns.status, runs: sql<number>`count(*)`.mapWith(Number) })
		.from(agentRuns)
		.where(eq(agentRuns.ownerId, ownerId))
		.groupBy(agentRuns.status);
}

/** How often each tool was called, most first, then by name in byte order. */
export function toolFrequency(db: Executor, ownerId: string) {
	const calls = sql<number>`count(*)`.mapWith(Number);
	return db
		.select({ name: agentToolCalls.name, calls })
		.from(agentToolCalls)
		.innerJoin(agentRuns, eq(agentRuns.id, agentToolCalls.runId))
		.where(and(eq(agentRuns.ownerId, ownerId), eq(agentToolCalls.ownerId, ownerId)))
		.groupBy(agentToolCalls.name)
		.orderBy(desc(calls), sql`${agentToolCalls.name} collate "C"`);
}

/** The owner's model calls served by a model that has no price. */
export function unpricedCalls(db: Executor, ownerId: string) {
	return db
		.select({ calls: sql<number>`count(*)`.mapWith(Number) })
		.from(agentModelCalls)
		.innerJoin(agentRuns, eq(agentRuns.id, agentModelCalls.runId))
		.where(
			and(
				eq(agentRuns.ownerId, ownerId),
				eq(agentModelCalls.ownerId, ownerId),
				isNull(agentModelCalls.costMicros)
			)
		);
}
