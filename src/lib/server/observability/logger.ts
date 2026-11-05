/**
 * Minimal structured logger: one JSON object per line on stdout/stderr.
 *
 * Vercel (and any log drain) ingests stdout line-by-line, so JSON lines are searchable without
 * a logging SDK. The request context (request id) is attached automatically when available.
 */
import { currentContext } from './context';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type Threshold = LogLevel | 'silent';

const ORDER: Record<Threshold, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

function resolveThreshold(): Threshold {
	const raw = process.env.LOG_LEVEL;
	if (raw && raw in ORDER) return raw as Threshold;
	return process.env.NODE_ENV === 'test' ? 'warn' : 'info';
}

let threshold: Threshold = resolveThreshold();

/** Override the log threshold (tests, scripts). */
export function setLogLevel(level: Threshold): void {
	threshold = level;
}

/** Drizzle's query error: its message embeds the SQL text *and every parameter value*. */
function isQueryError(error: Error): error is Error & { query: string; params: unknown[] } {
	const candidate = error as { query?: unknown; params?: unknown };
	return typeof candidate.query === 'string' && Array.isArray(candidate.params);
}

/** A Postgres server error as node-postgres reports it (`DatabaseError`): SQLSTATE + fields. */
interface PostgresError extends Error {
	code: string;
	severity: string;
	routine?: string;
	schema?: string;
	table?: string;
	column?: string;
	dataType?: string;
	constraint?: string;
}

function isPostgresError(error: Error): error is PostgresError {
	const candidate = error as { code?: unknown; severity?: unknown };
	return (
		typeof candidate.code === 'string' &&
		/^[0-9A-Z]{5}$/.test(candidate.code) &&
		typeof candidate.severity === 'string'
	);
}

/**
 * SQLSTATE classes whose primary message names only identifiers from our own SQL (tables,
 * columns, constraints, types) or server state, never a data value: Postgres puts the offending
 * values of these errors in DETAIL, which is never logged. Every other class, notably 22 (data
 * exception: `invalid input syntax for type double precision: "<value>"`) and P0 (raised by
 * PL/pgSQL), can quote a value in the message itself, so that message is withheld.
 */
const IDENTIFIER_ONLY_CLASSES: Record<string, string> = {
	'08': 'connection exception',
	'23': 'integrity constraint violation',
	'25': 'invalid transaction state',
	'40': 'transaction rollback',
	'42': 'syntax error or access rule violation',
	'53': 'insufficient resources',
	'54': 'program limit exceeded',
	'55': 'object not in prerequisite state',
	'57': 'operator intervention'
};
const WITHHELD_CLASSES: Record<string, string> = {
	'22': 'data exception',
	P0: 'PL/pgSQL error',
	XX: 'internal error'
};

/** The message a Postgres error may be logged with. */
function postgresMessage(error: PostgresError): string {
	const cls = error.code.slice(0, 2);
	if (IDENTIFIER_ONLY_CLASSES[cls]) return error.message;
	const label = WITHHELD_CLASSES[cls] ?? `class ${cls}`;
	return `Postgres error ${error.code} (${label}); message withheld because it can quote query values`;
}

/** Identifier-only fields of a Postgres error (no DETAIL, HINT, WHERE or internal query). */
function postgresFields(error: PostgresError): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const key of ['routine', 'schema', 'table', 'column', 'dataType', 'constraint'] as const) {
		const value = error[key];
		if (typeof value === 'string' && value) fields[key] = value;
	}
	return fields;
}

/** The stack's call frames under a new first line, so a replaced message cannot survive in it. */
function restack(error: Error, message: string): string | undefined {
	if (!error.stack) return undefined;
	const frames = error.stack.split('\n').filter((line) => /^\s+at /.test(line));
	return [`${error.name}: ${message}`, ...frames].join('\n');
}

/**
 * Serialize an unknown thrown value into a log-safe object. Values that may carry personal
 * training data are never included: Drizzle's query parameters are redacted (the SQL text is
 * kept), and a Postgres error keeps its SQLSTATE `code`, severity, routine and identifier
 * fields, plus its message only for classes that never quote values (see above).
 */
export function serializeError(error: unknown): Record<string, unknown> {
	if (error instanceof Error) {
		let { message, stack } = error;
		let extra: Record<string, string> = {};
		if (isQueryError(error)) {
			message = `Failed query: ${error.query}\nparams: [${error.params.length} redacted]`;
			stack = restack(error, message);
		} else if (isPostgresError(error)) {
			message = postgresMessage(error);
			if (message !== error.message) stack = restack(error, message);
			extra = { severity: error.severity, ...postgresFields(error) };
		}
		const code = (error as { code?: unknown }).code;
		return {
			name: error.name,
			message,
			stack,
			...(typeof code === 'string' ? { code } : {}),
			...extra,
			...(error.cause !== undefined ? { cause: serializeError(error.cause) } : {})
		};
	}
	return { message: String(error) };
}

function write(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
	if (ORDER[level] < ORDER[threshold]) return;
	const ctx = currentContext();
	const entry: Record<string, unknown> = {
		level,
		time: new Date().toISOString(),
		msg,
		...(ctx ? { requestId: ctx.requestId } : {}),
		...fields
	};
	if (entry.err !== undefined) entry.err = serializeError(entry.err);
	const line = JSON.stringify(entry);
	if (level === 'error' || level === 'warn') console.error(line);
	else console.log(line);
}

export const logger = {
	debug: (msg: string, fields?: Record<string, unknown>) => write('debug', msg, fields),
	info: (msg: string, fields?: Record<string, unknown>) => write('info', msg, fields),
	warn: (msg: string, fields?: Record<string, unknown>) => write('warn', msg, fields),
	error: (msg: string, fields?: Record<string, unknown>) => write('error', msg, fields)
};
