/** createMailer picks the adapter the caller names, with exactly the options it was given. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMailer } from './index';
import { testOutbox } from './test-outbox';

const FROM = 'Coach <coach@example.test>';
const TO = 'owner@example.test';

beforeEach(() => testOutbox.clear());
afterEach(() => vi.restoreAllMocks());

describe('createMailer', () => {
	it('builds the recording mailer for the test provider', async () => {
		const mailer = createMailer({ provider: 'test', from: FROM, to: TO });
		expect(mailer.provider).toBe('test');
		await mailer.send({ subject: 'x', text: '.' });
		expect(testOutbox.list()).toMatchObject([{ to: TO, from: FROM, subject: 'x' }]);
	});

	it('builds the Resend mailer for the resend provider, with its fetch and recipient', async () => {
		const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
			Response.json({ id: 'resend-id' })
		);
		const mailer = createMailer({
			provider: 'resend',
			apiKey: 're_example_not_a_real_key',
			from: FROM,
			to: TO,
			fetch
		});
		expect(mailer.provider).toBe('resend');
		vi.spyOn(console, 'log').mockImplementation(() => {});
		await expect(mailer.send({ subject: 'x', text: '.' })).resolves.toEqual({ id: 'resend-id' });
		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, init] = fetch.mock.calls[0]!;
		expect(url).toBe('https://api.resend.com/emails');
		expect(JSON.parse(String(init?.body))).toMatchObject({ from: FROM, to: [TO] });
		expect(testOutbox.list()).toEqual([]);
	});
});
