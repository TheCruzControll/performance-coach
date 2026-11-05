/**
 * Error recording use-case. Called from the server `handleError` hook: every unexpected
 * server error is logged (JSON, with request id) and persisted to `app_errors`.
 *
 * This function never throws — a failure to record an error must not mask the original one.
 */
import { createAppErrorsRepository, getDb, type AppErrorRow, type Executor } from '../db';
import { logger, serializeError } from '../observability/logger';

export interface ServerErrorInput {
	error: unknown;
	kind: string;
	status: number;
	requestId?: string;
	method?: string;
	path?: string;
	routeId?: string | null;
	appVersion?: string;
	context?: Record<string, unknown>;
}

export async function recordServerError(
	input: ServerErrorInput,
	deps: { db?: Executor } = {}
): Promise<AppErrorRow | null> {
	const serialized = serializeError(input.error);
	logger.error('server error', {
		requestId: input.requestId,
		kind: input.kind,
		status: input.status,
		method: input.method,
		path: input.path,
		err: input.error
	});
	// The driver's error, already log-safe (serializeError withholds anything that can quote a
	// query value); its stack and any deeper cause stay in the log line only.
	const {
		stack: _stack,
		cause: _deeper,
		...cause
	} = (serialized.cause as Record<string, unknown> | undefined) ?? {};
	const context = {
		...input.context,
		...(Object.keys(cause).length > 0 ? { cause } : {})
	};
	try {
		return await createAppErrorsRepository(deps.db ?? getDb()).insert({
			kind: input.kind,
			status: input.status,
			requestId: input.requestId ?? null,
			method: input.method ?? null,
			path: input.path ?? null,
			routeId: input.routeId ?? null,
			message: String(serialized.message ?? 'Unknown error'),
			stack: typeof serialized.stack === 'string' ? serialized.stack : null,
			appVersion: input.appVersion ?? null,
			context: Object.keys(context).length > 0 ? context : null
		});
	} catch (err) {
		logger.error('failed to persist server error', { err, requestId: input.requestId });
		return null;
	}
}

export async function findErrorsByRequestId(
	requestId: string,
	deps: { db?: Executor } = {}
): Promise<AppErrorRow[]> {
	return createAppErrorsRepository(deps.db ?? getDb()).findByRequestId(requestId);
}
