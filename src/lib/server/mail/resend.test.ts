/**
 * The Resend adapter against a fake fetch: the exact request, every way an answer can fail, the
 * timeout, and that neither the API key, the recipient nor the message text (which will hold a
 * sign-in token) ever reaches an error or a log line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeError, setLogLevel } from '../observability/logger';
import { createResendMailer, RESEND_EMAILS_URL, RESEND_TIMEOUT_MS } from './resend';
import { MailError, type MailErrorCode, type MailMessage } from './types';

const KEY = 're_example_not_a_real_key';
const FROM = 'Coach <coach@example.test>';
const TO = 'owner@example.test';
const TEXT = 'Sign in: https://coach.example.test/?link#t=SECRET-TOKEN-0123456789';
const MESSAGE: MailMessage = { subject: 'Your sign-in link', text: TEXT, idempotencyKey: 'link-1' };
const RESEND_ID = '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794';

/** Values that must never appear in an error, a serialized error or a log line. */
const SECRETS = [KEY, TO, TEXT, 'SECRET-TOKEN'];

type FetchArgs = [input: string | URL | Request, init?: RequestInit];

/** A fetch that records each call and answers with `answer`. */
function fakeFetch(answer: (init: RequestInit) => Promise<Response> | Response) {
	return vi.fn(async (...[, init]: FetchArgs) => answer(init ?? {}));
}

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A fetch that never answers until its signal aborts, as a hung connection behaves. */
const hungFetch = () =>
	fakeFetch(
		(init) =>
			new Promise<Response>((_, reject) => {
				init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
			})
	);

let logged: string[] = [];

beforeEach(() => {
	logged = [];
	const capture = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
	vi.spyOn(console, 'log').mockImplementation(capture);
	vi.spyOn(console, 'error').mockImplementation(capture);
	setLogLevel('debug');
});

afterEach(() => {
	setLogLevel('silent');
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const mailer = (fetch: ReturnType<typeof fakeFetch>, timeoutMs?: number) =>
	createResendMailer({ apiKey: KEY, from: FROM, to: TO, fetch, timeoutMs });

/** The MailError `send` rejected with. */
async function failure(promise: Promise<unknown>): Promise<MailError> {
	const error = await promise.then(
		() => undefined,
		(reason: unknown) => reason
	);
	expect(error).toBeInstanceOf(MailError);
	return error as MailError;
}

function expectNoSecrets(error?: MailError) {
	const surfaces = [...logged];
	if (error)
		surfaces.push(error.message, String(error.stack), JSON.stringify(serializeError(error)));
	for (const surface of surfaces) {
		for (const secret of SECRETS) expect(surface).not.toContain(secret);
	}
}

describe('createResendMailer: the request', () => {
	it('posts plain text to Resend with the key, the idempotency key and the configured recipient', async () => {
		const fetch = fakeFetch(() => json(200, { id: RESEND_ID }));
		await mailer(fetch).send(MESSAGE);

		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, init] = fetch.mock.calls[0]!;
		expect(url).toBe('https://api.resend.com/emails');
		expect(RESEND_EMAILS_URL).toBe(url);
		expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
		expect(init?.signal).toBeInstanceOf(AbortSignal);
		expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
			authorization: `Bearer ${KEY}`,
			'content-type': 'application/json',
			'idempotency-key': 'link-1'
		});
		expect(JSON.parse(String(init?.body))).toEqual({
			from: FROM,
			to: [TO],
			subject: 'Your sign-in link',
			text: TEXT
		});
	});

	it('sends no Idempotency-Key header when the message has none', async () => {
		const fetch = fakeFetch(() => json(200, { id: RESEND_ID }));
		await mailer(fetch).send({ subject: 'Hi', text: 'Plain.' });
		const headers = new Headers(fetch.mock.calls[0]![1]?.headers);
		expect(headers.has('idempotency-key')).toBe(false);
	});

	it('always addresses the configured recipient, whatever else a caller slips in', async () => {
		const fetch = fakeFetch(() => json(200, { id: RESEND_ID }));
		const smuggled = {
			...MESSAGE,
			to: 'attacker@example.test',
			cc: 'attacker@example.test',
			bcc: ['attacker@example.test'],
			reply_to: 'attacker@example.test',
			html: '<img src="https://tracker.example.test/p.gif">'
		} as MailMessage;
		await mailer(fetch).send(smuggled);
		const body = JSON.parse(String(fetch.mock.calls[0]![1]?.body));
		expect(Object.keys(body).sort()).toEqual(['from', 'subject', 'text', 'to']);
		expect(body.to).toEqual([TO]);
		expect(String(fetch.mock.calls[0]![1]?.body)).not.toContain('attacker');
	});

	it('makes exactly one attempt, even when Resend fails', async () => {
		const fetch = fakeFetch(() => json(500, { name: 'internal_server_error', statusCode: 500 }));
		await failure(mailer(fetch).send(MESSAGE));
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});

describe('createResendMailer: the answer', () => {
	it("returns Resend's id for a 2xx answer and logs only the status and the id", async () => {
		const fetch = fakeFetch(() => json(200, { id: RESEND_ID }));
		const sent = mailer(fetch);
		expect(sent.provider).toBe('resend');
		await expect(sent.send(MESSAGE)).resolves.toEqual({ id: RESEND_ID });

		expect(logged).toHaveLength(1);
		const entry = JSON.parse(logged[0]!);
		expect(entry).toMatchObject({ level: 'info', msg: 'mail: sent', status: 200, id: RESEND_ID });
		expect(Object.keys(entry).sort()).toEqual(['id', 'level', 'msg', 'status', 'time']);
		expectNoSecrets();
	});

	const REFUSALS: [status: number, name: string][] = [
		[401, 'missing_api_key'],
		[403, 'invalid_api_key'],
		[422, 'validation_error'],
		[429, 'rate_limit_exceeded'],
		[500, 'internal_server_error']
	];

	for (const [status, name] of REFUSALS) {
		it(`turns a ${status} into a 'rejected' MailError with the status and the error name only`, async () => {
			// Resend's messages can quote the request (the recipient, the sender): never kept.
			const fetch = fakeFetch(() =>
				json(status, { statusCode: status, name, message: `Invalid \`to\` field: ${TO} ${KEY}` })
			);
			const error = await failure(mailer(fetch).send(MESSAGE));
			expect(error).toMatchObject({
				name: 'MailError',
				code: 'rejected',
				status,
				providerError: name
			});
			expect(error.message).toBe(`The mail provider refused the message (HTTP ${status}, ${name})`);
			expect(logged.map((line) => JSON.parse(line))).toEqual([
				expect.objectContaining({
					level: 'warn',
					msg: 'mail: not sent',
					code: 'rejected',
					status,
					providerError: name
				})
			]);
			expectNoSecrets(error);
		});
	}

	it('keeps no error name that is not a plain Resend name', async () => {
		for (const body of [{ name: `bad ${TEXT}` }, { name: 42 }, 'Bad Gateway', '']) {
			logged = [];
			const fetch = fakeFetch(() =>
				typeof body === 'string' ? new Response(body, { status: 502 }) : json(502, body)
			);
			const error = await failure(mailer(fetch).send(MESSAGE));
			expect(error).toMatchObject({ code: 'rejected', status: 502, providerError: undefined });
			expect(error.message).toBe('The mail provider refused the message (HTTP 502)');
			expectNoSecrets(error);
		}
	});

	it("refuses a redirect rather than following it with the key: it is the redirect's status", async () => {
		const fetch = fakeFetch(
			() => new Response(null, { status: 307, headers: { Location: 'https://elsewhere.test/' } })
		);
		const error = await failure(mailer(fetch).send(MESSAGE));
		expect(error).toMatchObject({ code: 'rejected', status: 307 });
	});

	it("calls a 2xx answer without a usable id 'malformed'", async () => {
		const bodies = ['not json', '{}', '{"id":""}', '{"id":42}', `{"id":"${TEXT}"}`, 'null'];
		for (const body of bodies) {
			const fetch = fakeFetch(() => new Response(body, { status: 200 }));
			const error = await failure(mailer(fetch).send(MESSAGE));
			expect(error, body).toMatchObject({ code: 'malformed', status: 200 });
			expect(error.message).toBe('The mail provider answered HTTP 200 without a message id');
			expectNoSecrets(error);
		}
	});
});

describe('createResendMailer: network failures and the timeout', () => {
	it("turns a throwing fetch into 'network', without the thrown message", async () => {
		// A bad header value makes fetch throw with the value itself in the message.
		const fetch = fakeFetch(() => {
			throw new TypeError(`Headers.append: "Bearer ${KEY}" is an invalid header value (${TEXT})`);
		});
		const error = await failure(mailer(fetch).send(MESSAGE));
		expect(error).toMatchObject({ code: 'network', status: undefined, providerError: undefined });
		expect(error.message).toBe('The mail provider could not be reached');
		expect(error.cause).toBeUndefined();
		expectNoSecrets(error);
	});

	it(`aborts a hung request at ${RESEND_TIMEOUT_MS} ms by default and calls it 'timeout'`, async () => {
		expect(RESEND_TIMEOUT_MS).toBe(10_000);
		vi.useFakeTimers();
		const fetch = hungFetch();
		const settled = vi.fn();
		const sending = mailer(fetch).send(MESSAGE);
		sending.then(settled, settled);

		await vi.advanceTimersByTimeAsync(RESEND_TIMEOUT_MS - 1);
		expect(settled).not.toHaveBeenCalled();
		expect(fetch.mock.calls[0]![1]?.signal?.aborted).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		const error = await failure(sending);
		expect(error).toMatchObject({ code: 'timeout', status: undefined });
		expect(error.message).toBe(`The mail provider did not answer within ${RESEND_TIMEOUT_MS} ms`);
		expect(fetch.mock.calls[0]![1]?.signal?.aborted).toBe(true);
		expectNoSecrets(error);
	});

	it('honours a shorter timeout', async () => {
		vi.useFakeTimers();
		const sending = mailer(hungFetch(), 250).send(MESSAGE);
		const result = failure(sending);
		await vi.advanceTimersByTimeAsync(250);
		expect(await result).toMatchObject({ code: 'timeout' });
	});

	/** A response whose body never finishes until the request's signal aborts. */
	const stalledBody = (status: number) =>
		fakeFetch((init) => {
			const body = new ReadableStream({
				start(controller) {
					init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
				}
			});
			return new Response(body, { status });
		});

	it('times out a 2xx whose body never finishes, since the id is in the body', async () => {
		vi.useFakeTimers();
		const result = failure(mailer(stalledBody(200)).send(MESSAGE));
		await vi.advanceTimersByTimeAsync(RESEND_TIMEOUT_MS);
		expect(await result).toMatchObject({ code: 'timeout', status: 200 });
	});

	it('still calls a refusal whose body never finishes "rejected", with its status', async () => {
		vi.useFakeTimers();
		const result = failure(mailer(stalledBody(503)).send(MESSAGE));
		await vi.advanceTimersByTimeAsync(RESEND_TIMEOUT_MS);
		expect(await result).toMatchObject({ code: 'rejected', status: 503, providerError: undefined });
	});

	it('clears its timer once Resend has answered', async () => {
		vi.useFakeTimers();
		await mailer(fakeFetch(() => json(200, { id: RESEND_ID }))).send(MESSAGE);
		expect(vi.getTimerCount()).toBe(0);
		await failure(mailer(fakeFetch(() => json(500, {}))).send(MESSAGE));
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('MailError', () => {
	it('builds its message from the code, the status and the error name only', () => {
		const cases: [MailErrorCode, ConstructorParameters<typeof MailError>[1], string][] = [
			[
				'rejected',
				{ status: 422, providerError: 'validation_error' },
				'HTTP 422, validation_error'
			],
			['timeout', { timeoutMs: 10_000 }, 'within 10000 ms'],
			['network', {}, 'could not be reached'],
			['malformed', { status: 200 }, 'HTTP 200 without a message id']
		];
		for (const [code, details, fragment] of cases) {
			const error = new MailError(code, details);
			expect(error.code).toBe(code);
			expect(error.message).toContain(fragment);
			expect(serializeError(error)).toMatchObject({ name: 'MailError', code });
		}
	});
});
