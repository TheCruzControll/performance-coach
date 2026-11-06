/**
 * Resend's HTTP API over fetch: no SDK, no dependency. The request is the one Resend's own SDK
 * sends (`POST /emails`, `Authorization: Bearer`, `Idempotency-Key`); an error answer is
 * `{ name, message, statusCode }`, of which only `name` is kept, because the message can quote
 * the request (the recipient).
 *
 * One attempt with a timeout; the caller decides about retries, and the idempotency key makes a
 * retry deliver once. It logs the status and Resend's id only.
 */
import { logger } from '../observability/logger';
import { MailError, type Mailer, type MailMessage } from './types';

export const RESEND_EMAILS_URL = 'https://api.resend.com/emails';

/** How long one send may take, answer body included. */
export const RESEND_TIMEOUT_MS = 10_000;

/** Resend's error names are snake_case words (`validation_error`); anything else is dropped. */
const ERROR_NAME = /^[a-z][a-z0-9_]{0,63}$/;
/** Resend's ids are UUIDs; this accepts any plain token so that a format change still works. */
const MESSAGE_ID = /^[\w-]{1,128}$/;

export interface ResendMailerOptions {
	apiKey: string;
	/** An address or `Name <address>` (validated by auth/email-link-config.ts). */
	from: string;
	/** The only recipient this mailer ever writes to. */
	to: string;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
}

export function createResendMailer({
	apiKey,
	from,
	to,
	fetch = globalThis.fetch,
	timeoutMs = RESEND_TIMEOUT_MS
}: ResendMailerOptions): Mailer {
	return {
		provider: 'resend',
		async send(message: MailMessage) {
			try {
				const { status, id } = await post(message);
				logger.info('mail: sent', { status, id });
				return { id };
			} catch (error) {
				const failure = error instanceof MailError ? error : new MailError('network');
				const { code, status, providerError } = failure;
				logger.warn('mail: not sent', { code, status, providerError });
				throw failure;
			}
		}
	};

	async function post({ subject, text, idempotencyKey }: MailMessage) {
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);
		const failed = (status?: number) =>
			new MailError(timedOut ? 'timeout' : 'network', { status, timeoutMs });
		try {
			let response: Response;
			try {
				response = await fetch(RESEND_EMAILS_URL, {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${apiKey}`,
						'Content-Type': 'application/json',
						...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
					},
					// Exactly these fields: the recipient is the mailer's, and there is no HTML.
					body: JSON.stringify({ from, to: [to], subject, text }),
					// The key is never sent on to wherever a redirect points.
					redirect: 'manual',
					signal: controller.signal
				});
			} catch {
				throw failed();
			}
			const { status } = response;
			let body: unknown;
			try {
				body = parse(await response.text());
			} catch {
				// A refusal is a refusal without its body; a 2xx needs the body for the id.
				if (response.ok) throw failed(status);
			}
			if (!response.ok) {
				const name = field(body, 'name');
				throw new MailError('rejected', {
					status,
					providerError: name !== undefined && ERROR_NAME.test(name) ? name : undefined
				});
			}
			const id = field(body, 'id');
			if (id === undefined || !MESSAGE_ID.test(id)) throw new MailError('malformed', { status });
			return { status, id };
		} finally {
			clearTimeout(timer);
		}
	}
}

/** JSON, or undefined for a body that is not (a proxy's HTML page, an empty answer). */
function parse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function field(body: unknown, key: string): string | undefined {
	if (typeof body !== 'object' || body === null) return undefined;
	const value = (body as Record<string, unknown>)[key];
	return typeof value === 'string' ? value : undefined;
}
