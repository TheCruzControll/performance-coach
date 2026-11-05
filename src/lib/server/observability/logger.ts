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

/**
 * Serialize an unknown thrown value into a log-safe object. Query parameter values are
 * redacted (they will carry personal training data); the SQL text and the driver's error
 * (`cause`, with its SQLSTATE `code`) are kept for diagnosis.
 */
export function serializeError(error: unknown): Record<string, unknown> {
	if (error instanceof Error) {
		let { message, stack } = error;
		if (isQueryError(error)) {
			message = `Failed query: ${error.query}\nparams: [${error.params.length} redacted]`;
			stack = stack?.replace(error.message, message);
		}
		const code = (error as { code?: unknown }).code;
		return {
			name: error.name,
			message,
			stack,
			...(typeof code === 'string' ? { code } : {}),
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
