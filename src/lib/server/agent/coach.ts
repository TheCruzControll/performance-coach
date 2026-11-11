/**
 * The coach's composition root (M5): the one place that turns the environment into a provider and
 * runs turns with it. The endpoints (POST /api/coach/turns and the coach screen's status) call
 * only this module.
 *
 * - The provider is chosen by provider/select.ts once per environment (getEnv() caches it, so once
 *   per server): the MockProvider with every mock script, or the AnthropicProvider. The Anthropic
 *   provider is loaded by a dynamic import, on the first turn that needs it, so a mock or an
 *   unavailable coach never loads it.
 * - coachStatus() says whether the coach can answer, and why not, without loading anything.
 * - admitCoachTurn() counts a turn against the 'coach.turn' rate limit.
 * - runCoachTurn() runs one turn (turn.ts) with that provider. The turn hands the tools M3's
 *   matchExercise over the owner's library (services/coach/turn-facts.ts) in their ToolContext.
 * - coachEventStream() frames a turn's events as server-sent events, with a heartbeat.
 * - Where test routes are enabled, the test route's overrides (provider/faults.ts) can make the
 *   coach unavailable for a reason and shorten a turn; nowhere else can anything set them.
 */
import { encodeSse, SSE_HEARTBEAT, type CoachEvent } from '../../domain/coach/events.ts';
import type { ToolEffect } from '../../domain/coach/tools.ts';
import type { CoachUnavailableReason } from '../../domain/coach/vocabulary.ts';
import type { AuthRequest } from '../auth/context.ts';
import { enforceRateLimit } from '../auth/rate-limit.ts';
import { getEnv, type Env } from '../env.ts';
import { logger } from '../observability/logger.ts';
import type { CoachDeps } from '../services/coach/shared.ts';
import { mockOverrides } from './provider/faults.ts';
import { MockProvider } from './provider/mock.ts';
import { MOCK_SCRIPTS } from './provider/mock-scripts/index.ts';
import { resolveCoachProvider, type CoachProviderChoice } from './provider/select.ts';
import type { LlmProvider } from './provider/types.ts';
import { runTurn, type TurnInput, type TurnProvider } from './turn.ts';

/** A comment frame this often keeps proxies from closing a quiet stream (a long tool, a draft). */
export const SSE_HEARTBEAT_MS = 15_000;

export type CoachStatus =
	| { status: 'ready'; mockBadge: boolean }
	| { status: 'unavailable'; reason: CoachUnavailableReason; mockBadge: false };

interface Resolved {
	env: Env;
	choice: CoachProviderChoice;
	provider?: Promise<LlmProvider>;
}

let resolved: Resolved | undefined;

/** The choice for the current environment, resolved (and a misconfiguration logged) once. */
function current(): Resolved {
	const env = getEnv();
	if (resolved?.env !== env) resolved = { env, choice: resolveCoachProvider(env) };
	const { unavailable } = mockOverrides();
	return unavailable ? { env, choice: { status: 'unavailable', reason: unavailable } } : resolved;
}

async function load(env: Env, name: 'mock' | 'anthropic'): Promise<LlmProvider> {
	if (name === 'mock') return new MockProvider(MOCK_SCRIPTS);
	const { AnthropicProvider } = await import('./provider/anthropic.ts');
	return new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY });
}

export function coachStatus(): CoachStatus {
	const { choice } = current();
	return choice.status === 'ready'
		? { status: 'ready', mockBadge: choice.mockBadge }
		: { status: 'unavailable', reason: choice.reason, mockBadge: false };
}

/** The provider a turn runs with: one instance per environment, so the mock's cache persists. */
export async function coachProvider(): Promise<TurnProvider> {
	const entry = current();
	const { choice } = entry;
	if (choice.status === 'unavailable') return choice;
	entry.provider ??= load(entry.env, choice.provider).catch((error: unknown) => {
		entry.provider = undefined; // a failed load is tried again by the next turn
		throw error;
	});
	return { status: 'ready', provider: await entry.provider };
}

export interface CoachTurnOptions {
	deps?: CoachDeps;
	/** When the endpoint must have answered, in epoch milliseconds. */
	deadlineAt?: number;
	/** Only the tools with these effects are offered (turn.ts); all of them by default. */
	toolEffects?: readonly ToolEffect[];
}

/**
 * Count one turn against the 'coach.turn' rate limit, all devices together: AuthError
 * rate_limited (429) once over it. Every turn counts, a review's write-up included.
 */
export async function admitCoachTurn(
	request: AuthRequest | null,
	deps: CoachDeps = {}
): Promise<void> {
	await enforceRateLimit('coach.turn', 'global', request, deps);
}

/** One turn with the environment's provider; the stream always ends with `done`. */
export async function* runCoachTurn(
	input: TurnInput,
	options: CoachTurnOptions = {}
): AsyncGenerator<CoachEvent> {
	let provider: TurnProvider;
	try {
		provider = await coachProvider();
	} catch (error) {
		logger.error('coach provider failed to load', { err: error });
		yield { type: 'error', kind: 'provider' };
		yield { type: 'done', status: null };
		return;
	}
	const { turnMs } = mockOverrides();
	const deadlineAt =
		turnMs === undefined
			? options.deadlineAt
			: Math.min(options.deadlineAt ?? Infinity, Date.now() + turnMs);
	yield* runTurn(input, { ...options, provider, deadlineAt });
}

/**
 * A turn's events as an SSE body: each frame carries its id (from 1), and a heartbeat comment
 * goes out every `heartbeatMs` until the last event. When the reader leaves, `onCancel` runs and
 * the events are still read to their end (unsent), so the turn finishes and stores how it ended.
 */
export function coachEventStream(
	events: AsyncIterable<CoachEvent>,
	options: { onCancel: () => void; heartbeatMs?: number }
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let open = true;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	const stop = () => {
		open = false;
		clearInterval(heartbeat);
	};
	return new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (frame: string) => open && controller.enqueue(encoder.encode(frame));
			heartbeat = setInterval(() => send(SSE_HEARTBEAT), options.heartbeatMs ?? SSE_HEARTBEAT_MS);
			void (async () => {
				let id = 0;
				try {
					for await (const event of events) send(encodeSse(event, ++id));
					if (open) controller.close();
				} catch (error) {
					if (open) controller.error(error);
				} finally {
					stop();
				}
			})();
		},
		cancel() {
			stop();
			options.onCancel();
		}
	});
}
