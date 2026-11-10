/**
 * Coach run persistence: runs queries/agent-runs.ts's builders one query at a time, and the writes
 * the run guard allows (a run changes only while it is running, and its usage only grows). Plain
 * data access: pricing, the busy rule, the stale cutoff and the summaries' shape belong to
 * src/lib/server/services/coach/runs.ts.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { AnyPgColumn, PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { TokenUsage } from '../../../domain/coach/pricing';
import type { RunStatus } from '../../../domain/coach/vocabulary';
import * as q from '../queries/agent-runs';
import { agentModelCalls, agentRuns, agentToolCalls } from '../schema';
import type { Executor } from '../types';

export type RunRow = Awaited<ReturnType<typeof q.run>>[number];
export type NewRunRow = typeof agentRuns.$inferInsert;
export type NewModelCallRow = typeof agentModelCalls.$inferInsert;
export type NewToolCallRow = typeof agentToolCalls.$inferInsert;

/** What one model call adds to its run. */
export interface RunRollUp extends TokenUsage {
	/** Null when the call is unpriced: the run's cost becomes unpriced for good. */
	costMicros: number | null;
	capCostMicros: number;
	servedModel: string | null;
	stopReason: string | null;
	refusalCategory: string | null;
}

const first = async <T>(rows: Promise<T[]>): Promise<T | null> => (await rows)[0] ?? null;

const plus = (column: AnyPgColumn, n: number) => sql`${column} + ${n}`;

export function createAgentRunsRepository(db: Executor) {
	/** Update one of the owner's runs while it is still running; null when none is. */
	const updateRunning = (
		ownerId: string,
		runId: string,
		set: PgUpdateSetSource<typeof agentRuns>
	) =>
		first(
			db
				.update(agentRuns)
				.set(set)
				.where(and(q.ownRun(ownerId, runId), eq(agentRuns.status, 'running')))
				.returning(q.runColumns)
		);

	return {
		run: (ownerId: string, runId: string) => first(q.run(db, ownerId, runId)),

		runningRun: (ownerId: string, threadId: string) => first(q.runningRun(db, ownerId, threadId)),

		hasOwnerMessage: async (ownerId: string, threadId: string, messageId: string) =>
			(await first(q.ownerMessage(db, ownerId, threadId, messageId))) !== null,

		runPage: (ownerId: string, page: { before?: string; limit: number }) =>
			q.runPage(db, ownerId, page),

		dayCapCost: async (ownerId: string, now: Date, lookbackMs: number) =>
			(await first(q.dayCapCost(db, ownerId, now, lookbackMs)))?.micros ?? 0,

		runTotals: async (ownerId: string) => (await first(q.runTotals(db, ownerId)))!,
		statusCounts: (ownerId: string) => q.statusCounts(db, ownerId),
		toolFrequency: (ownerId: string) => q.toolFrequency(db, ownerId),
		unpricedCalls: async (ownerId: string) =>
			(await first(q.unpricedCalls(db, ownerId)))?.calls ?? 0,

		/** The prompt of the run's last served call below `below`, in tokens; null before any. */
		lastCallInput: async (ownerId: string, runId: string, below: number) =>
			(await first(q.lastCallInput(db, ownerId, runId, below)))?.tokens ?? null,

		/** Insert a running run; null when the thread already has one (the partial unique index). */
		insertRun: (values: NewRunRow) =>
			first(db.insert(agentRuns).values(values).onConflictDoNothing().returning(q.runColumns)),

		/** Expire a running run that started at or before `cutoff`; null if it is not one. */
		expireRun: (ownerId: string, runId: string, cutoff: Date, at: Date) =>
			first(
				db
					.update(agentRuns)
					.set({ status: 'expired', finishedAt: at })
					.where(
						and(
							q.ownRun(ownerId, runId),
							eq(agentRuns.status, 'running'),
							sql`${agentRuns.startedAt} <= ${cutoff.toISOString()}`
						)
					)
					.returning({ id: agentRuns.id })
			),

		/** Add a model call's usage and costs to its running run. */
		rollUp: (ownerId: string, runId: string, call: RunRollUp) =>
			updateRunning(ownerId, runId, {
				modelCalls: sql`${agentRuns.modelCalls} + 1`,
				inputTokens: plus(agentRuns.inputTokens, call.inputTokens),
				outputTokens: plus(agentRuns.outputTokens, call.outputTokens),
				cacheReadTokens: plus(agentRuns.cacheReadTokens, call.cacheReadTokens),
				cacheWriteTokens: plus(agentRuns.cacheWriteTokens, call.cacheWriteTokens),
				costMicros: call.costMicros === null ? null : plus(agentRuns.costMicros, call.costMicros),
				capCostMicros: plus(agentRuns.capCostMicros, call.capCostMicros),
				...(call.servedModel === null ? {} : { servedModel: call.servedModel }),
				...(call.stopReason === null ? {} : { stopReason: call.stopReason }),
				...(call.refusalCategory === null ? {} : { refusalCategory: call.refusalCategory })
			}),

		addToolCalls: (ownerId: string, runId: string, count: number) =>
			updateRunning(ownerId, runId, {
				toolCalls: sql`${agentRuns.toolCalls} + ${count}`
			}),

		insertModelCall: (values: NewModelCallRow) => db.insert(agentModelCalls).values(values),

		insertToolCalls: (rows: NewToolCallRow[]) => db.insert(agentToolCalls).values(rows),

		/** Finish a running run at `at`, its latency measured from its start; null if none is. */
		finish: (
			ownerId: string,
			runId: string,
			at: Date,
			end: { status: RunStatus; error: string | null; ttftMs: number | null }
		) =>
			updateRunning(ownerId, runId, {
				status: end.status,
				error: end.error,
				...(end.ttftMs === null ? {} : { ttftMs: end.ttftMs }),
				finishedAt: at,
				latencyMs: sql`greatest(0, round(extract(epoch from (${at.toISOString()}::timestamptz - ${agentRuns.startedAt})) * 1000))::int`
			}),

		/** Set a running run's cancel flag once; null when it is not running or already set. */
		requestCancel: (ownerId: string, runId: string, at: Date) =>
			first(
				db
					.update(agentRuns)
					.set({ cancelRequestedAt: at })
					.where(
						and(
							q.ownRun(ownerId, runId),
							eq(agentRuns.status, 'running'),
							isNull(agentRuns.cancelRequestedAt)
						)
					)
					.returning({ id: agentRuns.id })
			)
	};
}
