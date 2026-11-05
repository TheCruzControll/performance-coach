import { DatabaseError } from 'pg';
import { describe, expect, it } from 'vitest';
import { serializeError } from './logger';

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
