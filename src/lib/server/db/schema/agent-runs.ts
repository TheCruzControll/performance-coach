/**
 * Coach runs (M5, PRD §12, §15): what every turn did, how long it took and what it cost.
 *
 *   agent_runs         one turn of the agent loop, running until it finishes once
 *   agent_model_calls  each model call a run made, failed and re-issued ones included
 *   agent_tool_calls   each tool call, and each output-policy intervention (named '_policy')
 *
 * - Tokens are bigint ≥ 0. Costs are micro-dollars (domain/coach/pricing.ts): cost_micros is what
 *   diagnostics show and is null when a model that ran has no price; cap_cost_micros is what the
 *   daily cap sums, never null, so an unpriced model can never slip past the cap.
 * - One running run per thread (a partial unique index). (status = 'running') = (finished_at is
 *   null), so a run is finished exactly when it has a finishing time.
 * - Every row carries owner_id (ownerRef), so the test cleanup clears it with the owner.
 * - Guards (drizzle/<n>_coach_conversations_guards.sql): a run changes only while it is running,
 *   never its identity, and its usage and cost only grow; model and tool calls are insert-only;
 *   DELETE is refused. Only test and reset code bypasses them (ADR 0010).
 * - agent_tool_calls.proposal_id names the proposal a tool created, by foreign key. coaching.ts
 *   names agent_runs for coach_proposals.run_id, so the two modules import each other; every
 *   cross-table reference is a lazy callback, so either loads first.
 */
import { sql } from 'drizzle-orm';
import {
	bigint,
	boolean,
	check,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import {
	RUN_STATUSES,
	TOOL_CALL_STATUSES,
	type RunStatus,
	type ToolCallStatus
} from '../../../domain/coach/vocabulary';
import { createdAt, inList, ownerRef } from './columns';
import { coachMessages, coachThreads } from './coach';
import { coachProposals } from './coaching';

/**
 * The most bytes a tool call's stored input or output takes, as jsonb text. Tool outputs are
 * capped at 8 KB before the model sees them (agent/tools/output.ts); the service caps what it
 * stores to this, and the CHECK is the backstop.
 */
export const TOOL_CALL_JSON_MAX_BYTES = 16_384;

const tokens = (name: string) => bigint(name, { mode: 'number' }).notNull().default(0);
const micros = (name: string) => bigint(name, { mode: 'number' });

/** The usage columns a run (its totals) and a model call share. */
const usage = () => ({
	inputTokens: tokens('input_tokens'),
	outputTokens: tokens('output_tokens'),
	cacheReadTokens: tokens('cache_read_tokens'),
	cacheWriteTokens: tokens('cache_write_tokens'),
	/** Null when a model that ran is not in PRICING. */
	costMicros: micros('cost_micros'),
	/** What the daily cap counts: an unpriced model at the highest known rate. */
	capCostMicros: micros('cap_cost_micros').notNull(),
	/** Milliseconds to the first content delta; null when none arrived. */
	ttftMs: integer('ttft_ms'),
	latencyMs: integer('latency_ms')
});

/** A CHECK body: every usage column is ≥ 0 (or null where it may be). */
const usageCheck = (extra: string[] = []) =>
	sql.raw(
		[
			'input_tokens >= 0',
			'output_tokens >= 0',
			'cache_read_tokens >= 0',
			'cache_write_tokens >= 0',
			'(cost_micros is null or cost_micros >= 0)',
			'cap_cost_micros >= 0',
			'(ttft_ms is null or ttft_ms >= 0)',
			'(latency_ms is null or latency_ms >= 0)',
			...extra
		].join(' and ')
	);

export const agentRuns = pgTable(
	'agent_runs',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		ownerId: ownerRef(),
		threadId: uuid('thread_id')
			.notNull()
			.references(() => coachThreads.id),
		/** The owner message the run answers; a retry is a new run on the same message. */
		triggerMessageId: uuid('trigger_message_id')
			.notNull()
			.references(() => coachMessages.id),
		/** What kind of run it is (a turn, a summary). Open; the services name it. */
		kind: text('kind').notNull(),
		/** The LlmProvider that served it ('anthropic', 'mock'). */
		provider: text('provider').notNull(),
		/** The model asked for, and the one that answered (a refusal fallback's, when one did). */
		model: text('model').notNull(),
		servedModel: text('served_model'),
		/** output_config.effort. */
		effort: text('effort').notNull(),
		promptVersion: text('prompt_version').notNull(),
		status: text('status').$type<RunStatus>().notNull().default('running'),
		stopReason: text('stop_reason'),
		/** stop_details.category of a refusal. */
		refusalCategory: text('refusal_category'),
		/** The error kind it failed with; never message text. */
		error: text('error'),
		modelCalls: integer('model_calls').notNull().default(0),
		toolCalls: integer('tool_calls').notNull().default(0),
		...usage(),
		costMicros: micros('cost_micros').default(0),
		capCostMicros: micros('cap_cost_micros').notNull().default(0),
		/** Set by Stop; the loop reads it between steps. */
		cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
		startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
		finishedAt: timestamp('finished_at', { withTimezone: true })
	},
	(t) => [
		uniqueIndex('agent_runs_thread_running_uq')
			.on(t.threadId)
			.where(sql`${t.status} = 'running'`),
		// The owner's runs, newest first: the daily spend and the usage view.
		index('agent_runs_owner_started_idx').on(t.ownerId, t.startedAt.desc().nullsFirst()),
		check('agent_runs_status_ck', inList('status', RUN_STATUSES)),
		check('agent_runs_finished_ck', sql`(${t.status} = 'running') = (${t.finishedAt} is null)`),
		check('agent_runs_usage_ck', usageCheck(['model_calls >= 0', 'tool_calls >= 0'])),
		check(
			'agent_runs_text_ck',
			sql`char_length(${t.kind}) > 0 and char_length(${t.provider}) > 0 and char_length(${t.model}) > 0 and char_length(${t.effort}) > 0 and char_length(${t.promptVersion}) > 0`
		)
	]
);

export const agentModelCalls = pgTable(
	'agent_model_calls',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		ownerId: ownerRef(),
		runId: uuid('run_id')
			.notNull()
			.references(() => agentRuns.id),
		/** The run's calls in order, from 0. */
		callIndex: integer('call_index').notNull(),
		/** The API's request id, to match the provider's logs. */
		requestId: text('request_id'),
		/** The model that served it; null if it failed before one did. */
		model: text('model'),
		stopReason: text('stop_reason'),
		refusalCategory: text('refusal_category'),
		/** The provider error kind; never message text. */
		error: text('error'),
		...usage(),
		latencyMs: integer('latency_ms').notNull(),
		createdAt: createdAt()
	},
	(t) => [
		uniqueIndex('agent_model_calls_run_call_uq').on(t.runId, t.callIndex),
		check('agent_model_calls_usage_ck', usageCheck(['call_index >= 0']))
	]
);

export const agentToolCalls = pgTable(
	'agent_tool_calls',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		ownerId: ownerRef(),
		runId: uuid('run_id')
			.notNull()
			.references(() => agentRuns.id),
		/** The model call whose tool_use it answers (agent_model_calls.call_index). */
		callIndex: integer('call_index').notNull(),
		toolUseId: text('tool_use_id').notNull(),
		/** As the model asked for it, which may be no tool's name; '_policy' for an intervention. */
		name: text('name').notNull(),
		status: text('status').$type<ToolCallStatus>().notNull(),
		/** The input as the model sent it, and the output it received, capped. */
		input: jsonb('input').$type<unknown>().notNull(),
		output: jsonb('output').$type<unknown>(),
		/** The error code of a failed call; never message text. */
		errorCode: text('error_code'),
		/** The output was cut to fit. */
		truncated: boolean('truncated').notNull().default(false),
		/** The proposal it created. */
		proposalId: uuid('proposal_id').references(() => coachProposals.id),
		startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
		durationMs: integer('duration_ms').notNull(),
		createdAt: createdAt()
	},
	(t) => [
		index('agent_tool_calls_run_idx').on(t.runId, t.callIndex),
		check('agent_tool_calls_status_ck', inList('status', TOOL_CALL_STATUSES)),
		check(
			'agent_tool_calls_size_ck',
			sql`octet_length(${t.input}::text) <= ${sql.raw(String(TOOL_CALL_JSON_MAX_BYTES))} and (${t.output} is null or octet_length(${t.output}::text) <= ${sql.raw(String(TOOL_CALL_JSON_MAX_BYTES))})`
		),
		check(
			'agent_tool_calls_text_ck',
			sql`char_length(${t.toolUseId}) > 0 and char_length(${t.name}) > 0`
		),
		check('agent_tool_calls_numbers_ck', sql`${t.callIndex} >= 0 and ${t.durationMs} >= 0`)
	]
);
