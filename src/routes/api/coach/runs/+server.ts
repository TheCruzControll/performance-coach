import { json } from '@sveltejs/kit';
import { authErrorResponse, authRequest } from '#lib/server/auth/index.ts';
import { enforceRateLimit } from '#lib/server/auth/rate-limit.ts';
import { listRuns, usageSummary, type CoachRun } from '#lib/server/services/coach/runs.ts';
import { CoachInputError } from '#lib/server/services/coach/shared.ts';
import type { UsagePage, UsageRunView } from '../../../(app)/coach/[[thread]]/usage.ts';
import type { RequestHandler } from './$types';

const NO_STORE = { 'cache-control': 'no-store' };

/** A run as the usage view lists it: no thread, message or prompt ids, nothing written. */
const runView = (run: CoachRun): UsageRunView => ({
	id: run.id,
	startedAt: run.startedAt.toISOString(),
	status: run.status,
	provider: run.provider,
	model: run.servedModel ?? run.model,
	stopReason: run.stopReason,
	refusalCategory: run.refusalCategory,
	modelCalls: run.modelCalls,
	toolCalls: run.toolCalls,
	inputTokens: run.inputTokens,
	outputTokens: run.outputTokens,
	cacheReadTokens: run.cacheReadTokens,
	cacheWriteTokens: run.cacheWriteTokens,
	costMicros: run.costMicros,
	latencyMs: run.latencyMs
});

/**
 * The owner's coach usage for the usage sheet (PRD §12, §15), read from stored runs:
 * `?before=<run id>&limit=<1..50>` pages the runs newest first (services/coach/runs.ts RUN_PAGE).
 * The first page (no `before`) carries every run's totals; later pages carry `summary: null`.
 *
 * - 200 {summary, runs, nextBefore}; never cached.
 * - 400 for a limit or cursor that is not one. Owner-only by the guard; rate-limited
 *   ('coach.action').
 */
export const GET: RequestHandler = async (event) => {
	try {
		await enforceRateLimit('coach.action', 'global', authRequest(event));
	} catch (err) {
		return authErrorResponse(err);
	}
	// The guard answers 401 without a session and 403 for a recovery one: this is the owner's.
	const ownerId = event.locals.session!.ownerId;
	const params = event.url.searchParams;
	const before = params.get('before') ?? undefined;
	const limit = params.has('limit') ? Number(params.get('limit')) : undefined;
	try {
		const page = await listRuns(ownerId, { before, limit });
		const summary = before === undefined ? await usageSummary(ownerId) : null;
		const body: UsagePage = { summary, runs: page.runs.map(runView), nextBefore: page.nextBefore };
		return json(body, { headers: NO_STORE });
	} catch (err) {
		if (!(err instanceof CoachInputError)) throw err;
		return json(
			{ error: 'invalid_request', message: err.message, field: err.field },
			{ status: 400, headers: NO_STORE }
		);
	}
};
