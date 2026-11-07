/**
 * The email sign-in link's endpoints (ADR 0011), their handlers called with constructed
 * RequestEvents on real Postgres: 404 while switched off, the request's one answer whatever
 * happens after it, the redeem's session cookie, and the test-only outbox route.
 *
 * `waitUntil` is replaced by a defer that keeps each promise, so a test can hold the deferred
 * work, or wait for it and read what it did.
 */
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateSessionToken } from '../../../src/lib/server/auth/sessions';
import { resetEnvCache } from '../../../src/lib/server/env';
import { createTestMailer, testOutbox } from '../../../src/lib/server/mail';
import { POST as requestLink } from '../../../src/routes/api/auth/email-link/request/+server';
import * as verifyRoute from '../../../src/routes/api/auth/email-link/verify/+server';
import {
	DELETE as clearMail,
	GET as listMail
} from '../../../src/routes/api/test-support/mail/+server';
import { holdTransaction, lockWaiters, withCommitted } from '../helpers';
import { ORIGIN, setUpOwner, UA } from './fixtures';

const deferred = vi.hoisted(() => [] as Promise<unknown>[]);
vi.mock('@vercel/functions', () => ({
	waitUntil: (promise: Promise<unknown>) => void deferred.push(promise)
}));

const OWNER_EMAIL = 'owner@example.test';
const ENV_KEYS = ['OWNER_EMAIL', 'ENABLE_TEST_ROUTES', 'RESEND_API_KEY', 'EMAIL_FROM'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
	for (const key of ENV_KEYS) {
		if (values[key] === undefined) delete process.env[key];
		else process.env[key] = values[key];
	}
	resetEnvCache();
}

/** On, with the recording test provider (as on the e2e server). */
const ON = { OWNER_EMAIL, ENABLE_TEST_ROUTES: 'true' };

beforeEach(() => {
	setEnv(ON);
	testOutbox.clear();
	deferred.length = 0;
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
	resetEnvCache();
});

let n = 0;
interface SetCookie {
	name: string;
	value: string;
	options: Record<string, unknown>;
}

/** A RequestEvent as SvelteKit builds it, for what these handlers read. */
function event(
	path: string,
	{
		method = 'POST',
		origin = ORIGIN,
		ip = '203.0.113.10',
		body
	}: { method?: string; origin?: string; ip?: string; body?: string } = {}
) {
	n += 1;
	const url = new URL(path, origin);
	const setCookies: SetCookie[] = [];
	const request = new Request(url, {
		method,
		headers: { origin: url.origin, 'user-agent': UA, 'content-type': 'application/json' },
		body
	});
	const ev = {
		url,
		request,
		params: {},
		route: { id: path },
		getClientAddress: () => ip,
		locals: { requestId: `email-link-route-${n}`, session: null },
		cookies: {
			get: () => undefined,
			set: (name: string, value: string, options: Record<string, unknown>) =>
				void setCookies.push({ name, value, options })
		},
		setHeaders: () => {}
	};
	return { ev: ev as never, request, setCookies };
}

const REQUEST = '/api/auth/email-link/request';
const VERIFY = '/api/auth/email-link/verify';
const MAIL = '/api/test-support/mail';

const post = async (path: string, options?: Parameters<typeof event>[1]) =>
	path === REQUEST
		? requestLink(event(path, options).ev)
		: verifyRoute.POST(event(path, options).ev);

/** Wait for the deferred work, one promise at a time; returns what each led to. */
async function settle(): Promise<unknown[]> {
	const outcomes: unknown[] = [];
	for (const promise of deferred.splice(0)) outcomes.push(await promise);
	return outcomes;
}

/** Everything a requester can observe of an answer. */
async function observable(response: Response) {
	return {
		status: response.status,
		body: await response.text(),
		headers: [...response.headers.entries()]
	};
}

const sentToken = () => /#t=([A-Za-z0-9_-]{43})/.exec(testOutbox.list()[0]?.text ?? '')?.[1];

/** A link requested through the endpoint, its deferred work done: its token. */
async function linkToken(ip: string): Promise<string> {
	await post(REQUEST, { ip });
	expect(await settle()).toEqual(['sent']);
	const token = sentToken();
	if (!token) throw new Error('no link in the outbox');
	return token;
}

/** The status a handler that throws SvelteKit's error() answers with. */
async function thrownStatus(answer: () => unknown): Promise<number | undefined> {
	try {
		await answer();
	} catch (err) {
		return (err as { status?: number }).status;
	}
	return undefined;
}

describe('switched off', () => {
	it('answers 404 on all three routes without OWNER_EMAIL, and starts no work', async () => {
		setEnv({ ENABLE_TEST_ROUTES: 'true' });
		for (const path of [REQUEST, VERIFY]) {
			const res = await post(path, { body: JSON.stringify({ token: 'x'.repeat(43) }) });
			expect(res.status, path).toBe(404);
			expect(await res.json(), path).toEqual({ error: 'not_found', message: 'Not found.' });
			expect(res.headers.get('cache-control'), path).toBe('no-store');
		}
		expect(await thrownStatus(() => listMail(event(MAIL, { method: 'GET' }).ev))).toBe(404);
		expect(await thrownStatus(() => clearMail(event(MAIL, { method: 'DELETE' }).ev))).toBe(404);
		expect(deferred).toEqual([]);
	});

	it('answers 404 on both endpoints when the relying party does not resolve', async () => {
		for (const path of [REQUEST, VERIFY]) {
			const res = await post(path, {
				origin: 'http://127.0.0.1:4173',
				body: JSON.stringify({ token: 'x'.repeat(43) })
			});
			expect(res.status, path).toBe(404);
		}
		expect(deferred).toEqual([]);
	});
});

describe('POST /api/auth/email-link/request', () => {
	it('gives one answer whether a link is sent, a limit is hit or there is no owner', async () => {
		await withCommitted(async (db) => {
			const answers: Awaited<ReturnType<typeof observable>>[] = [];
			const outcomes: unknown[] = [];
			const ask = async (ip: string) => {
				answers.push(await observable(await post(REQUEST, { ip })));
				outcomes.push(...(await settle()));
			};

			await ask('203.0.113.1'); // no owner yet
			await setUpOwner(db);
			await ask('203.0.113.2'); // sent
			for (let i = 0; i < 5; i += 1) {
				await post(REQUEST, { ip: '203.0.113.3' });
				expect(await settle()).toEqual(['sent']);
			}
			await ask('203.0.113.3'); // the 6th from one client in 15 minutes
			await db.execute(
				sql`insert into auth_rate_limits (key, window_start, count)
					values ('email.daily:global', now(), 20)
					on conflict (key) do update set count = 20`
			);
			await ask('203.0.113.4'); // the 21st today

			expect(outcomes).toEqual(['refused', 'sent', 'rate_limited', 'rate_limited']);
			const limited = await db.execute<{ bucket: string }>(
				sql`select detail->>'bucket' as bucket from auth_events
					where type = 'rate_limited' order by id`
			);
			expect(limited.rows.map((r) => r.bucket)).toEqual(['email.request', 'email.daily']);

			expect(answers[0]).toEqual({
				status: 202,
				body: JSON.stringify({ ok: true }),
				headers: [
					['cache-control', 'no-store'],
					['content-length', '11'],
					['content-type', 'application/json']
				]
			});
			for (const answer of answers) expect(answer).toEqual(answers[0]);
		});
	});

	it('answers while the deferred work is still held', async () => {
		await withCommitted(async (db) => {
			await setUpOwner(db);
			// Every rate-limit counter waits on this lock: the work stops at its first query.
			const held = await holdTransaction((tx) =>
				tx.execute(sql`lock table auth_rate_limits in exclusive mode`)
			);
			const answered = await Promise.race([
				Promise.resolve(post(REQUEST)),
				new Promise((resolve) => setTimeout(() => resolve('still waiting'), 2_000))
			]);
			expect(answered).toBeInstanceOf(Response);
			expect((answered as Response).status).toBe(202);
			await lockWaiters(1);
			expect(testOutbox.list()).toEqual([]);

			await held.commit();
			expect(await settle()).toEqual(['sent']);
			expect(testOutbox.list()).toHaveLength(1);
		});
	});

	it('never reads the body: an address in it changes nothing', async () => {
		await withCommitted(async (db) => {
			await setUpOwner(db);
			const attacker = 'attacker@example.test';
			const { ev, request } = event(REQUEST, {
				body: JSON.stringify({ email: attacker, to: attacker, ownerEmail: attacker })
			});
			expect((await requestLink(ev)).status).toBe(202);
			expect(request.bodyUsed).toBe(false);
			expect(await settle()).toEqual(['sent']);
			const mails = testOutbox.list();
			expect(mails.map((m) => m.to)).toEqual([OWNER_EMAIL]);
			expect(JSON.stringify(mails)).not.toContain(attacker);
		});
	});
});

describe('POST /api/auth/email-link/verify', () => {
	it('sets the session cookie and sends the owner to Today, over HTTP and HTTPS', async () => {
		await withCommitted(async (db) => {
			await setUpOwner(db);
			const cases = [
				{ origin: ORIGIN, name: 'session', secure: false },
				{ origin: 'https://localhost:4173', name: '__Host-session', secure: true }
			];
			for (const [i, { origin, name, secure }] of cases.entries()) {
				const token = await linkToken(`203.0.113.${20 + i}`);
				const { ev, setCookies } = event(VERIFY, { origin, body: JSON.stringify({ token }) });
				const res = await verifyRoute.POST(ev);
				expect(res.status, origin).toBe(200);
				expect(await res.json(), origin).toEqual({ ok: true, redirectTo: '/today' });
				expect(res.headers.get('cache-control'), origin).toBe('no-store');

				expect(setCookies, origin).toEqual([
					{
						name,
						value: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
						options: {
							path: '/',
							httpOnly: true,
							sameSite: 'lax',
							secure,
							expires: expect.any(Date)
						}
					}
				]);
				const issued = await validateSessionToken(setCookies[0]!.value);
				expect(issued?.session, origin).toMatchObject({ kind: 'owner', reauthenticatedAt: null });
				const method = await db.execute<{ method: string }>(
					sql`select method from auth_sessions where id = ${issued!.session.id}`
				);
				expect(method.rows, origin).toEqual([{ method: 'email_link' }]);
			}
		});
	});

	it('answers 401 link_invalid to a bogus token and sets no cookie', async () => {
		await withCommitted(async (db) => {
			await setUpOwner(db);
			const { ev, setCookies } = event(VERIFY, {
				body: JSON.stringify({ token: 'A'.repeat(43) })
			});
			const res = await verifyRoute.POST(ev);
			expect(res.status).toBe(401);
			expect(await res.json()).toMatchObject({ error: 'link_invalid' });
			expect(setCookies).toEqual([]);
		});
	});

	it('refuses a body far larger than a token before reading a link', async () => {
		const res = await post(VERIFY, { body: JSON.stringify({ token: 'A'.repeat(2_000) }) });
		expect(res.status).toBe(422);
		expect(await res.json()).toEqual({ error: 'invalid_input', message: 'Request too large.' });
	});

	it('has no GET handler (SvelteKit answers 405), so a prefetch leaves the link usable', async () => {
		const methods = Object.keys(verifyRoute).filter((k) => /^[A-Z]+$/.test(k));
		expect(methods).toEqual(['POST']);
		await withCommitted(async (db) => {
			await setUpOwner(db);
			const token = await linkToken('203.0.113.30');
			const res = await post(VERIFY, { body: JSON.stringify({ token }) });
			expect(res.status).toBe(200);
		});
	});
});

describe('/api/test-support/mail', () => {
	const fields = ['from', 'sentAt', 'subject', 'text', 'to'];

	it('lists the outbox newest first, and clears it', async () => {
		const mailer = createTestMailer({ from: 'Coach <coach@example.test>', to: OWNER_EMAIL });
		await mailer.send({ subject: 'first', text: 'one' });
		await mailer.send({ subject: 'second', text: 'two' });

		const res = await listMail(event(MAIL, { method: 'GET' }).ev);
		expect(res.headers.get('cache-control')).toBe('no-store');
		const { messages } = (await res.json()) as { messages: Record<string, unknown>[] };
		expect(messages.map((m) => m.subject)).toEqual(['second', 'first']);
		expect(Object.keys(messages[0]!).sort()).toEqual(fields);
		expect(messages[0]).toMatchObject({ to: OWNER_EMAIL, text: 'two' });

		const cleared = await clearMail(event(MAIL, { method: 'DELETE' }).ev);
		expect(cleared.status).toBe(204);
		expect(testOutbox.list()).toEqual([]);
	});

	it('answers 404 with test routes disabled, and leaves the outbox alone', async () => {
		setEnv({ OWNER_EMAIL, ENABLE_TEST_ROUTES: 'false', RESEND_API_KEY: 're_test_key' });
		await createTestMailer({ from: 'c@example.test', to: OWNER_EMAIL }).send({
			subject: 'kept',
			text: '.'
		});
		expect(await thrownStatus(() => listMail(event(MAIL, { method: 'GET' }).ev))).toBe(404);
		expect(await thrownStatus(() => clearMail(event(MAIL, { method: 'DELETE' }).ev))).toBe(404);
		expect(testOutbox.list()).toHaveLength(1);
	});
});
