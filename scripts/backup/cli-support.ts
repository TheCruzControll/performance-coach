/**
 * What the backup operator commands (backup:run, backup:list, backup:keygen) share: argument
 * parsing with a usage text, the redacted name of a database URL, and a typed confirmation, with
 * the same guard rails as auth:reset-owner. Every refusal exits with REFUSED before anything is
 * connected, written or uploaded.
 *
 * Imported by path with relative .ts specifiers, so plain Node runs it.
 */
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';

/** Exit codes: done; failed (a run, a stale store, a probe, a mismatch); refused before acting. */
export const EXIT = { ok: 0, failed: 1, refused: 2 } as const;

/** A command line or environment that cannot run; its message is printed and it exits 2. */
export class Refusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'Refusal';
	}
}

type Options = NonNullable<ParseArgsConfig['options']> & { help: { type: 'boolean' } };
type Values<O extends Options> = ReturnType<
	typeof parseArgs<{ options: O; strict: true; allowPositionals: false }>
>['values'];

/**
 * The parsed flags, or null after printing `usage` for --help (every command takes it). An
 * unknown flag or a stray argument is a Refusal that repeats the usage.
 */
export function parseCommand<O extends Options>(
	argv: string[],
	options: O,
	usage: string
): Values<O> | null {
	let values: Values<O>;
	try {
		({ values } = parseArgs({ args: argv, options, strict: true, allowPositionals: false }));
	} catch (error) {
		throw new Refusal(`${(error as Error).message}\n\n${usage}`);
	}
	if ((values as { help?: boolean }).help) {
		console.log(usage);
		return null;
	}
	return values;
}

/** A variable's value, trimmed, with blank meaning unset (as env.ts reads them). */
export function variable(
	env: Record<string, string | undefined>,
	name: string
): string | undefined {
	const value = env[name]?.trim();
	return value ? value : undefined;
}

/** Query parameters whose value is a credential. */
const SECRET_PARAM = /pass|secret|token|key/i;

/** The URL with its password and any credential-like query value replaced by '***'. */
export function redactUrl(url: string): string {
	const parsed = new URL(url);
	if (parsed.password) parsed.password = '***';
	for (const name of [...parsed.searchParams.keys()]) {
		if (SECRET_PARAM.test(name)) parsed.searchParams.set(name, '***');
	}
	return parsed.toString();
}

export interface DatabaseTarget {
	/** Safe to print. */
	redacted: string;
	name: string;
	host: string;
	/** What the operator types to confirm: `<database>@<host>`. */
	confirmation: string;
}

/** The database a postgres:// URL names, or a Refusal that never repeats the URL itself. */
export function databaseTarget(url: string, variableName: string): DatabaseTarget {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Refusal(`Refusing to run: ${variableName} is not a URL.`);
	}
	const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
	if (!/^postgres(ql)?:$/.test(parsed.protocol) || !parsed.hostname || !name) {
		throw new Refusal(
			`Refusing to run: ${variableName} must be a postgres:// URL naming a host and a database.`
		);
	}
	return {
		redacted: redactUrl(url),
		name,
		host: parsed.hostname,
		confirmation: `${name}@${parsed.hostname}`
	};
}

export interface ConfirmIo {
	input: NodeJS.ReadableStream & { isTTY?: boolean };
	output: NodeJS.WritableStream;
}

/**
 * Asks for `expected` to be typed back. Outside an interactive terminal nothing is read and the
 * answer is 'not_interactive', so a pipe or a script can never confirm.
 */
export async function confirmTyped(
	expected: string,
	io: ConfirmIo = { input: stdin, output: stdout }
): Promise<'confirmed' | 'mismatch' | 'not_interactive'> {
	if (!io.input.isTTY) return 'not_interactive';
	const rl = createInterface({ input: io.input, output: io.output });
	try {
		const typed = await rl.question(`Type ${expected} to continue: `);
		return typed.trim() === expected ? 'confirmed' : 'mismatch';
	} finally {
		rl.close();
	}
}

/** Runs a command's main and sets the exit code; a Refusal prints its message and exits 2. */
export async function runCommand(main: () => Promise<number>): Promise<void> {
	try {
		process.exitCode = await main();
	} catch (error) {
		if (!(error instanceof Refusal)) throw error;
		console.error(error.message);
		process.exitCode = EXIT.refused;
	}
}

/** Whether this module's file is the script Node was started with. */
export function isEntry(moduleUrl: string): boolean {
	return process.argv[1] !== undefined && moduleUrl === pathToFileURL(process.argv[1]).href;
}
