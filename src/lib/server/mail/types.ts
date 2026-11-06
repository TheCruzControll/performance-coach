/**
 * The mail layer's contract (ADR 0011). A mailer writes to one recipient, fixed when it is
 * created: a message has no recipient, so no caller can address mail anywhere else. Messages are
 * plain text only.
 */

/** One plain-text message. The recipient and the sender belong to the mailer. */
export interface MailMessage {
	subject: string;
	text: string;
	/** Sent as Resend's Idempotency-Key, so a retried send delivers once (the link id). */
	idempotencyKey?: string;
}

export type MailProvider = 'resend' | 'test';

export interface Mailer {
	readonly provider: MailProvider;
	/** One attempt: it resolves with the provider's message id or rejects with a MailError. */
	send(message: MailMessage): Promise<{ id: string }>;
}

/**
 * - `rejected`: the provider answered with a status other than 2xx
 * - `timeout`: no complete answer in time
 * - `network`: the request failed before any answer
 * - `malformed`: a 2xx answer without a usable message id
 */
export type MailErrorCode = 'rejected' | 'timeout' | 'network' | 'malformed';

export interface MailErrorDetails {
	/** The provider's HTTP status, when it answered. */
	status?: number;
	/** The provider's error name, such as `validation_error`; never its message. */
	providerError?: string;
	/** The timeout that ran out, for the message. */
	timeoutMs?: number;
}

/**
 * Why a message was not sent. The message is built from the code, the status and the error name
 * only, and there is no `cause`: neither may carry the API key, the recipient or the text (which
 * holds a sign-in token), so the error is safe to log whole.
 */
export class MailError extends Error {
	readonly code: MailErrorCode;
	readonly status?: number;
	readonly providerError?: string;

	constructor(code: MailErrorCode, { status, providerError, timeoutMs }: MailErrorDetails = {}) {
		super(describe(code, status, providerError, timeoutMs));
		this.name = 'MailError';
		this.code = code;
		this.status = status;
		this.providerError = providerError;
	}
}

function describe(
	code: MailErrorCode,
	status: number | undefined,
	providerError: string | undefined,
	timeoutMs: number | undefined
): string {
	switch (code) {
		case 'rejected':
			return `The mail provider refused the message (HTTP ${status}${providerError ? `, ${providerError}` : ''})`;
		case 'timeout':
			return `The mail provider did not answer within ${timeoutMs} ms`;
		case 'network':
			return 'The mail provider could not be reached';
		case 'malformed':
			return `The mail provider answered HTTP ${status} without a message id`;
	}
}
