/**
 * Mail to the owner only (ADR 0011). A leaf layer, like observability: it is built from explicit
 * options and reads no configuration itself (eslint.config.js). auth/email-link-config.ts decides
 * the provider and the addresses; the caller passes them here.
 */
import { createResendMailer, type ResendMailerOptions } from './resend';
import { createTestMailer, type TestMailerOptions } from './test-outbox';
import type { Mailer } from './types';

export type MailerOptions =
	({ provider: 'resend' } & ResendMailerOptions) | ({ provider: 'test' } & TestMailerOptions);

export function createMailer(options: MailerOptions): Mailer {
	return options.provider === 'resend' ? createResendMailer(options) : createTestMailer(options);
}

export { createResendMailer, RESEND_TIMEOUT_MS } from './resend';
export { createTestMailer, TEST_OUTBOX_LIMIT, testOutbox, type SentMail } from './test-outbox';
export {
	MailError,
	type Mailer,
	type MailErrorCode,
	type MailMessage,
	type MailProvider
} from './types';
