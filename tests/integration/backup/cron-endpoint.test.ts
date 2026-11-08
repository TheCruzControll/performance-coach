/**
 * GET /api/cron/backup on real Postgres, called as SvelteKit calls it: the request guard
 * (hooks.server.ts runs it first), then the endpoint. Only `Authorization: Bearer <CRON_SECRET>`
 * opens it, a session never does, and the run it starts is the verified backup of the test
 * database into a folder store:
 * - 404 while CRON_SECRET is unset or too short; 405 for any method but GET
 * - 401 without the exact bearer, with the owner's session too, logged without the header
 * - 200 with the bearer: a file whose counts equal Postgres's, and no row in the answer
 * - 409 while another run holds the export's lock; 503 naming the missing variables; 500 with
 *   the run's code and request id
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guardRequest } from '../../../src/lib/server/auth/guard';
import { issueSession } from '../../../src/lib/server/auth/sessions';
import { readArchive } from '../../../src/lib/server/backup/archive';
import { openEnvelope } from '../../../src/lib/server/backup/envelope';
import { parseBackupKey } from '../../../src/lib/server/backup/key';
import { getDb } from '../../../src/lib/server/db';
import { backupClient } from '../../../src/lib/server/db/backup/connect';
import { BACKUP_LOCK_KEY } from '../../../src/lib/server/db/backup/export';
import { resetEnvCache } from '../../../src/lib/server/env';
import { setLogLevel } from '../../../src/lib/server/observability/logger';
import { config, GET, HEAD } from '../../../src/routes/api/cron/backup/+server';
import { withCommitted } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const ORIGIN = 'http://localhost:4173';
const SECRET = randomBytes(32).toString('base64url');
const KEY_TEXT = randomBytes(32).toString('base64');
const VARIABLES = ['CRON_SECRET', 'BACKUP_ENCRYPTION_KEY', 'BACKUP_DIR'] as const;
const REQUEST_ID = 'req-cron-test';

let dir: string;

/** Sets the backup variables for the next request (undefined: unset). */
function setEnv(values: Partial<Record<(typeof VARIABLES)[number], string>>) {
	for (const name of VARIABLES) {
		if (values[name] === undefined) delete process.env[name];
		else process.env[name] = values[name];
	}
	resetEnvCache();
}

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'coach-cron-'));
	setEnv({ CRON_SECRET: SECRET, BACKUP_ENCRYPTION_KEY: KEY_TEXT, BACKUP_DIR: dir });
});

afterEach(async () => {
	setEnv({});
	await rm(dir, { recursive: true, force: true });
	await getDb().execute(sql`delete from app_errors where kind = 'cron'`);
	setLogLevel('silent');
	vi.restoreAllMocks();
});

interface Call {
	method?: string;
	authorization?: string;
	/** The Origin header: the app's own by default, as a browser sends; null omits it. */
	origin?: string | null;
	/** A session cookie's token. */
	session?: string;
}

/** The request through the guard, then the endpoint, as hooks.server.ts runs them. */
async function call({ method = 'GET', authorization, session, origin = ORIGIN }: Call = {}) {
	const url = new URL(`${ORIGIN}/api/cron/backup`);
	const headers = new Headers(authorization === undefined ? {} : { authorization });
	if (origin !== null) headers.set('origin', origin);
	const jar = new Map(session === undefined ? [] : [['session', session]]);
	const event = {
		url,
		request: new Request(url, { method, headers }),
		route: { id: '/api/cron/backup' },
		locals: { session: null, requestId: REQUEST_ID },
		cookies: {
			get: (name: string) => jar.get(name),
			set: () => undefined,
			delete: () => undefined,
			serialize: () => ''
		}
	} as never as Parameters<typeof GET>[0];
	const response =
		(await guardRequest(event)) ?? (await (method === 'HEAD' ? HEAD(event) : GET(event)));
	return { response, locals: event.locals };
}

const bearer = `Bearer ${SECRET}`;

async function files(): Promise<string[]> {
	return (await readdir(dir, { recursive: true, withFileTypes: true }))
		.filter((entry) => entry.isFile())
		.map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)));
}

async function cronErrors() {
	const { rows } = await getDb().execute<{
		status: number;
		request_id: string;
		context: Record<string, unknown>;
	}>(sql`select status, request_id, context from app_errors where kind = 'cron' order by id`);
	return rows;
}

describe('GET /api/cron/backup', () => {
	it('answers 404 while CRON_SECRET is unset or too short, whatever the request carries', async () => {
		for (const secret of [undefined, 'short-secret-31-characters-long']) {
			setEnv({ CRON_SECRET: secret, BACKUP_ENCRYPTION_KEY: KEY_TEXT, BACKUP_DIR: dir });
			for (const request of [{}, { authorization: `Bearer ${secret}` }, { method: 'POST' }]) {
				const { response } = await call(request);
				expect(response.status, `${secret} ${JSON.stringify(request)}`).toBe(404);
				expect(await response.json()).toEqual({ error: 'not_found', message: 'Not found.' });
			}
		}
		expect(await files()).toEqual([]);
	});

	it('refuses a missing or wrong bearer with 401, the owner’s session included', async () => {
		await withCommitted(async (db) => {
			const ownerId = await makeOwner(db);
			const { token } = await issueSession({ ownerId, method: 'test', userAgent: null }, { db });
			const wrong = `${SECRET.slice(0, -1)}${SECRET.endsWith('A') ? 'B' : 'A'}`;
			for (const request of [
				{},
				{ session: token },
				{ authorization: `Bearer ${wrong}`, session: token },
				{ authorization: `bearer ${SECRET}` },
				{ authorization: `Basic ${Buffer.from(`cron:${SECRET}`).toString('base64')}` }
			]) {
				const { response, locals } = await call(request);
				expect(response.status, JSON.stringify(request)).toBe(401);
				expect(response.headers.get('cache-control')).toBe('no-store');
				expect(await response.json()).toMatchObject({ error: 'unauthorized' });
				// The guard never even resolved the session.
				expect(locals.session).toBeNull();
			}
		});
		expect(await files()).toEqual([]);
	});

	it('answers 405 to HEAD and POST, even with the bearer (403 cross-site), and runs nothing', async () => {
		for (const method of ['HEAD', 'POST', 'PUT', 'DELETE']) {
			const { response } = await call({ method, authorization: bearer });
			expect(response.status, method).toBe(405);
			expect(response.headers.get('allow')).toBe('GET');
		}
		// A cross-site or Origin-less POST is refused by the CSRF check first, as on every route.
		for (const origin of ['https://evil.example', null]) {
			const { response } = await call({ method: 'POST', authorization: bearer, origin });
			expect(response.status, String(origin)).toBe(403);
			expect(await response.json()).toMatchObject({ error: 'forbidden' });
		}
		// The endpoint's own HEAD answers the same, should the guard ever let one through.
		const direct = await HEAD({} as never);
		expect(direct.status).toBe(405);
		expect(await files()).toEqual([]);
	});

	it('logs a refusal with its reason, never the header', async () => {
		setLogLevel('debug');
		const lines: string[] = [];
		const capture = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
		vi.spyOn(console, 'log').mockImplementation(capture);
		vi.spyOn(console, 'error').mockImplementation(capture);
		const wrong = randomBytes(32).toString('base64url');

		await call({ authorization: `Bearer ${wrong}` });
		await call({ method: 'HEAD', authorization: bearer });

		const refusals = lines
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter((entry) => entry.msg === 'cron: request refused');
		expect(refusals).toMatchObject([
			{ method: 'GET', path: '/api/cron/backup', status: 401, reason: 'mismatch' },
			{ method: 'HEAD', status: 405, reason: 'method_not_allowed' }
		]);
		const text = lines.join('\n');
		for (const secret of [wrong, SECRET, 'Bearer', 'authorization']) {
			expect(text).not.toContain(secret);
		}
	});

	it('makes one verified backup with the bearer, answering names, sizes and counts only', async () => {
		const { response } = await call({ authorization: bearer });
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		const body = (await response.json()) as Record<string, unknown>;
		expect(Object.keys(body)).toEqual([
			'status',
			'pathname',
			'bytes',
			'sha256',
			'tables',
			'rows',
			'durationMs'
		]);
		expect(body.status).toBe('ok');
		expect(await files()).toEqual([body.pathname]);

		const file = await readFile(path.join(dir, String(body.pathname)));
		expect(body.bytes).toBe(file.length);
		expect(body.sha256).toBe(createHash('sha256').update(file).digest('hex'));
		const archive = readArchive(openEnvelope(parseBackupKey(KEY_TEXT, 'key'), file));
		expect(body.tables).toBe(archive.tables.length);
		expect(archive.tables.map((t) => t.name)).toEqual(expect.arrayContaining(['owners']));
		let rows = 0;
		for (const table of archive.tables) {
			const { rows: counted } = await getDb().execute<{ n: number }>(
				sql.raw(`select count(*)::int as n from public."${table.name}"`)
			);
			expect(table.rows.length, table.name).toBe(counted[0]!.n);
			rows += table.rows.length;
		}
		expect(body.rows).toBe(rows);
	});

	it('answers 409 while another run holds the export’s lock, and records nothing', async () => {
		const holder = await backupClient(process.env.DATABASE_URL!);
		try {
			await holder.query('SELECT pg_advisory_lock($1)', [BACKUP_LOCK_KEY]);
			const { response } = await call({ authorization: bearer });
			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({ error: 'already_running' });
		} finally {
			await holder.end();
		}
		expect(await files()).toEqual([]);
		expect(await cronErrors()).toEqual([]);
	});

	it('answers 503 naming the missing variables while backups are off', async () => {
		setEnv({ CRON_SECRET: SECRET });
		const { response } = await call({ authorization: bearer });
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: 'backup_not_configured',
			missing: ['BACKUP_ENCRYPTION_KEY', 'BLOB_READ_WRITE_TOKEN'],
			invalid: []
		});
		expect(await cronErrors()).toMatchObject([
			{ status: 503, request_id: REQUEST_ID, context: { code: 'backup_not_configured' } }
		]);
	});

	it('answers 500 with the run’s code and request id when the upload fails', async () => {
		// A folder store under a regular file can never write.
		const blocked = path.join(dir, 'not-a-folder');
		await writeFile(blocked, '');
		setEnv({ CRON_SECRET: SECRET, BACKUP_ENCRYPTION_KEY: KEY_TEXT, BACKUP_DIR: blocked });
		const { response } = await call({ authorization: bearer });
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: 'upload_failed', requestId: REQUEST_ID });
		expect(await cronErrors()).toMatchObject([
			{ status: 500, request_id: REQUEST_ID, context: { code: 'upload_failed', trigger: 'cron' } }
		]);
	});

	it('may run 60 seconds on Vercel: Hobby’s limit, with or without Fluid compute', () => {
		expect(config.maxDuration).toBe(60);
	});
});
