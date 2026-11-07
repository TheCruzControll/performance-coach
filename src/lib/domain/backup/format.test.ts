import { describe, expect, it } from 'vitest';
import {
	CONTROL_PREFIX,
	FORMAT_NAME,
	FORMAT_VERSION,
	formatControlLine,
	isRowLine,
	parseControlLine,
	schemaTag,
	SESSION_SETTINGS
} from './format';
import type { BackupHeader, ControlLine } from './format';

const hex = (c: string) => c.repeat(64);

const header: BackupHeader = {
	kind: 'header',
	format: FORMAT_NAME,
	formatVersion: FORMAT_VERSION,
	createdAt: '2026-11-07T10:41:00.123Z',
	appVersion: '0.1.0',
	schema: {
		migrations: [
			{ hash: hex('a'), createdAt: 1_760_000_000_000 },
			{ hash: '3f9a0c1e' + hex('b').slice(8), createdAt: 1_760_000_100_000 }
		],
		count: 2,
		lastHash: '3f9a0c1e' + hex('b').slice(8)
	},
	settings: { ...SESSION_SETTINGS },
	tables: [
		{
			name: 'users',
			columns: [
				{ name: 'id', type: 'uuid' },
				{ name: 'created_at', type: 'timestamp with time zone' }
			]
		},
		{ name: 'programs', columns: [{ name: 'current_version_id', type: 'uuid' }] }
	],
	excluded: [{ name: 'auth_sessions', reason: 'Sessions are re-issued by signing in' }]
};

const section: ControlLine = { kind: 'section', table: 'users' };
const sequences: ControlLine = {
	kind: 'sequences',
	sequences: [
		{ name: 'app_errors_id_seq', lastValue: '9223372036854775807', isCalled: true },
		{ name: 'rum_events_id_seq', lastValue: '-1', isCalled: false }
	]
};
const trailer: ControlLine = {
	kind: 'trailer',
	rowCounts: { users: 1, programs: 0 },
	tableDigests: { users: hex('c'), programs: hex('d') },
	sha256: hex('e')
};

/** The text of a control line from any value, valid or not. */
const line = (value: unknown) => CONTROL_PREFIX + JSON.stringify(value);

function issuesOf(text: string) {
	const result = parseControlLine(text);
	if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result.line)}`);
	return result.issues;
}

const paths = (text: string) => issuesOf(text).map((issue) => issue.path);

describe('SESSION_SETTINGS', () => {
	it('pins how Postgres writes and reads value text', () => {
		expect(SESSION_SETTINGS).toEqual({
			TimeZone: 'UTC',
			DateStyle: 'ISO, YMD',
			IntervalStyle: 'postgres',
			extra_float_digits: '1',
			bytea_output: 'hex'
		});
		expect(FORMAT_VERSION).toBe(1);
	});
});

describe('control lines', () => {
	it.each([
		['a header', header],
		['a section', section],
		['the sequences', sequences],
		['an empty sequences line', { kind: 'sequences', sequences: [] }],
		['a trailer', trailer],
		[
			'the trailer of an empty export',
			{ kind: 'trailer', rowCounts: {}, tableDigests: {}, sha256: hex('0') }
		]
	])('parse %s', (_, value) => {
		expect(parseControlLine(line(value))).toEqual({ ok: true, line: value });
	});

	it('round-trip the header through its text', () => {
		const text = formatControlLine(header);
		expect(text.startsWith(CONTROL_PREFIX)).toBe(true);
		expect(text).not.toContain('\n');
		const parsed = parseControlLine(text);
		expect(parsed).toEqual({ ok: true, line: header });
		if (parsed.ok) expect(formatControlLine(parsed.line)).toBe(text);
	});

	it('refuse a numeric lastValue at its path', () => {
		const bad = { ...sequences, sequences: [{ name: 's', lastValue: 42, isCalled: true }] };
		expect(paths(line(bad))).toEqual([['sequences', 0, 'lastValue']]);
	});

	it.each(['1.5', '01', '1e3', ' 1', '99999999999999999999', ''])(
		'refuse the lastValue %j',
		(lastValue) => {
			const bad = { ...sequences, sequences: [{ name: 's', lastValue, isCalled: true }] };
			expect(paths(line(bad))).toEqual([['sequences', 0, 'lastValue']]);
		}
	);

	it('refuse an unknown kind at its path', () => {
		expect(paths(line({ kind: 'rows', table: 'users' }))).toEqual([['kind']]);
		expect(paths(line({ table: 'users' }))).toEqual([['kind']]);
	});

	it.each([
		['a short digest', { ...trailer, sha256: 'abc' }, ['sha256']],
		['an upper-case digest', { ...trailer, sha256: hex('E') }, ['sha256']],
		[
			"a table's digest",
			{ ...trailer, tableDigests: { users: hex('c').slice(1) + 'g' } },
			['tableDigests', 'users']
		],
		["a migration's hash", null, ['schema', 'migrations', 0, 'hash']]
	])('refuse a malformed digest: %s', (_, value, path) => {
		const bad = value ?? {
			...header,
			schema: {
				...header.schema,
				migrations: [{ hash: 'nope', createdAt: 1 }, header.schema.migrations[1]]
			}
		};
		expect(paths(line(bad))).toEqual([path]);
	});

	it.each([
		'format',
		'formatVersion',
		'createdAt',
		'appVersion',
		'schema',
		'settings',
		'tables',
		'excluded'
	] as const)('refuse a header without %s at its path', (field) => {
		const { [field]: _, ...rest } = header;
		expect(paths(line(rest))).toEqual([[field]]);
	});

	it.each([
		['another format', { format: 'pg_dump' }, ['format']],
		['format version 2', { formatVersion: 2 }, ['formatVersion']],
		['a local createdAt', { createdAt: '2026-11-07T10:41:00' }, ['createdAt']],
		[
			'another time zone',
			{ settings: { ...SESSION_SETTINGS, TimeZone: 'Europe/London' } },
			['settings', 'TimeZone']
		],
		['an unknown field', { extra: true }, []],
		[
			'a quoted table name',
			{ tables: [{ name: 'Users"; drop', columns: [{ name: 'id', type: 'uuid' }] }] },
			['tables', 0, 'name']
		],
		[
			'a table with no columns',
			{ tables: [{ name: 'users', columns: [] }] },
			['tables', 0, 'columns']
		],
		[
			'a column twice',
			{
				tables: [
					{
						name: 'users',
						columns: [
							{ name: 'id', type: 'uuid' },
							{ name: 'id', type: 'text' }
						]
					}
				]
			},
			['tables', 0, 'columns']
		],
		['a table twice', { tables: [header.tables[0], header.tables[0]] }, ['tables']],
		[
			'an exclusion without a reason',
			{ excluded: [{ name: 'auth_sessions', reason: '' }] },
			['excluded', 0, 'reason']
		],
		[
			'a table both exported and excluded',
			{ excluded: [{ name: 'users', reason: 'x' }] },
			['excluded']
		],
		['a count that disagrees', { schema: { ...header.schema, count: 3 } }, ['schema', 'count']],
		[
			'a lastHash that is not the last',
			{ schema: { ...header.schema, lastHash: hex('a') } },
			['schema', 'lastHash']
		],
		[
			'no migrations',
			{ schema: { migrations: [], count: 0, lastHash: hex('a') } },
			['schema', 'migrations']
		]
	])('refuse a header with %s', (_, change, path) => {
		expect(paths(line({ ...header, ...change }))).toEqual([path]);
	});

	it('refuse a section for a name that is not an identifier', () => {
		expect(paths(line({ kind: 'section', table: 'public.users' }))).toEqual([['table']]);
	});

	it('refuse a negative or fractional row count', () => {
		expect(paths(line({ ...trailer, rowCounts: { users: -1 } }))).toEqual([['rowCounts', 'users']]);
		expect(paths(line({ ...trailer, rowCounts: { users: 1.5 } }))).toEqual([
			['rowCounts', 'users']
		]);
	});

	it('refuse a row, bad JSON and a line without the prefix', () => {
		expect(issuesOf('{"id":1}')).toEqual([{ path: [], message: 'Not a control line' }]);
		expect(issuesOf(`${CONTROL_PREFIX}{"kind":`)).toEqual([{ path: [], message: 'Not JSON' }]);
		expect(issuesOf(JSON.stringify(section))).toEqual([
			{ path: [], message: 'Not a control line' }
		]);
	});
});

describe('isRowLine', () => {
	it("tells Postgres's row text from a control line", () => {
		expect(isRowLine('{"id":"00000000-0000-4000-8000-000000000001","note":"#1\\u2028"}')).toBe(
			true
		);
		expect(isRowLine(formatControlLine(section))).toBe(false);
		expect(isRowLine(formatControlLine(trailer))).toBe(false);
	});
});

describe('schemaTag', () => {
	it("is the migration count and the last hash's first 8 hex", () => {
		expect(schemaTag(header)).toBe('2-3f9a0c1e');
	});
});
