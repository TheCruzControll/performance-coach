/**
 * pnpm db:explain (Vitest project 'explain'): the history and program builders' query plans on a
 * realistic two-year dataset, measured as the app runs them, and gated so they stay that way.
 * - Resets the explain database (EXPLAIN_DATABASE_URL, default local coach_explain; the reset
 *   refuses any name not ending in _explain, _test or _e2e), migrates and seeds it, and loads
 *   dataset.ts.
 * - Runs EXPLAIN (ANALYZE, BUFFERS) on every builder of db/queries/{history,programs}.ts with the
 *   parameters its service passes, prints each plan and writes test-results/explain.md.
 * - Gates each plan by relation size (plan-check.ts): on a large relation, the builder's declared
 *   indexes and no Seq Scan; small relations are recorded only. History builders declare their
 *   index in HISTORY_INDEXES; the program builders' are below, the ones their comments name, and
 *   only those no other plan could do without, so the gate never asks for an index Postgres would
 *   rightly ignore.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, mondayOf } from '../../src/lib/domain/calendar';
import { connectionConfig } from '../../src/lib/server/db/connection';
import { LOCAL_DATABASE_URLS, redactUrl, resetDatabase } from '../../src/lib/server/db/migrate';
import * as h from '../../src/lib/server/db/queries/history';
import * as p from '../../src/lib/server/db/queries/programs';
import * as schema from '../../src/lib/server/db/schema';
import { FIRST_MONDAY, generateDataset, loadDataset, WEEKS } from './dataset';
import { checkPlan, scansOf, sizeClass, type Catalog, type PlanNode } from './plan-check';

const url = process.env.EXPLAIN_DATABASE_URL || LOCAL_DATABASE_URLS.explain;
const client = new pg.Client({ ...connectionConfig(url), application_name: 'db-explain' });
const db = drizzle({ client, schema });
const data = generateDataset();

/** The Wednesday of the dataset's last week, and n whole weeks up to the end of its week. */
const TODAY = addDays(FIRST_MONDAY, (WEEKS - 1) * 7 + 2);
const lastWeeks = (n: number) => ({
	from: addDays(mondayOf(TODAY), -7 * (n - 1)),
	to: addDays(mondayOf(TODAY), 6)
});
/** The instants those dates span in any time zone, as services/training/history.ts reads them. */
const ZONE_SLACK_MS = 14 * 3_600_000;
const instants = ({ from, to }: { from: string; to: string }) => ({
	start: new Date(Date.parse(`${from}T00:00:00Z`) - ZONE_SLACK_MS),
	end: new Date(Date.parse(`${addDays(to, 1)}T00:00:00Z`) + ZONE_SLACK_MS)
});

// What the services would read first: the active program, its current week and its History page.
const owner = data.owner.id!;
const program = data.programs.find((row) => row.status === 'active')!.id!;
const version = data.heads.find((head) => head.programId === program)!.versionId;
const memberWeeks = new Set(
	data.programVersionWeeks.filter((m) => m.versionId === version).map((m) => m.weekId)
);
const thisWeek = data.programWeeks.find(
	(w) => memberWeeks.has(w.id!) && w.startsOn === mondayOf(TODAY)
)!.id!;
const sessions = data.plannedSessions.filter((s) => s.weekId === thisWeek);
const session = sessions.find((s) => s.sessionType === 'strength')!;
const page = data.programVersions
	.filter((v) => v.programId === program)
	.sort((a, b) => b.number - a.number)
	.slice(0, 20);
const decisions = data.programmingDecisions.filter((d) => page.some((v) => v.id === d.versionId));
const four = lastWeeks(4);

/** Read from the loaded database: a catalogue row's id and a set id deep in its history. */
const loaded = { squat: '', cursor: 0 };

type Query = { toSQL(): { sql: string; params: unknown[] } };
type Case = [name: string, expected: readonly string[], query: () => Query];

const H = h.HISTORY_INDEXES;
const byWeek = ['program_version_weeks_pk', 'planned_sessions_week_day_idx'] as const;
/** The children of the sessions picked through `by`: each through its parent's index. */
const children = (by: string, q: ReturnType<typeof p.sessionChildren>): Case[] => [
	['exercises', [by, 'planned_exercises_session_position_uq'], () => q.exercises],
	['sets', [by, 'set_prescriptions_exercise_position_uq'], () => q.sets],
	['segments', [by, 'planned_run_segments_session_position_uq'], () => q.segments],
	['details', [by, 'planned_session_details_pkey'], () => q.details]
];
const prefixed = (prefix: string, cases: Case[]): Case[] =>
	cases.map(([name, expected, query]) => [`${prefix}: ${name}`, expected, query]);

const CASES: Case[] = (() => {
	const tree = p.versionTree(db, version);
	const week = p.sessionsWithChildren(db, [thisWeek]);
	const range = h.sessionsInRange(db, owner, version, four.from, four.to, instants(four));
	const affected = p.affectedNodes(
		db,
		page.map((v) => v.id!),
		[...new Set(decisions.flatMap((d) => d.affected ?? []))]
	);
	return [
		[
			'exerciseHistory, first page',
			[H.exerciseHistory],
			() => h.exerciseHistory(db, owner, loaded.squat, { limit: 20 })
		],
		[
			'exerciseHistory, page 6',
			[H.exerciseHistory],
			() => h.exerciseHistory(db, owner, loaded.squat, { before: loaded.cursor, limit: 20 })
		],
		[
			'lastPerformances, last 3',
			[H.lastPerformances],
			() => h.lastPerformances(db, owner, loaded.squat, 3)
		],
		['bestE1rms, one exercise', [H.bestE1rms], () => h.bestE1rms(db, owner, loaded.squat)],
		['bestE1rms, every exercise', [H.bestE1rms], () => h.bestE1rms(db, owner)],
		['repMaxes, one exercise', [H.repMaxes], () => h.repMaxes(db, owner, loaded.squat)],
		['repMaxes, every exercise', [H.repMaxes], () => h.repMaxes(db, owner)],
		[
			'setsInRange, 12 weeks (muscle volume)',
			[H.setsInRange],
			() => h.setsInRange(db, owner, instants(lastWeeks(12)))
		],
		[
			'runsInRange, 12 weeks (mileage)',
			[H.runsInRange],
			() => h.runsInRange(db, owner, instants(lastWeeks(12)))
		],
		['sessionsInRange, 4 weeks: planned', [...byWeek], () => range.planned],
		['sessionsInRange, 4 weeks: logged', [H.sessionsInRange.logged], () => range.logged],
		[
			'currentProgram',
			['programs_owner_active_uq', 'program_versions_pkey'],
			() => p.currentProgram(db, owner)
		],
		[
			'currentProgram, version 5',
			['programs_owner_active_uq', 'program_versions_program_number_uq'],
			() => p.currentProgram(db, owner, 5)
		],
		[
			'versionTree: blocks',
			['program_version_blocks_pk', 'program_blocks_pkey'],
			() => tree.blocks
		],
		['versionTree: weeks', ['program_version_weeks_pk', 'program_weeks_pkey'], () => tree.weeks],
		['versionTree: sessions', [...byWeek], () => tree.sessions],
		...prefixed('versionTree', children('planned_sessions_week_day_idx', tree)),
		[
			'sessionsWithChildren, this week: sessions',
			['planned_sessions_week_day_idx'],
			() => week.sessions
		],
		...prefixed('sessionsWithChildren, this week', children('planned_sessions_week_day_idx', week)),
		[
			'plannedSessionsInRange, today',
			[...byWeek],
			() => p.plannedSessionsInRange(db, version, TODAY, TODAY)
		],
		['upcomingSessions, next 3', [...byWeek], () => p.upcomingSessions(db, version, TODAY, 3)],
		[
			'sessionByLineage',
			['planned_sessions_lineage_idx'],
			() => p.sessionByLineage(db, version, session.lineageId!)
		],
		...prefixed(
			'sessionChildren',
			children('planned_sessions_pkey', p.sessionChildren(db, [session.id!]))
		),
		[
			'completedLineages, this week',
			['workouts_planned_lineage_idx'],
			() =>
				p.completedLineages(
					db,
					owner,
					sessions.map((s) => s.lineageId!)
				)
		],
		[
			'versionHistory, newest page',
			['program_versions_program_number_uq', 'programming_decisions_version_idx'],
			() => p.versionHistory(db, program, { limit: 20 })
		],
		[
			'versionHistory, older page',
			['program_versions_program_number_uq', 'programming_decisions_version_idx'],
			() => p.versionHistory(db, program, { beforeNumber: page.at(-1)!.number, limit: 20 })
		],
		['affectedNodes: sessions', ['planned_sessions_lineage_idx'], () => affected.sessions],
		['affectedNodes: exercises', ['planned_exercises_lineage_idx'], () => affected.exercises]
	];
})();

interface Explained {
	Plan: PlanNode;
	'Planning Time': number;
	'Execution Time': number;
}

async function readCatalog(): Promise<Catalog> {
	const relations = await client.query<{ name: string; tuples: number; pages: number }>(
		`select relname as name, reltuples::float8 as tuples, relpages as pages from pg_class
		 where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname`
	);
	const indexes = await client.query<{ index: string; table: string }>(
		`select indexrelid::regclass::text as index, indrelid::regclass::text as table from pg_index
		 join pg_class on pg_class.oid = indrelid where relnamespace = 'public'::regnamespace`
	);
	return {
		relations: new Map(relations.rows.map((r) => [r.name, { tuples: r.tuples, pages: r.pages }])),
		indexes: new Map(indexes.rows.map((r) => [r.index, r.table]))
	};
}

/** The plan as indented lines: each node's scan, actual rows, time and shared buffers. */
function render(n: PlanNode, depth = 0): string[] {
	const on = n['Relation Name'] ? ` on ${String(n['Relation Name'])} ${String(n.Alias)}` : '';
	const using = n['Index Name'] ? ` using ${String(n['Index Name'])}` : '';
	const actual = `rows=${String(n['Actual Rows'])} loops=${String(n['Actual Loops'])} time=${String(n['Actual Total Time'])} ms`;
	const buffers = `hit=${String(n['Shared Hit Blocks'])} read=${String(n['Shared Read Blocks'])}`;
	const pad = '  '.repeat(depth);
	const parent = String(n['Parent Relationship']);
	const init = parent === 'InitPlan' || parent === 'SubPlan' ? `${parent}: ` : '';
	const conditions = ['Index Cond', 'Filter', 'Join Filter', 'Hash Cond']
		.filter((key) => n[key])
		.map((key) => `${pad}      ${key}: ${String(n[key])}`);
	return [
		`${pad}-> ${init}${n['Node Type']}${using}${on} (${actual}; buffers ${buffers})`,
		...conditions,
		...(n.Plans ?? []).flatMap((child) => render(child, depth + 1))
	];
}

let catalog: Catalog;
const results: string[] = [];
const plans: string[] = [];

beforeAll(async () => {
	await resetDatabase(url);
	await client.connect();
	await loadDataset(client, data);
	catalog = await readCatalog();
	const [squat] = await db
		.select({ id: schema.exercises.id })
		.from(schema.exercises)
		.where(eq(schema.exercises.key, 'back_squat'));
	loaded.squat = squat!.id;
	const pages = await h.exerciseHistory(db, owner, loaded.squat, { limit: 100 });
	loaded.cursor = pages.at(-1)!.id;
}, 120_000);

afterAll(async () => {
	if (!catalog) {
		await client.end(); // the setup failed: there is nothing to report
		return;
	}
	const { rows } = await client.query<{ server_version: string }>('show server_version');
	await client.end();
	const commit = (process.env.GITHUB_SHA ?? execSync('git rev-parse HEAD').toString()).slice(0, 7);
	const sizes = [...catalog.relations]
		.filter(([, size]) => size.tuples > 0)
		.map(([name, s]) => `| ${name} | ${Math.round(s.tuples)} | ${s.pages} | ${sizeClass(s)} |`);
	const report = [
		`# db:explain`,
		'',
		`${new Date().toISOString().slice(0, 10)} · commit ${commit} · Postgres ${rows[0]!.server_version} · ${os.cpus()[0]?.model ?? 'cpu'} × ${os.cpus().length} · ${os.platform()} · ${redactUrl(url)}`,
		'',
		'| Relation | Rows | Pages | Size |',
		'| --- | ---: | ---: | --- |',
		...sizes,
		'',
		'| Query | Declared index | Scans (large relations in bold) | Rows | Execution | Planning | Buffers hit/read | Gate |',
		'| --- | --- | --- | ---: | ---: | ---: | ---: | --- |',
		...results,
		'',
		...plans
	];
	mkdirSync('test-results', { recursive: true });
	writeFileSync('test-results/explain.md', `${report.join('\n')}\n`);
});

describe(`db:explain on ${redactUrl(url)}`, () => {
	it.each(CASES)('%s', async (name, expected, build) => {
		const { sql, params } = build().toSQL();
		const explained = await client.query<{ 'QUERY PLAN': Explained[] }>(
			`explain (analyze, buffers, format json) ${sql}`,
			params
		);
		const result = explained.rows[0]!['QUERY PLAN'][0]!;
		const problems = checkPlan(result.Plan, expected, catalog);
		const lines = render(result.Plan);
		console.log(`\n${name}\n${lines.join('\n')}\nExecution ${result['Execution Time']} ms`);
		const scans = scansOf(result.Plan, catalog)
			.map((s) => {
				const text = `${s.node} ${s.index ?? s.relation}`;
				return s.size === 'large' ? `**${text}**` : text;
			})
			.join(', ');
		const top = result.Plan;
		const buffers = `${String(top['Shared Hit Blocks'])}/${String(top['Shared Read Blocks'])}`;
		results.push(
			`| ${name} | ${expected.join(', ')} | ${scans} | ${String(top['Actual Rows'])} | ${result['Execution Time'].toFixed(3)} ms | ${result['Planning Time'].toFixed(3)} ms | ${buffers} | ${problems.length ? problems.join('; ') : 'pass'} |`
		);
		plans.push(`### ${name}`, '', '```text', ...lines, '```', '');
		expect(problems, `${name}\n${lines.join('\n')}`).toEqual([]);
	});
});
