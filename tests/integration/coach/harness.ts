/**
 * Coach turns on real Postgres, scripted (M5, coach-turn): each tool slice plays its mock
 * scripts through runTurn here and reads back what the turn stored.
 *
 * runScripted(script, options) runs one turn of `script` for `options.owner` and collects its
 * events. `ownerId` replaces the owner the tools see, and only that: the thread and the run stay
 * the seeded owner's, so a scoping test proves a tool given someone else's id finds nothing of
 * the owner's and writes nothing.
 */
import { asc, eq } from 'drizzle-orm';
import type { CoachEvent } from '../../../src/lib/domain/coach/events';
import { MockProvider, type MockScript } from '../../../src/lib/server/agent/provider/mock';
import type { LlmProvider, ModelRequest } from '../../../src/lib/server/agent/provider/types';
import { validateRequest } from '../../../src/lib/server/agent/provider/validate';
import type { TurnEntry } from '../../../src/lib/server/agent/tools/context';
import type { CoachTool } from '../../../src/lib/server/agent/tools/define';
import { runTurn, type TurnOptions } from '../../../src/lib/server/agent/turn';
import { coachMessages, type Executor } from '../../../src/lib/server/db';
import type { ResolvedCoachDeps } from '../../../src/lib/server/services/coach/shared';
import { getTranscript } from '../../../src/lib/server/services/coach/threads';

/** Wednesday of the program fixtures' week 1 (Monday 9 November 2026), 09:00 UTC. */
export const TURN_NOW = '2026-11-11T09:00:00Z';

export interface Scripted {
	db: Executor;
	/** Whose conversation it is. */
	owner: string;
	/** The owner the tools see instead (scoping tests). */
	ownerId?: string;
	text?: string;
	threadId?: string | null;
	clientMessageId?: string;
	/** What the turn is about (an entry point, or the proposal 'Ask for changes' revises). */
	entry?: TurnEntry | null;
	tools?: readonly CoachTool<ResolvedCoachDeps>[];
	/** A MockProvider playing `script` by default. */
	provider?: TurnOptions['provider'];
	now?: () => Date;
	/** The request's controller: abort it to leave as the client would. */
	controller?: AbortController;
	/** Awaited on each event as it arrives; the turn keeps running meanwhile. */
	onEvent?: (event: CoachEvent) => void | Promise<void>;
}

export interface ScriptedTurn {
	events: CoachEvent[];
	threadId: string | null;
	runId: string | null;
	done: Extract<CoachEvent, { type: 'done' }>;
}

/** A provider that keeps every request it is sent. */
export function recording(provider: LlmProvider): LlmProvider & { requests: ModelRequest[] } {
	const requests: ModelRequest[] = [];
	return {
		name: provider.name,
		model: provider.model,
		requests,
		stream: (request, signal) => {
			requests.push(structuredClone(request));
			return provider.stream(request, signal);
		},
		structured: (request, schema, signal) => provider.structured(request, schema, signal),
		countTokens: (request, signal) => provider.countTokens(request, signal)
	};
}

export async function runScripted(script: MockScript, options: Scripted): Promise<ScriptedTurn> {
	const { ownerId } = options;
	const tools = ownerId
		? options.tools?.map((tool) => ({
				...tool,
				run: (input: unknown, ctx: Parameters<typeof tool.run>[1]) =>
					tool.run(input, { ...ctx, ownerId })
			}))
		: options.tools;
	const provider = options.provider ?? {
		status: 'ready' as const,
		provider: new MockProvider([script], { overrides: () => ({}) })
	};
	const controller = options.controller ?? new AbortController();
	const events: CoachEvent[] = [];
	const stream = runTurn(
		{
			ownerId: options.owner,
			threadId: options.threadId ?? null,
			clientMessageId: options.clientMessageId ?? crypto.randomUUID(),
			text: options.text ?? 'How is my training going?',
			entry: options.entry ?? null,
			signal: controller.signal
		},
		{
			provider,
			deps: { db: options.db, now: options.now ?? (() => new Date(TURN_NOW)) },
			...(tools && { tools })
		}
	);
	for await (const event of stream) {
		events.push(event);
		await options.onEvent?.(event);
	}
	const started = events.find((event) => event.type === 'run_started');
	const done = events.at(-1);
	if (done?.type !== 'done') throw new Error('A turn ends with done');
	return {
		events,
		threadId: started?.type === 'run_started' ? started.threadId : null,
		runId: started?.type === 'run_started' ? started.runId : null,
		done
	};
}

/** Every row of a thread, in order, as stored. */
export async function storedRows(db: Executor, threadId: string) {
	return db
		.select({
			id: coachMessages.id,
			seq: coachMessages.seq,
			segment: coachMessages.segment,
			kind: coachMessages.kind,
			status: coachMessages.status,
			content: coachMessages.content,
			display: coachMessages.display,
			apiVisible: coachMessages.apiVisible
		})
		.from(coachMessages)
		.where(eq(coachMessages.threadId, threadId))
		.orderBy(asc(coachMessages.seq));
}

/**
 * What the API would refuse in the thread's current segment as the next turn replays it: the
 * stored messages, then a new owner message. Empty when the segment is a valid request.
 */
export async function segmentIssues(db: Executor, owner: string, threadId: string) {
	const { rows } = await getTranscript(owner, threadId, { db });
	const request = {
		max_tokens: 1024,
		output_config: { effort: 'medium' },
		messages: [
			...rows.map((row) => ({ role: row.role, content: row.content })),
			{ role: 'user', content: 'And next?' }
		]
	} as ModelRequest;
	return validateRequest(request);
}
