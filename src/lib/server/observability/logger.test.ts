import { DatabaseError } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger, serializeError } from './logger';

const SECRET = 'PRIVATE-BODYWEIGHT-82.4kg';

/** A Postgres error exactly as node-postgres builds it from the server's ErrorResponse. */
function postgresError(
	code: string,
	message: string,
	fields: Partial<DatabaseError> = {}
): DatabaseError {
	const error = new DatabaseError(message, 100, 'error');
	return Object.assign(error, { severity: 'ERROR', code, ...fields });
}

/** Drizzle's wrapper: SQL text + parameter values in the message, the driver error as cause. */
function queryError(cause: Error, params: unknown[]): Error {
	const query = 'insert into "web_vitals" ("value") values ($1)';
	return Object.assign(
		new Error(`Failed query: ${query}\nparams: ${params.join(',')}`, { cause }),
		{
			name: 'DrizzleQueryError',
			query,
			params
		}
	);
}

describe('serializeError', () => {
	it('withholds a data-exception message that quotes the offending value', () => {
		const pg = postgresError(
			'22P02',
			`invalid input syntax for type double precision: "${SECRET}"`,
			{ routine: 'float8in_internal', detail: `Failing row contains (${SECRET}).` }
		);
		const out = serializeError(queryError(pg, [SECRET]));

		expect(JSON.stringify(out)).not.toContain(SECRET);
		expect(out.message).toBe(
			'Failed query: insert into "web_vitals" ("value") values ($1)\nparams: [1 redacted]'
		);
		expect(out.cause).toMatchObject({
			code: '22P02',
			severity: 'ERROR',
			routine: 'float8in_internal',
			message: expect.stringContaining('22P02 (data exception)')
		});
		// The stack keeps its call frames under the safe first line.
		expect(String((out.cause as { stack: string }).stack)).toMatch(/^error: Postgres error 22P02/);
		expect(String((out.cause as { stack: string }).stack)).toMatch(/\n\s+at /);
	});

	it('withholds messages of classes that can quote values, including unknown ones', () => {
		for (const code of ['22003', '22007', 'P0001', 'XX000', '0A000']) {
			const out = serializeError(postgresError(code, `value "${SECRET}" is out of range`));
			expect(JSON.stringify(out), code).not.toContain(SECRET);
			expect(out.code).toBe(code);
		}
	});

	it('keeps identifier-only messages and fields that help diagnosis', () => {
		const out = serializeError(
			postgresError(
				'23514',
				'new row for relation "web_vitals" violates check constraint "web_vitals_name_check"',
				{
					table: 'web_vitals',
					constraint: 'web_vitals_name_check',
					detail: `Failing row contains (${SECRET}).`,
					hint: SECRET,
					where: SECRET
				}
			)
		);
		expect(out).toMatchObject({
			code: '23514',
			message: expect.stringContaining('violates check constraint "web_vitals_name_check"'),
			table: 'web_vitals',
			constraint: 'web_vitals_name_check'
		});
		expect(JSON.stringify(out)).not.toContain(SECRET);
		const timeout = serializeError(
			postgresError('57014', 'canceling statement due to statement timeout')
		);
		expect(timeout.message).toBe('canceling statement due to statement timeout');
	});

	it('leaves ordinary errors and non-errors alone', () => {
		const plain = serializeError(new Error('kaboom'));
		expect(plain).toMatchObject({ name: 'Error', message: 'kaboom' });
		expect(String(plain.stack)).toContain('kaboom');
		// Node system errors carry a non-SQLSTATE code and no severity.
		const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
			code: 'ECONNREFUSED'
		});
		expect(serializeError(refused)).toMatchObject({
			code: 'ECONNREFUSED',
			message: 'connect ECONNREFUSED 127.0.0.1:1'
		});
		expect(serializeError('string error')).toEqual({ message: 'string error' });
	});
});

describe('logger', () => {
	// A Blob token, concatenated so the secret scan does not read this file as a leak.
	const blobToken = 'vercel_blob_rw_' + 'StoreId123_abcDEF456ghi';

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	/** The first line the logger wrote to stderr, raw and parsed. */
	function firstLine(spy: { mock: { calls: unknown[][] } }) {
		const raw = String(spy.mock.calls[0]?.[0]);
		return { raw, entry: JSON.parse(raw) as Record<string, unknown> };
	}

	it('redacts a credential-named field and keeps the rest', () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		logger.error('cron: request refused', {
			authorization: 'Bearer abcdEFGH1234',
			path: '/api/cron/x'
		});
		const { raw, entry } = firstLine(spy);
		expect(entry).toMatchObject({ authorization: '[redacted]', path: '/api/cron/x' });
		expect(raw).not.toContain('abcdEFGH1234');
	});

	it('redacts a token quoted in the message of a nested cause', () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		logger.error('backup failed', {
			err: new Error('Blob put failed', {
				cause: new Error('token ' + blobToken + ' rejected')
			})
		});
		const { raw, entry } = firstLine(spy);
		expect(raw).not.toContain(blobToken);
		const err = entry.err as { cause: { message: string } };
		expect(err.cause.message).toContain('[redacted]');
	});

	it('never throws: a field that cannot be read writes a line marked unserializable', () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const fields = {
			get boom(): string {
				throw new Error('getter failed');
			}
		};
		expect(() => logger.error('cron: failed', fields)).not.toThrow();
		const { raw, entry } = firstLine(spy);
		expect(raw).toContain('[unserializable]');
		expect(entry).toMatchObject({ level: 'error', msg: 'cron: failed', error: '[unserializable]' });
	});

	it('redacts the exact value of a secret variable', () => {
		// Concatenated so the secret scan does not read this file as a leaked connection string.
		const dbUrl = 'postgres://coach:' + 'sentinelPw123' + '@db.example.test/coach';
		vi.stubEnv('DATABASE_URL', dbUrl);
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		logger.error('x', { err: new Error('connect failed for ' + dbUrl) });
		expect(firstLine(spy).raw).not.toContain('sentinelPw123');
	});
});
