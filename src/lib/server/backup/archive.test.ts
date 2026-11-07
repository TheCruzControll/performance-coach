import { createHash } from 'node:crypto';
import { buffer } from 'node:stream/consumers';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
	FORMAT_NAME,
	FORMAT_VERSION,
	SESSION_SETTINGS,
	type BackupHeader,
	type BackupSequences
} from '../../domain/backup/format';
import { ArchiveWriter, MAX_ARCHIVE_BYTES, readArchive } from './archive';
import { BackupError, type BackupErrorCode } from './errors';

const hex = (c: string) => c.repeat(64);
const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

const HEADER: BackupHeader = {
	kind: 'header',
	format: FORMAT_NAME,
	formatVersion: FORMAT_VERSION,
	createdAt: '2026-11-07T10:41:00.123Z',
	appVersion: '0.1.0',
	schema: {
		migrations: [{ hash: hex('a'), createdAt: 1_760_000_000_000 }],
		count: 1,
		lastHash: hex('a')
	},
	settings: { ...SESSION_SETTINGS },
	tables: [
		{ name: 'users', columns: [{ name: 'id', type: 'uuid' }] },
		{ name: 'programs', columns: [{ name: 'id', type: 'uuid' }] },
		{ name: 'empty_things', columns: [{ name: 'id', type: 'bigint' }] }
	],
	excluded: [{ name: 'auth_sessions', reason: 'Sessions are re-issued by signing in' }]
};

/**
 * Row lines as Postgres's row_to_json writes them: escaped newlines and quotes, a raw U+2028
 * (JSON text allows it, and it is not a line break here), emoji, a backslash, and a surrogate pair.
 */
const ROWS: Record<string, string[]> = {
	users: [
		'{"id":"0b6f…","name":"Niko \\"The\\" Cruz","note":"line one\\nline two\\r\\n"}',
		'{"id":"1c7a","bio":"para\u2028sep\u2029end","emoji":"🏋️‍♂️💪🏽","path":"C:\\\\tmp"}'
	],
	programs: [
		'{"id":"p1","weeks":[1,2,3],"n":0.1,"big":4611686018427387904}',
		'{"id":"p2","jsonb":{"ключ":"值","nested":{"a":null}}}',
		'{"id":"p3","bytes":"\\\\x00ff"}'
	],
	empty_things: []
};

const SEQUENCES: BackupSequences['sequences'] = [
	{ name: 'app_errors_id_seq', lastValue: '9223372036854775807', isCalled: true }
];

/** Writes an archive through the writer and returns its gzip bytes and the trailer. */
async function write(rows = ROWS, header = HEADER) {
	const writer = new ArchiveWriter();
	const bytes = buffer(writer.output);
	writer.header(header);
	for (const { name } of header.tables) {
		writer.section(name);
		for (const row of rows[name] ?? []) writer.row(row);
	}
	writer.sequences(SEQUENCES);
	const trailer = writer.finish();
	return { gzip: await bytes, trailer };
}

/** The archive's lines (each without its '\n'), to change one and gzip it again. */
async function lines(): Promise<string[]> {
	const { gzip } = await write();
	const text = gunzipSync(gzip).toString('utf8');
	expect(text.endsWith('\n')).toBe(true);
	return text.slice(0, -1).split('\n');
}
const regzip = (text: string) => gzipSync(Buffer.from(text, 'utf8'));
const join = (ls: string[]) => ls.join('\n') + '\n';

function refusal(read: () => unknown): BackupError {
	try {
		read();
	} catch (error) {
		expect(error).toBeInstanceOf(BackupError);
		return error as BackupError;
	}
	throw new Error('Expected the archive to be refused');
}
const code = (read: () => unknown): BackupErrorCode => refusal(read).code;

describe('ArchiveWriter and readArchive', () => {
	it('round-trips every row byte for byte, with the header, sequences and trailer', async () => {
		const { gzip, trailer } = await write();
		const archive = readArchive(gzip);
		expect(archive.header).toEqual(HEADER);
		expect(archive.tables).toEqual(HEADER.tables.map(({ name }) => ({ name, rows: ROWS[name] })));
		for (const table of archive.tables) {
			for (const [i, row] of table.rows.entries()) {
				expect(Buffer.from(row, 'utf8').equals(Buffer.from(ROWS[table.name]![i]!, 'utf8'))).toBe(
					true
				);
			}
		}
		expect(archive.sequences).toEqual(SEQUENCES);
		expect(archive.trailer).toEqual(trailer);
	});

	it('writes the trailer the format defines: counts, per-table digests and the archive digest', async () => {
		const { gzip, trailer } = await write();
		const text = gunzipSync(gzip).toString('utf8');
		const trailerStart = text.lastIndexOf('\n', text.length - 2) + 1;
		expect(trailer.rowCounts).toEqual({ users: 2, programs: 3, empty_things: 0 });
		for (const [name, rows] of Object.entries(ROWS)) {
			expect(trailer.tableDigests[name]).toBe(sha256(rows.map((r) => r + '\n').join('')));
		}
		// An empty table digests the empty string, as SQL's string_agg over no rows does.
		expect(trailer.tableDigests.empty_things).toBe(sha256(''));
		expect(trailer.sha256).toBe(sha256(Buffer.from(text.slice(0, trailerStart), 'utf8')));
		expect(text.slice(trailerStart)).toBe('#' + JSON.stringify(trailer) + '\n');
	});

	it('writes gzip at level 6', async () => {
		const { gzip } = await write();
		const plain = gunzipSync(gzip);
		expect(gzip.equals(gzipSync(plain, { level: 6 }))).toBe(true);
		expect(gzip.equals(gzipSync(plain, { level: 9 }))).toBe(false);
	});

	it('fails a changed row by its table name', async () => {
		const ls = await lines();
		const at = ls.indexOf(ROWS.programs![1]!);
		ls[at] = ls[at]!.replace('值', '値');
		const error = refusal(() => readArchive(regzip(join(ls))));
		expect(error.code).toBe('checksum_mismatch');
		expect(error.message).toContain('programs');
		expect(error.message).not.toContain('値');
	});

	it('fails a dropped row with count_mismatch, by table name', async () => {
		const ls = await lines();
		ls.splice(ls.indexOf(ROWS.programs![2]!), 1);
		const error = refusal(() => readArchive(regzip(join(ls))));
		expect(error.code).toBe('count_mismatch');
		expect(error.message).toContain('programs');
	});

	it('fails a changed header on the trailer’s own digest', async () => {
		const ls = await lines();
		ls[0] = ls[0]!.replace('"appVersion":"0.1.0"', '"appVersion":"0.1.1"');
		const error = refusal(() => readArchive(regzip(join(ls))));
		expect(error.code).toBe('checksum_mismatch');
		expect(error.message).toMatch(/archive/);
	});

	it('fails a changed sequence on the trailer’s own digest', async () => {
		const ls = await lines();
		const at = ls.findIndex((l) => l.startsWith('#{"kind":"sequences"'));
		ls[at] = ls[at]!.replace('9223372036854775807', '9223372036854775806');
		expect(code(() => readArchive(regzip(join(ls))))).toBe('checksum_mismatch');
	});

	it('detects the archive cut at every line boundary and inside every line', async () => {
		const text = join(await lines());
		for (let length = 0; length < text.length; length += 1) {
			// Each cut that ends in '\n' drops whole lines; any other ends inside a line.
			expect(
				code(() => readArchive(regzip(text.slice(0, length)))),
				`cut at ${length}`
			).toBe('truncated');
		}
	});

	it('detects the gzip stream cut short', async () => {
		const { gzip } = await write();
		for (let length = 10; length < gzip.length; length += 1) {
			expect(
				code(() => readArchive(gzip.subarray(0, length))),
				`cut at ${length}`
			).toBe('truncated');
		}
	});

	it('refuses a line after the trailer', async () => {
		const ls = await lines();
		const text = join(ls);
		expect(code(() => readArchive(regzip(text + ROWS.users![0] + '\n')))).toBe('trailing_data');
		expect(code(() => readArchive(regzip(text + ls.at(-1)! + '\n')))).toBe('trailing_data');
		expect(code(() => readArchive(regzip(text + 'x')))).toBe('trailing_data');
	});

	it('refuses formatVersion 2 and another format as unsupported', async () => {
		const ls = await lines();
		for (const [from, to] of [
			[`"formatVersion":${FORMAT_VERSION}`, '"formatVersion":2'],
			[`"format":"${FORMAT_NAME}"`, '"format":"another-backup"']
		] as const) {
			const changed = [...ls];
			changed[0] = changed[0]!.replace(from, to);
			expect(changed[0]).not.toBe(ls[0]);
			expect(code(() => readArchive(regzip(join(changed))))).toBe('unsupported_format');
		}
	});

	it('refuses misplaced and malformed lines', async () => {
		const ls = await lines();
		const usersAt = ls.indexOf('#{"kind":"section","table":"users"}');
		const programsAt = ls.indexOf('#{"kind":"section","table":"programs"}');
		const swapped = [...ls];
		[swapped[usersAt], swapped[programsAt]] = [swapped[programsAt]!, swapped[usersAt]!];
		const cases: [string, string[]][] = [
			['sections out of order', swapped],
			['no header', ls.slice(1)],
			['an empty line', [...ls.slice(0, 2), '', ...ls.slice(2)]],
			['a line that is neither', [...ls.slice(0, 2), 'plain text', ...ls.slice(2)]],
			['an unknown control line', [...ls.slice(0, 2), '#{"kind":"comment"}', ...ls.slice(2)]],
			[
				'a header with a missing field',
				[ls[0]!.replace(/"appVersion":"[^"]*",/, ''), ...ls.slice(1)]
			]
		];
		for (const [label, changed] of cases) {
			expect(
				code(() => readArchive(regzip(join(changed)))),
				label
			).toBe('malformed');
		}
		const invalidUtf8 = Buffer.concat([
			Buffer.from(join(ls.slice(0, 2))),
			Buffer.from([0xff, 0x0a])
		]);
		expect(code(() => readArchive(gzipSync(invalidUtf8)))).toBe('malformed');
		expect(code(() => readArchive(Buffer.from('not gzip at all')))).toBe('malformed');
	});

	it('refuses an archive over the cap after gunzip', async () => {
		const { gzip } = await write();
		const size = gunzipSync(gzip).length;
		expect(code(() => readArchive(gzip, { maxBytes: size - 1 }))).toBe('too_large');
		expect(readArchive(gzip, { maxBytes: size }).tables).toHaveLength(3);
		expect(MAX_ARCHIVE_BYTES).toBe(512 * 1024 * 1024);
	});

	it('puts no row text in any refusal', async () => {
		const ls = await lines();
		const at = ls.indexOf(ROWS.users![0]!);
		ls[at] = ls[at]!.replace('Niko', 'Nico');
		const error = refusal(() => readArchive(regzip(join(ls))));
		expect(error.message).not.toMatch(/Nic?k?o/);
	});
});

describe('ArchiveWriter refusals', () => {
	const started = () => {
		const writer = new ArchiveWriter();
		writer.output.resume();
		writer.header(HEADER);
		return writer;
	};
	const writerCode = (act: () => void): BackupErrorCode => code(act);

	it('takes the calls in the format’s order only', () => {
		const fresh = new ArchiveWriter();
		expect(writerCode(() => fresh.section('users'))).toBe('malformed');
		expect(writerCode(() => fresh.finish())).toBe('malformed');
		expect(writerCode(() => started().header(HEADER))).toBe('malformed');
		expect(writerCode(() => started().row('{"a":1}'))).toBe('malformed');
		expect(writerCode(() => started().finish())).toBe('malformed');
	});

	it('takes the sections in the header’s order, each once, and all of them', () => {
		expect(writerCode(() => started().section('programs'))).toBe('malformed');
		expect(writerCode(() => started().section('unknown'))).toBe('malformed');
		const twice = started();
		twice.section('users');
		expect(writerCode(() => twice.section('users'))).toBe('malformed');
		const short = started();
		short.section('users');
		short.section('programs');
		expect(writerCode(() => short.sequences([]))).toBe('malformed');
	});

	it('takes a row only as one line of object text', () => {
		const writer = started();
		writer.section('users');
		for (const row of ['{"a":"one\ntwo"}', '["not an object"]', '', 'null', '{"lone":"\ud800"}']) {
			expect(
				writerCode(() => writer.row(row)),
				JSON.stringify(row)
			).toBe('malformed');
		}
	});

	it('refuses an invalid header', () => {
		const writer = new ArchiveWriter();
		expect(
			writerCode(() => writer.header({ ...HEADER, formatVersion: 2 } as unknown as BackupHeader))
		).toBe('malformed');
	});
});
