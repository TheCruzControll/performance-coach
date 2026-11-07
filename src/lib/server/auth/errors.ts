/**
 * The one error type auth use-cases throw. Routes map it to a status and a safe message; the
 * `code` is stable for clients and tests. Messages never say *why* a secret was wrong (unknown
 * vs used vs malformed recovery code, wrong vs missing setup token).
 */
export type AuthErrorCode =
	| 'setup_unavailable'
	| 'invalid_input'
	| 'challenge_invalid'
	| 'verification_failed'
	| 'unknown_credential'
	| 'already_registered'
	| 'invalid_code'
	| 'last_passkey'
	| 'not_found'
	| 'reauth_required'
	| 'rate_limited'
	| 'wrong_origin'
	| 'link_invalid';

const STATUS: Record<AuthErrorCode, number> = {
	setup_unavailable: 404,
	invalid_input: 422,
	challenge_invalid: 400,
	verification_failed: 401,
	unknown_credential: 401,
	already_registered: 409,
	invalid_code: 401,
	last_passkey: 409,
	not_found: 404,
	reauth_required: 403,
	rate_limited: 429,
	wrong_origin: 400,
	link_invalid: 401
};

export class AuthError extends Error {
	readonly code: AuthErrorCode;
	readonly status: number;
	/** Seconds until a rate-limited client may retry. */
	readonly retryAfter?: number;

	constructor(
		code: AuthErrorCode,
		message: string,
		options: { retryAfter?: number } = {},
		cause?: unknown
	) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = 'AuthError';
		this.code = code;
		this.status = STATUS[code];
		this.retryAfter = options.retryAfter;
	}
}

export function isAuthError(error: unknown): error is AuthError {
	return error instanceof AuthError;
}

/** The underlying reason (e.g. SimpleWebAuthn's message) for the audit log, never for clients. */
export function failureReason(error: unknown): string {
	const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
	return (cause instanceof Error ? cause.message : String(cause)).slice(0, 300);
}
