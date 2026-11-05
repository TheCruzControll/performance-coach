/**
 * The auth audit log (`auth_events`). Every security-relevant outcome is recorded with the
 * request id, client address and a User-Agent summary. Recording never throws: a failure to
 * write the log is logged and must not change the outcome of the request.
 */
import { createAuthRepository, type AuthEventType, type Executor } from '../db';
import { logger } from '../observability/logger';
import type { AuthRequest } from './context';
import { describeUserAgent } from './devices';

export interface AuthEventInput {
	type: AuthEventType;
	ownerId?: string | null;
	sessionId?: string | null;
	credentialId?: string | null;
	detail?: Record<string, unknown>;
}

export async function recordAuthEvent(
	db: Executor,
	request: AuthRequest | null,
	event: AuthEventInput
): Promise<void> {
	const level = /failed|rate_limited/.test(event.type) ? 'warn' : 'info';
	logger[level]('auth event', {
		type: event.type,
		requestId: request?.requestId,
		...(event.detail ? { detail: event.detail } : {})
	});
	try {
		await createAuthRepository(db).insertEvent({
			type: event.type,
			ownerId: event.ownerId ?? null,
			sessionId: event.sessionId ?? null,
			credentialId: event.credentialId ?? null,
			requestId: request?.requestId ?? null,
			ip: request?.ip?.slice(0, 64) ?? null,
			userAgent: request ? describeUserAgent(request.userAgent) : null,
			detail: event.detail ?? null
		});
	} catch (err) {
		logger.error('failed to record auth event', { err, type: event.type });
	}
}
