/**
 * What a backup archive is (the app-level encrypted backups ADR): gzipped lines of text, read
 * and written by src/lib/server/backup, scripts/backup and src/lib/server/db/backup.
 *
 * Line by line:
 * 1. The header, a control line.
 * 2. Per exported table, in restore order: a section line, then its rows, one per line, in
 *    primary-key order. A row line is `row_to_json(t)::text` exactly as Postgres wrote it, under
 *    SESSION_SETTINGS. It is opaque here: JavaScript never parses one, restore hands it back to
 *    Postgres through json_populate_record, so every type survives byte for byte.
 * 3. One sequences line.
 * 4. The trailer, the last line.
 *
 * Every line ends in '\n'. A row line always starts with '{' (Postgres's object text); a control
 * line starts with CONTROL_PREFIX, then one JSON object whose `kind` names it, so no row can be
 * read as a control line. Digests are lower-case SHA-256 hex:
 * - tableDigests[t]: over that table's row lines, each with its '\n', in file order. SQL
 *   recomputes it as sha256(string_agg(row_to_json(t)::text || E'\n', '' ORDER BY <pk>)), and an
 *   empty table digests the empty string.
 * - sha256: over every byte of the file before the trailer line.
 *
 * Any change to a line's shape bumps FORMAT_VERSION, and the reader keeps reading the old one.
 * Pure and server-only by use; imported by path with relative .ts specifiers, so scripts run it
 * under plain Node.
 */
import * as z from 'zod/mini';

export const FORMAT_NAME = 'performance-coach-backup';
export const FORMAT_VERSION = 1;

/** The first character of every control line. */
export const CONTROL_PREFIX = '#';

/**
 * Pinned with SET LOCAL for the export, the digests and the restore, so Postgres writes and reads
 * each value's text the same way every time.
 */
export const SESSION_SETTINGS = {
	TimeZone: 'UTC',
	DateStyle: 'ISO, YMD',
	IntervalStyle: 'postgres',
	extra_float_digits: '1',
	bytea_output: 'hex'
} as const;

/** A lower-case unquoted Postgres identifier; anything else is refused, never quoted around. */
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** A bigint's text: Postgres's sequence values go past Number.MAX_SAFE_INTEGER. */
const BIGINT = /^-?(0|[1-9][0-9]{0,18})$/;

const identifier = z.string().check(z.regex(IDENTIFIER, 'Not a lower-case identifier'));
const sha256 = z.string().check(z.regex(SHA256, 'Not a SHA-256 hex digest'));
const count = z.int().check(z.nonnegative());

/** Each item's name once, in a list of tables, columns or sequences. */
function uniqueNames(message: string) {
	return z.refine<{ name: string }[]>(
		(items) => new Set(items.map((item) => item.name)).size === items.length,
		message
	);
}

/** One applied migration, as drizzle.__drizzle_migrations records it (created_at is `when`). */
const migrationSchema = z.strictObject({ hash: sha256, createdAt: count });

const schemaSchema = z
	.strictObject({
		migrations: z.array(migrationSchema).check(z.minLength(1, 'At least one migration')),
		count,
		lastHash: sha256
	})
	.check(
		z.refine((s) => s.count === s.migrations.length, {
			message: 'Not the number of migrations',
			path: ['count']
		}),
		z.refine((s) => s.migrations.length === 0 || s.lastHash === s.migrations.at(-1)?.hash, {
			message: 'Not the last migration',
			path: ['lastHash']
		})
	);

const settingsSchema = z.strictObject({
	TimeZone: z.literal(SESSION_SETTINGS.TimeZone),
	DateStyle: z.literal(SESSION_SETTINGS.DateStyle),
	IntervalStyle: z.literal(SESSION_SETTINGS.IntervalStyle),
	extra_float_digits: z.literal(SESSION_SETTINGS.extra_float_digits),
	bytea_output: z.literal(SESSION_SETTINGS.bytea_output)
});

/** A column as the catalog names it, with format_type's text. */
const columnSchema = z.strictObject({ name: identifier, type: z.string().check(z.minLength(1)) });

const tableSchema = z.strictObject({
	name: identifier,
	columns: z
		.array(columnSchema)
		.check(z.minLength(1, 'At least one column'), uniqueNames('Each column once'))
});

const excludedSchema = z.strictObject({
	name: identifier,
	reason: z.string().check(z.minLength(1, 'Give a reason'))
});

export const headerSchema = z
	.strictObject({
		kind: z.literal('header'),
		format: z.literal(FORMAT_NAME),
		formatVersion: z.literal(FORMAT_VERSION),
		createdAt: z.iso.datetime(),
		appVersion: z.string().check(z.minLength(1), z.maxLength(64)),
		schema: schemaSchema,
		settings: settingsSchema,
		/** In restore order: the order of the sections. */
		tables: z.array(tableSchema).check(uniqueNames('Each table once')),
		excluded: z.array(excludedSchema).check(uniqueNames('Each table once'))
	})
	.check(
		z.refine(
			(h) => {
				const exported = new Set(h.tables.map((t) => t.name));
				return h.excluded.every((t) => !exported.has(t.name));
			},
			{ message: 'A table is both exported and excluded', path: ['excluded'] }
		)
	);

export const sectionSchema = z.strictObject({ kind: z.literal('section'), table: identifier });

const sequenceSchema = z.strictObject({
	name: identifier,
	/** Text, because a bigint does not fit a JSON number. */
	lastValue: z.string('Write the value as text').check(z.regex(BIGINT, 'Not a bigint')),
	isCalled: z.boolean()
});

export const sequencesSchema = z.strictObject({
	kind: z.literal('sequences'),
	sequences: z.array(sequenceSchema).check(uniqueNames('Each sequence once'))
});

export const trailerSchema = z.strictObject({
	kind: z.literal('trailer'),
	rowCounts: z.record(identifier, count),
	tableDigests: z.record(identifier, sha256),
	sha256
});

export const controlLineSchema = z.discriminatedUnion('kind', [
	headerSchema,
	sectionSchema,
	sequencesSchema,
	trailerSchema
]);

export type BackupHeader = z.output<typeof headerSchema>;
export type BackupSection = z.output<typeof sectionSchema>;
export type BackupSequences = z.output<typeof sequencesSchema>;
export type BackupTrailer = z.output<typeof trailerSchema>;
export type ControlLine = z.output<typeof controlLineSchema>;

/** Whether a line (without its '\n') is a row, which is never parsed here. */
export function isRowLine(line: string): boolean {
	return line.startsWith('{');
}

export type ParsedControlLine =
	| { ok: true; line: ControlLine }
	| { ok: false; issues: { path: PropertyKey[]; message: string }[] };

/** Parses one control line (without its '\n'); a row, bad JSON or a bad field is refused. */
export function parseControlLine(text: string): ParsedControlLine {
	if (!text.startsWith(CONTROL_PREFIX)) {
		return { ok: false, issues: [{ path: [], message: 'Not a control line' }] };
	}
	let value: unknown;
	try {
		value = JSON.parse(text.slice(CONTROL_PREFIX.length));
	} catch {
		return { ok: false, issues: [{ path: [], message: 'Not JSON' }] };
	}
	const result = controlLineSchema.safeParse(value);
	if (result.success) return { ok: true, line: result.data };
	return {
		ok: false,
		issues: result.error.issues.map((issue) => ({ path: issue.path, message: issue.message }))
	};
}

/** One control line's text, without its '\n'. */
export function formatControlLine(line: ControlLine): string {
	return CONTROL_PREFIX + JSON.stringify(line);
}

/** '<migration count>-<first 8 hex of the last migration's hash>', e.g. '18-3f9a0c1e'. */
export function schemaTag(header: Pick<BackupHeader, 'schema'>): string {
	return `${header.schema.count}-${header.schema.lastHash.slice(0, 8)}`;
}
