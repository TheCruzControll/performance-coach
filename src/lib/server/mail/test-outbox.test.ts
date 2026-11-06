/**
 * The recording mailer that integration tests and the e2e outbox route read: newest first,
 * bounded, cleared on demand, and addressed only to the recipient it was created with.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestMailer, TEST_OUTBOX_LIMIT, testOutbox } from './test-outbox';
import type { MailMessage } from './types';

const FROM = 'Coach <coach@example.test>';
const TO = 'owner@example.test';

beforeEach(() => testOutbox.clear());
afterEach(() => vi.useRealTimers());

describe('createTestMailer', () => {
	it('records each message with an id, the configured addresses and the time it was sent', async () => {
		vi.useFakeTimers({ now: new Date('2026-11-06T09:30:00.000Z') });
		const mailer = createTestMailer({ from: FROM, to: TO });
		expect(mailer.provider).toBe('test');

		const { id } = await mailer.send({ subject: 'Sign in', text: 'Link: https://x.test/#t=abc' });
		expect(id).toMatch(/^test_[0-9a-f-]{36}$/);
		expect(testOutbox.list()).toEqual([
			{
				id,
				to: TO,
				from: FROM,
				subject: 'Sign in',
				text: 'Link: https://x.test/#t=abc',
				sentAt: new Date('2026-11-06T09:30:00.000Z')
			}
		]);
	});

	it('gives every message its own id', async () => {
		const mailer = createTestMailer({ from: FROM, to: TO });
		const first = await mailer.send({ subject: 'One', text: 'One.' });
		const second = await mailer.send({ subject: 'One', text: 'One.', idempotencyKey: 'k' });
		expect(first.id).not.toBe(second.id);
	});

	it('lists newest first', async () => {
		const mailer = createTestMailer({ from: FROM, to: TO });
		for (const subject of ['first', 'second', 'third']) await mailer.send({ subject, text: '.' });
		expect(testOutbox.list().map((m) => m.subject)).toEqual(['third', 'second', 'first']);
	});

	it(`keeps only the last ${TEST_OUTBOX_LIMIT} messages`, async () => {
		expect(TEST_OUTBOX_LIMIT).toBe(50);
		const mailer = createTestMailer({ from: FROM, to: TO });
		for (let n = 1; n <= TEST_OUTBOX_LIMIT + 7; n += 1) {
			await mailer.send({ subject: `#${n}`, text: '.' });
		}
		const subjects = testOutbox.list().map((m) => m.subject);
		expect(subjects).toHaveLength(TEST_OUTBOX_LIMIT);
		expect(subjects[0]).toBe(`#${TEST_OUTBOX_LIMIT + 7}`);
		expect(subjects.at(-1)).toBe('#8');
	});

	it('clear() empties the outbox', async () => {
		const mailer = createTestMailer({ from: FROM, to: TO });
		await mailer.send({ subject: 'x', text: '.' });
		testOutbox.clear();
		expect(testOutbox.list()).toEqual([]);
		await mailer.send({ subject: 'y', text: '.' });
		expect(testOutbox.list().map((m) => m.subject)).toEqual(['y']);
	});

	it('hands out copies, so a reader cannot rewrite what was sent', async () => {
		const mailer = createTestMailer({ from: FROM, to: TO });
		await mailer.send({ subject: 'x', text: '.' });
		const listed = testOutbox.list();
		listed.length = 0;
		expect(() => {
			(testOutbox.list()[0] as { to: string }).to = 'attacker@example.test';
		}).toThrow(TypeError);
		expect(testOutbox.list().map((m) => m.to)).toEqual([TO]);
	});

	it('only ever addresses the configured recipient', async () => {
		const mailer = createTestMailer({ from: FROM, to: TO });
		const smuggled = { subject: 'x', text: '.', to: 'attacker@example.test' } as MailMessage;
		await mailer.send(smuggled);
		await mailer.send({
			subject: 'y',
			text: '.',
			// @ts-expect-error send() takes no recipient: a mailer only writes to the one it was made for.
			to: 'attacker@example.test'
		});
		expect(testOutbox.list().map((m) => m.to)).toEqual([TO, TO]);
		expect(JSON.stringify(testOutbox.list())).not.toContain('attacker');
	});
});
