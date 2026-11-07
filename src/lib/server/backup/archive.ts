/**
 * Writing and reading the archive that src/lib/domain/backup/format.ts defines: gzipped lines,
 * header, sections and rows, sequences, trailer. The writer keeps the trailer's counts and
 * digests as it goes; the reader recomputes them and refuses any archive that does not prove its
 * own completeness. Row lines stay opaque strings both ways.
 *
 * Server-only by use; imported by path with relative .ts specifiers, so scripts run it under
 * plain Node.
 */
import { createHash, type Hash } from 'node:crypto';
import { createGzip, gunzipSync, type Gzip } from 'node:zlib';
import {
	CONTROL_PREFIX,
	FORMAT_NAME,
	FORMAT_VERSION,
	formatControlLine,
	headerSchema,
	isRowLine,
	parseControlLine,
	type BackupHeader,
	type BackupSequences,
	type BackupTrailer,
	type ControlLine
} from '../../domain/backup/format.ts';
import { BackupError } from './errors.ts';

export const GZIP_LEVEL = 6;
/** The largest archive read, after gunzip; a backup is a few MB. */
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

const NEWLINE = 0x0a;
const utf8 = new TextDecoder('utf-8', { fatal: true });

type Sequence = BackupSequences['sequences'][number];
type Stage = 'header' | 'tables' | 'trailer' | 'done';

/**
 * Writes one archive, call by call: header, then for each of the header's tables in its order a
 * section and its rows, then the sequences, then finish(). Calls out of that order, or a row that
 * is not one line of Postgres's object text, throw malformed. `output` is the gzip stream; the
 * caller pipes it on (to sealStream) and reads it to its end.
 */
export class ArchiveWriter {
	readonly output: Gzip = createGzip({ level: GZIP_LEVEL });
	readonly #archive: Hash = createHash('sha256');
	#tables: string[] | null = null;
	#next = 0;
	#table: { name: string; count: number; hash: Hash } | null = null;
	readonly #rowCounts: Record<string, number> = {};
	readonly #tableDigests: Record<string, string> = {};
	#stage: Stage = 'header';

	header(header: BackupHeader): void {
		this.#expect('header', 'the header');
		const parsed = headerSchema.safeParse(header);
		if (!parsed.success) {
			throw new BackupError(
				'malformed',
				`The header is invalid at ${issuePaths(parsed.error.issues)}`
			);
		}
		this.#tables = parsed.data.tables.map((t) => t.name);
		this.#control(parsed.data);
		this.#stage = 'tables';
	}

	section(table: string): void {
		this.#expect('tables', `the section for ${table}`);
		this.#closeTable();
		if (this.#tables![this.#next] !== table) {
			throw new BackupError('malformed', `A section out of the header's order: ${table}`);
		}
		this.#next += 1;
		this.#control({ kind: 'section', table });
		this.#table = { name: table, count: 0, hash: createHash('sha256') };
	}

	row(line: string): void {
		this.#expect('tables', 'a row');
		const table = this.#table;
		if (!table) throw new BackupError('malformed', 'A row before any section');
		if (!isRowLine(line) || line.includes('\n') || !line.isWellFormed()) {
			throw new BackupError('malformed', `A row of ${table.name} is not one line of object text`);
		}
		const bytes = Buffer.from(line + '\n', 'utf8');
		table.count += 1;
		table.hash.update(bytes);
		this.#write(bytes);
	}

	sequences(sequences: Sequence[]): void {
		this.#expect('tables', 'the sequences');
		this.#closeTable();
		const missing = this.#tables!.slice(this.#next);
		if (missing.length > 0) {
			throw new BackupError('malformed', `The sections end before ${missing.join(', ')}`);
		}
		this.#control({ kind: 'sequences', sequences });
		this.#stage = 'trailer';
	}

	/** Writes the trailer, ends `output` and returns the trailer. */
	finish(): BackupTrailer {
		this.#expect('trailer', 'the trailer');
		const trailer: BackupTrailer = {
			kind: 'trailer',
			rowCounts: this.#rowCounts,
			tableDigests: this.#tableDigests,
			sha256: this.#archive.digest('hex')
		};
		this.output.end(Buffer.from(formatControlLine(trailer) + '\n', 'utf8'));
		this.#stage = 'done';
		return trailer;
	}

	#expect(stage: Stage, what: string): void {
		if (this.#stage !== stage) throw new BackupError('malformed', `Out of order: ${what}`);
	}

	#closeTable(): void {
		if (!this.#table) return;
		this.#rowCounts[this.#table.name] = this.#table.count;
		this.#tableDigests[this.#table.name] = this.#table.hash.digest('hex');
		this.#table = null;
	}

	#control(line: ControlLine): void {
		this.#write(Buffer.from(formatControlLine(line) + '\n', 'utf8'));
	}

	#write(bytes: Buffer): void {
		this.#archive.update(bytes);
		this.output.write(bytes);
	}
}

export interface ArchiveTable {
	name: string;
	/** The row lines exactly as written, without their '\n'. */
	rows: string[];
}

export interface Archive {
	header: BackupHeader;
	/** In the header's (restore) order. */
	tables: ArchiveTable[];
	sequences: Sequence[];
	trailer: BackupTrailer;
}

export interface ReadOptions {
	/** The largest archive accepted after gunzip; MAX_ARCHIVE_BYTES by default. */
	maxBytes?: number;
}

/**
 * Reads a whole archive from its gzip bytes and checks it, refusing with:
 * - too_large over the cap, truncated when the gzip or the lines stop early
 * - unsupported_format for another format or version, malformed for a bad or misplaced line
 * - count_mismatch and then checksum_mismatch per table, by name, then checksum_mismatch for the
 *   archive's own digest
 * - trailing_data for anything after the trailer
 */
export function readArchive(
	gzipBytes: Uint8Array,
	{ maxBytes = MAX_ARCHIVE_BYTES }: ReadOptions = {}
): Archive {
	const text = gunzip(gzipBytes, maxBytes);
	const lines = new LineReader(text);

	const first = lines.next();
	if (first === null) throw new BackupError('truncated', 'The archive is empty');
	const header = readHeader(first.text);

	const tables: ArchiveTable[] = [];
	let line = lines.next();
	for (const { name } of header.tables) {
		if (line === null) throw new BackupError('truncated', `The archive ends before ${name}`);
		const section = control(line.text);
		if (section.kind !== 'section' || section.table !== name) {
			throw new BackupError('malformed', `Expected the section for ${name}`);
		}
		const rows: string[] = [];
		line = lines.next();
		while (line !== null && isRowLine(line.text)) {
			rows.push(line.text);
			line = lines.next();
		}
		tables.push({ name, rows });
	}

	if (line === null) throw new BackupError('truncated', 'The archive ends before its sequences');
	const sequences = control(line.text);
	if (sequences.kind !== 'sequences') {
		throw new BackupError('malformed', 'Expected the sequences after the last table');
	}
	const trailerLine = lines.next();
	if (trailerLine === null)
		throw new BackupError('truncated', 'The archive ends before its trailer');
	const trailer = control(trailerLine.text);
	if (trailer.kind !== 'trailer') throw new BackupError('malformed', 'Expected the trailer');
	if (!lines.done()) throw new BackupError('trailing_data', 'A line follows the trailer');

	verifyTrailer(tables, trailer, text.subarray(0, trailerLine.start));
	return { header, tables, sequences: sequences.sequences, trailer };
}

function gunzip(bytes: Uint8Array, maxBytes: number): Buffer {
	try {
		return gunzipSync(bytes, { maxOutputLength: maxBytes });
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		if (code === 'ERR_BUFFER_TOO_LARGE') {
			throw new BackupError('too_large', `The archive is over the ${maxBytes}-byte cap`);
		}
		if (code === 'Z_BUF_ERROR') throw new BackupError('truncated', 'The gzip stream ends early');
		throw new BackupError('malformed', 'The archive is not gzip');
	}
}

/** The header, read leniently enough to tell another format or version from a broken line. */
function readHeader(text: string): BackupHeader {
	let value: unknown;
	try {
		value = text.startsWith(CONTROL_PREFIX) ? JSON.parse(text.slice(CONTROL_PREFIX.length)) : null;
	} catch {
		value = null;
	}
	const fields = (value ?? {}) as { kind?: unknown; format?: unknown; formatVersion?: unknown };
	if (fields.kind !== 'header')
		throw new BackupError('malformed', 'The first line is not a header');
	if (fields.format !== FORMAT_NAME || fields.formatVersion !== FORMAT_VERSION) {
		throw new BackupError(
			'unsupported_format',
			'The archive is not a format and version this code reads'
		);
	}
	const header = control(text);
	if (header.kind !== 'header')
		throw new BackupError('malformed', 'The first line is not a header');
	return header;
}

function control(text: string): ControlLine {
	const parsed = parseControlLine(text);
	if (!parsed.ok) {
		throw new BackupError('malformed', `A control line is invalid at ${issuePaths(parsed.issues)}`);
	}
	return parsed.line;
}

function verifyTrailer(tables: ArchiveTable[], trailer: BackupTrailer, before: Buffer): void {
	const names = tables.map((t) => t.name);
	for (const field of ['rowCounts', 'tableDigests'] as const) {
		const listed = Object.keys(trailer[field]);
		if (listed.length !== names.length || !names.every((n) => Object.hasOwn(trailer[field], n))) {
			throw new BackupError(
				'count_mismatch',
				`The trailer's ${field} do not list the header's tables`
			);
		}
	}
	for (const { name, rows } of tables) {
		if (trailer.rowCounts[name] !== rows.length) {
			throw new BackupError(
				'count_mismatch',
				`${name} has a different number of rows than the trailer's`
			);
		}
	}
	for (const { name, rows } of tables) {
		const hash = createHash('sha256');
		for (const row of rows) hash.update(row + '\n', 'utf8');
		if (hash.digest('hex') !== trailer.tableDigests[name]) {
			throw new BackupError('checksum_mismatch', `${name} does not match the trailer's digest`);
		}
	}
	if (createHash('sha256').update(before).digest('hex') !== trailer.sha256) {
		throw new BackupError('checksum_mismatch', "The archive does not match the trailer's digest");
	}
}

/** Lines of the gunzipped bytes, each strict UTF-8 and ended by '\n'. */
class LineReader {
	readonly #bytes: Buffer;
	#offset = 0;

	constructor(bytes: Buffer) {
		this.#bytes = bytes;
	}

	done(): boolean {
		return this.#offset >= this.#bytes.length;
	}

	/** The next line and the offset it starts at, or null at the end. */
	next(): { text: string; start: number } | null {
		const start = this.#offset;
		if (start >= this.#bytes.length) return null;
		const end = this.#bytes.indexOf(NEWLINE, start);
		if (end === -1) throw new BackupError('truncated', 'The last line has no end');
		this.#offset = end + 1;
		let text: string;
		try {
			text = utf8.decode(this.#bytes.subarray(start, end));
		} catch {
			throw new BackupError('malformed', 'A line is not UTF-8');
		}
		if (text.length === 0) throw new BackupError('malformed', 'An empty line');
		return { text, start };
	}
}

function issuePaths(issues: { path: PropertyKey[] }[]): string {
	return [...new Set(issues.map((i) => i.path.map(String).join('.') || '(root)'))].join(', ');
}
