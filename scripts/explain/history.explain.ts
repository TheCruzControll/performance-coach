/**
 * pnpm db:explain (Vitest project 'explain'): the history, program and coach builders' query plans
 * on a realistic two-year dataset, measured as the app runs them, and gated so they stay that way.
 * - Resets the explain database (EXPLAIN_DATABASE_URL, default local coach_explain; the reset
 *   refuses any name not ending in _explain, _test or _e2e), migrates and seeds it, and loads
 *   dataset.ts, then coach-dataset.ts.
 * - Runs EXPLAIN (ANALYZE, BUFFERS) on every builder of db/queries/{history,programs}.ts and of
 *   the coach's db/queries/{coach-threads,coach-proposals,coach-notes,agent-runs,coach-memory}.ts
 *   with the parameters its service passes (a write inside a rolled-back transaction), prints each
 *   plan and writes test-results/explain.md. The coach builders declare their indexes in each
 *   module's *_INDEXES.
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
import { TURN_LIMITS } from '../../src/lib/domain/coach/budgets';
import * as ar from '../../src/lib/server/db/queries/agent-runs';
import * as cm from '../../src/lib/server/db/queries/coach-memory';
import * as cn from '../../src/lib/server/db/queries/coach-notes';
import * as cp from '../../src/lib/server/db/queries/coach-proposals';
import * as ct from '../../src/lib/server/db/queries/coach-threads';
import * as h from '../../src/lib/server/db/queries/history';
import * as p from '../../src/lib/server/db/queries/programs';
import * as schema from '../../src/lib/server/db/schema';
import {
	MEMORY_NOTE_KINDS,
	MEMORY_RECORD_DAYS,
	MEMORY_RECORD_LIMITS
} from '../../src/lib/server/services/coach/memory-records';
import { NOTES_PAGE } from '../../src/lib/server/services/coach/notes';
import { PROPOSAL_IDS_MAX, PROPOSAL_PAGE } from '../../src/lib/server/services/coach/proposals';
import { RUN_PAGE } from '../../src/lib/server/services/coach/runs';
import { THREAD_PAGE, THREAD_VIEW_MESSAGES } from '../../src/lib/server/services/coach/threads';
import { ACTIVE_WORKOUTS_LIMIT } from '../../src/lib/server/services/workouts/canonical';
import { analyticsExplain } from './analytics.cases';
import { generateCoachDataset, loadCoachDataset } from './coach-dataset';
import { FIRST_MONDAY, generateDataset, loadDataset, WEEKS } from './dataset';
import { checkPlan, scansOf, sizeClass, type Catalog, type PlanNode } from './plan-check';

const url = process.env.EXPLAIN_DATABASE_URL || LOCAL_DATABASE_URLS.explain;
const client = new pg.Client({ ...connectionConfig(url), application_name: 'db-explain' });
const db = drizzle({ client, schema });
const data = generateDataset();
const coach = generateCoachDataset(data);

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

/**
 * Read from the loaded database: a catalogue row's id, a set id deep in its history, and six
 * exercises with history (a start kit's batch).
 */
const loaded = { squat: '', cursor: 0, six: [] as string[], workout: '' };
/** A start kit's 'before': the kit is built now, after every set in the dataset. */
const KIT_BUILT = new Date(`${addDays(TODAY, 1)}T00:00:00Z`);

type Query = { toSQL(): { sql: string; params: unknown[] } };
/**
 * A 'write' is explained inside a transaction that is rolled back, so the dataset stays as loaded.
 * A 'recorded' plan is reported and never gated (WHOLE_HISTORY).
 */
type Case = [
	name: string,
	expected: readonly string[],
	query: () => Query,
	mode?: 'write' | 'recorded'
];

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

// What the coach would read: its busiest open conversation, that conversation's newest turn and
// run, an applied program proposal, one still open, and the memory's window up to today.
const counts = new Map<string, number>();
for (const m of coach.coachMessages) counts.set(m.threadId, (counts.get(m.threadId) ?? 0) + 1);
const busy = coach.coachThreads
	.filter((t) => !t.archivedAt)
	.reduce((a, b) => (counts.get(b.id!)! > counts.get(a.id!)! ? b : a));
const busyMessages = coach.coachMessages.filter((m) => m.threadId === busy.id);
const asked = busyMessages.filter((m) => m.kind === 'owner_message').at(-1)!;
const busyRun = coach.agentRuns.filter((r) => r.threadId === busy.id).at(-1)!;
const applied = coach.decisions.find((x) => x.appliedVersionId)!.id;
const decided = new Set(coach.decisions.map((x) => x.id));
const waiting = coach.coachProposals.find((x) => !decided.has(x.id!))!;
const memorySince = addDays(TODAY, 1 - MEMORY_RECORD_DAYS);
/** After the coach's last turn of the day. */
const NOW = new Date(`${TODAY}T23:00:00Z`);
/** Read from the loaded database: the last id of a 100-row page, so the next page is page 6. */
const cursors = { open: '', archived: '', proposal: '', run: '' };
const M = cm.COACH_MEMORY_INDEXES;
const memory = (name: string): string[] => [M[name] ?? []].flat();
const T = ct.COACH_THREAD_INDEXES;
const P = cp.COACH_PROPOSAL_INDEXES;
const R = ar.AGENT_RUN_INDEXES;
const N = cn.COACH_NOTE_INDEXES;

/** The coach's relations: each must be large on the loaded dataset, or the gate would pass idly. */
const COACH_RELATIONS = [
	'coach_threads',
	'coach_messages',
	'coach_notes',
	'coach_proposals',
	'agent_runs',
	'agent_model_calls',
	'agent_tool_calls',
	'pain_reports'
];

/**
 * Decision (m5-plan 'coach-explain'): the usage view's totals (services/coach/runs.ts
 * usageSummary) read every run, model call and tool call the owner has. On a one-owner database
 * the owner's index selects the whole relation, so a sequential scan is the right plan and no
 * index can beat it: these plans are recorded with the index they declare, never gated.
 */
const WHOLE_HISTORY: [name: string, index: string, query: () => Query][] = [
	['coach toolFrequency', R.toolFrequency, () => ar.toolFrequency(db, owner)],
	['coach runTotals', R.summary, () => ar.runTotals(db, owner)],
	['coach statusCounts', R.summary, () => ar.statusCounts(db, owner)],
	['coach unpricedCalls', R.summary, () => ar.unpricedCalls(db, owner)]
];

const COACH_CASES: Case[] = [
	['coach thread', [T.thread], () => ct.thread(db, owner, busy.id!)],
	['coach lockThread', [T.lockThread], () => ct.lockThread(db, owner, busy.id!, NOW), 'write'],
	[
		'coach messageByClientId',
		[T.messageByClientId],
		() => ct.messageByClientId(db, owner, asked.clientMessageId!)
	],
	['coach lastSeq', [T.lastSeq], () => ct.lastSeq(db, owner, busy.id!)],
	[
		'coach lastReplayed',
		[T.lastReplayed],
		() => ct.lastReplayed(db, owner, busy.id!, busy.segment!)
	],
	['coach transcript', [T.transcript], () => ct.transcript(db, owner, busy.id!, busy.segment!)],
	[
		'coach displayPage, newest',
		[T.displayPage],
		() => ct.displayPage(db, owner, busy.id!, { limit: THREAD_VIEW_MESSAGES + 1 })
	],
	[
		'coach displayPage, older',
		[T.displayPage],
		() =>
			ct.displayPage(db, owner, busy.id!, {
				before: busyMessages.length - THREAD_VIEW_MESSAGES,
				limit: THREAD_VIEW_MESSAGES + 1
			})
	],
	...[false, true].flatMap((archived): Case[] => {
		const list = archived ? 'archived' : 'open';
		const index = T.threadPage[list];
		const limit = THREAD_PAGE.default + 1;
		return [
			[
				`coach threadPage, ${list}, first page`,
				[index],
				() => ct.threadPage(db, owner, { archived, limit })
			],
			[
				`coach threadPage, ${list}, page 6`,
				[index, T.thread],
				() => ct.threadPage(db, owner, { archived, before: cursors[list], limit })
			]
		];
	}),
	['coach proposal', [P.proposal], () => cp.proposal(db, owner, applied)],
	['coach lockProposal', [P.lockProposal], () => cp.lockProposal(db, owner, applied), 'write'],
	[
		'coach openDuplicate',
		[P.openDuplicate],
		() =>
			cp.openDuplicate(db, owner, {
				kind: waiting.kind,
				payloadHash: waiting.payloadHash!,
				baseVersionId: waiting.baseVersionId ?? null
			})
	],
	[
		'coach proposalPage, first page',
		[P.proposalPage.all],
		() => cp.proposalPage(db, owner, { limit: PROPOSAL_PAGE.default + 1 })
	],
	[
		'coach proposalPage, proposed',
		[P.proposalPage.status],
		() => cp.proposalPage(db, owner, { status: 'proposed', limit: PROPOSAL_PAGE.default + 1 })
	],
	[
		'coach proposalPage, page 6',
		[P.proposalPage.all, P.proposal],
		() => cp.proposalPage(db, owner, { before: cursors.proposal, limit: PROPOSAL_PAGE.default + 1 })
	],
	[
		'coach decidedSince, a week',
		[P.decidedSince],
		() => cp.decidedSince(db, owner, new Date(NOW.getTime() - 7 * 86_400_000), PROPOSAL_IDS_MAX)
	],
	[
		'coach latestNotes',
		[N.latestNotes],
		() => cn.latestNotes(db, owner, MEMORY_NOTE_KINDS.analysis, NOTES_PAGE.default)
	],
	[
		'coach note ownership',
		[N.ownership],
		() => cn.ownership(db, owner, { runId: busyRun.id!, workoutId: data.workouts.at(-1)!.clientId })
	],
	['coach run', [R.run], () => ar.run(db, owner, busyRun.id!)],
	['coach runningRun', [R.runningRun], () => ar.runningRun(db, owner, busy.id!)],
	['coach ownerMessage', [R.ownerMessage], () => ar.ownerMessage(db, owner, busy.id!, asked.id!)],
	[
		'coach runPage, first page',
		[R.runPage],
		() => ar.runPage(db, owner, { limit: RUN_PAGE.default + 1 })
	],
	[
		'coach runPage, page 6',
		[R.runPage],
		() => ar.runPage(db, owner, { before: cursors.run, limit: RUN_PAGE.default + 1 })
	],
	[
		'coach lastCallInput',
		[R.lastCallInput],
		// The chat calls only: agent/turn.ts numbers drafts from DRAFT_CALL_INDEX_BASE (1000).
		() => ar.lastCallInput(db, owner, busyRun.id!, 1000)
	],
	[
		'coach dayCapCost',
		[...R.dayCapCost],
		() => ar.dayCapCost(db, owner, NOW, TURN_LIMITS.staleRunMs)
	],
	...WHOLE_HISTORY.map(([name, index, query]): Case => [name, [index], query, 'recorded']),
	['memory profileSections', memory('profileSections'), () => cm.profileSections(db, owner)],
	[
		'memory painReportsSince',
		memory('painReportsSince'),
		() => cm.painReportsSince(db, owner, memorySince, MEMORY_RECORD_LIMITS.painReports)
	],
	[
		'memory recoveryNotesSince',
		memory('recoveryNotesSince'),
		() => cm.recoveryNotesSince(db, owner, memorySince, MEMORY_RECORD_LIMITS.recoveryNotes)
	],
	[
		'memory latestWeeklyReviews',
		memory('latestWeeklyReviews'),
		() => cm.latestWeeklyReviews(db, owner, MEMORY_RECORD_LIMITS.weeklyReviews)
	],
	['memory latestCycleReview', memory('latestCycleReview'), () => cm.latestCycleReview(db, owner)],
	[
		'memory recentDecisions',
		memory('recentDecisions'),
		() => cm.recentDecisions(db, owner, MEMORY_RECORD_LIMITS.decisions)
	],
	[
		'memory recentProposals',
		memory('recentProposals'),
		() =>
			cm.recentProposals(db, owner, {
				since: memorySince,
				pending: MEMORY_RECORD_LIMITS.pendingProposals,
				decided: MEMORY_RECORD_LIMITS.decidedProposals
			})
	],
	...Object.values(MEMORY_NOTE_KINDS).map((kind): Case => [
		`memory recentNotes, ${kind}`,
		memory('recentNotes'),
		() => cm.recentNotes(db, owner, kind, MEMORY_RECORD_LIMITS.threadSummaries)
	])
];

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
			'lastSessionSetsFor, six exercises (start kit)',
			[H.lastSessionSets],
			() => h.lastSessionSetsFor(db, owner, loaded.six, KIT_BUILT)
		],
		[
			'bestE1rms, six exercises (start kit)',
			[H.bestE1rms],
			() => h.bestE1rms(db, owner, loaded.six, KIT_BUILT)
		],
		[
			'repMaxes, six exercises (start kit)',
			[H.repMaxes],
			() => h.repMaxes(db, owner, loaded.six, KIT_BUILT)
		],
		[
			'mostReps, six exercises (start kit)',
			[H.mostReps],
			() => h.mostReps(db, owner, loaded.six, KIT_BUILT)
		],
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
		[
			'completedWorkoutsPage, first page (History)',
			Object.values(H.completedWorkoutsPage),
			() => h.completedWorkoutsPage(db, owner, { limit: 21 })
		],
		[
			'completedWorkoutsPage, page 6 (History)',
			Object.values(H.completedWorkoutsPage),
			() => h.completedWorkoutsPage(db, owner, { before: loaded.workout, limit: 21 })
		],
		[
			'activeWorkouts (continue on another device)',
			[H.activeWorkouts],
			() => h.activeWorkouts(db, owner, ACTIVE_WORKOUTS_LIMIT)
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
		[
			'sessionById (start kit adoption)',
			['planned_sessions_pkey', 'program_version_weeks_week_idx'],
			() => p.sessionById(db, owner, session.id!)
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
		['affectedNodes: exercises', ['planned_exercises_lineage_idx'], () => affected.exercises],
		...COACH_CASES
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
	await loadCoachDataset(client, coach);
	catalog = await readCatalog();
	const [squat] = await db
		.select({ id: schema.exercises.id })
		.from(schema.exercises)
		.where(eq(schema.exercises.key, 'back_squat'));
	loaded.squat = squat!.id;
	const pages = await h.exerciseHistory(db, owner, loaded.squat, { limit: 100 });
	loaded.cursor = pages.at(-1)!.id;
	const workouts = await h.completedWorkoutsPage(db, owner, { limit: 100 });
	loaded.workout = workouts.at(-1)!.id;
	const used = await db
		.selectDistinct({ id: schema.setRecords.exerciseId })
		.from(schema.setRecords)
		.orderBy(schema.setRecords.exerciseId)
		.limit(6);
	loaded.six = used.map((row) => row.id);
	const open = await ct.threadPage(db, owner, { archived: false, limit: 100 });
	const archived = await ct.threadPage(db, owner, { archived: true, limit: 100 });
	const proposals = await cp.proposalPage(db, owner, { limit: 100 });
	const runs = await ar.runPage(db, owner, { limit: 100 });
	Object.assign(cursors, {
		open: open.at(-1)!.id,
		archived: archived.at(-1)!.id,
		proposal: proposals.at(-1)!.id,
		run: runs.at(-1)!.id
	});
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
		...plans,
		...m6.report()
	];
	mkdirSync('test-results', { recursive: true });
	writeFileSync('test-results/explain.md', `${report.join('\n')}\n`);
});

describe(`db:explain on ${redactUrl(url)}`, () => {
	it('loads every coach relation large enough for its plans to be gated', () => {
		const sizes = COACH_RELATIONS.map((name) => [name, sizeClass(catalog.relations.get(name)!)]);
		expect(sizes).toEqual(COACH_RELATIONS.map((name) => [name, 'large']));
	});

	it.each(CASES)('%s', async (name, expected, build, mode) => {
		const { sql, params } = build().toSQL();
		const write = mode === 'write';
		if (write) await client.query('begin');
		const explained = await client
			.query<{ 'QUERY PLAN': Explained[] }>(
				`explain (analyze, buffers, format json) ${sql}`,
				params
			)
			.finally(() => (write ? client.query('rollback') : undefined));
		const result = explained.rows[0]!['QUERY PLAN'][0]!;
		const problems = mode === 'recorded' ? [] : checkPlan(result.Plan, expected, catalog);
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
			`| ${name} | ${expected.join(', ')} | ${scans} | ${String(top['Actual Rows'])} | ${result['Execution Time'].toFixed(3)} ms | ${result['Planning Time'].toFixed(3)} ms | ${buffers} | ${problems.length ? problems.join('; ') : mode === 'recorded' ? 'recorded' : 'pass'} |`
		);
		plans.push(`### ${name}`, '', '```text', ...lines, '```', '');
		expect(problems, `${name}\n${lines.join('\n')}`).toEqual([]);
	});
});

// M6's fact queries on their own owner, loaded once M3's cases have run.
const m6 = analyticsExplain({ client, db, owner, readCatalog, render });
