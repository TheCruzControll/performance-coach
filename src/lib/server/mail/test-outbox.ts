/**
 * The recording mailer: messages go to an in-memory outbox that integration tests and the e2e
 * outbox route read, so tests follow a sign-in link without real mail. It is chosen only where
 * test routes are enabled and allowed, never on Vercel (auth/email-link-config.ts).
 *
 * The outbox belongs to the server process: every test mailer writes to it, newest first, and it
 * keeps the last TEST_OUTBOX_LIMIT messages, so a long e2e run cannot grow it without bound.
 */
import type { Mailer, MailMessage } from './types';

export const TEST_OUTBOX_LIMIT = 50;

export interface SentMail {
	readonly id: string;
	readonly to: string;
	readonly from: string;
	readonly subject: string;
	readonly text: string;
	readonly sentAt: Date;
}

/** Newest first. */
const outbox: SentMail[] = [];

export const testOutbox = {
	/** The recorded messages, newest first, as a copy. */
	list(): SentMail[] {
		return [...outbox];
	},
	clear(): void {
		outbox.length = 0;
	}
};

export interface TestMailerOptions {
	from: string;
	/** The only recipient this mailer ever writes to. */
	to: string;
}

export function createTestMailer({ from, to }: TestMailerOptions): Mailer {
	return {
		provider: 'test',
		async send({ subject, text }: MailMessage) {
			const id = `test_${crypto.randomUUID()}`;
			outbox.unshift(Object.freeze({ id, to, from, subject, text, sentAt: new Date() }));
			outbox.length = Math.min(outbox.length, TEST_OUTBOX_LIMIT);
			return { id };
		}
	};
}
