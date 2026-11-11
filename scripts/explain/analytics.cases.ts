/**
 * M6's fact queries in db:explain (m6-plan 'analytics-plans'), on the analytics owner
 * (analytics-dataset.ts) loaded into history.explain.ts's database after M3's cases have run.
 * - Every builder of db/queries/analytics.ts runs with the parameters facts.ts passes, for 12
 *   weeks and for 'all' in its windows of at most MAX_RANGE_DAYS (windowsOf), through the same
 *   plan check as M3's builders: on a large relation, the ANALYTICS_INDEXES entry and no Seq Scan
 *   (setFacts and segmentFacts at 'all' may read their table whole); ANALYTICS_SMALL reads are
 *   recorded.
 *   Each case must return rows, so a join is planned on real linked rows, never on empty input.
 *   workouts stays below the size gate for one owner's two years (about 1.2k rows, 34 pages), so a
 *   Seq Scan of it under the completed-workout join is the right plan: recorded, not gated.
 * - No gate waits for an index any more (m6-plan 'analytics-explain'): no case may declare a
 *   pending one, so every declared index is a hard gate.
 * - The owner's reviews (m6-plan 'analytics-explain'): the services write the review of the last
 *   ended week and of the last ended block on this data, then generateReviewHistory adds the
 *   rest of two years of them. db/queries/reviews.ts's builders are explained on them, proposalHeads
 *   on the proposals the first page's reviews link, as decisionStates asks; their relations are
 *   small, so their plans are recorded (narrativeMessages is not: no review here has a write-up,
 *   so it would plan on empty input).
 * - Then the page loads the owner waits for, on two years of data (page-load.ts): /progress for
 *   each view at 'all' and 12 weeks, the weekly review page, the cycle review (its service, which
 *   runs the next block generator for each start on offer, until cycle-review-screen gives the
 *   reviews page a cycle view) and the exercise page of the most-logged lift at 'all'. Each is
 *   timed with devalue's serialisation after WARM_UPS untimed runs; the median against
 *   PAGE_TARGET_MS is reported, and a median over PAGE_LIMIT_MS or page data over
 *   PAGE_DATA_LIMIT_BYTES gzip fails the run.
 * - The strength week rollups (services/analytics/strength-weeks.ts): their two reads are
 *   explained with the rest. The heavy loads are timed first with every week summed from the
 *   facts (recorded, not gated: the gated loads are the same pages read from the rollups), then
 *   every closed week is written as a deploy's first sync of a finished workout writes it, and the
 *   page data of every view at every period, on three days of the last week, must be the same
 *   devalue'd from the rollups as from the facts, with every week stale, with every third and with
 *   the later half. Every other load then reads the rollups.
 * - history.explain.ts writes the returned lines as the M6 section of test-results/explain.md.
 */
import { execSync } from 'node:child_process';
import os from 'node:os';
import { stringify } from 'devalue';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { addDays, daysBetween, mondayOf, type IsoDate } from '../../src/lib/domain/calendar';
import { PERIODS } from '../../src/lib/domain/analytics/period-names';
import type { Period } from '../../src/lib/domain/analytics/periods';
import * as a from '../../src/lib/server/db/queries/analytics';
import * as r from '../../src/lib/server/db/queries/reviews';
import * as sw from '../../src/lib/server/db/queries/strength-weeks';
import type * as schema from '../../src/lib/server/db/schema';
import type { Executor } from '../../src/lib/server/db/types';
import { windowsOf } from '../../src/lib/server/services/analytics/facts';
import { getStrengthDashboard } from '../../src/lib/server/services/analytics/strength';
import { refreshStrengthWeeks } from '../../src/lib/server/services/analytics/strength-weeks';
import {
	createCycleReview,
	createWeeklyReview,
	getCycleReviewView,
	reviewableBlock
} from '../../src/lib/server/services/reviews/index';
import type { recordServerError } from '../../src/lib/server/services/errors';
import { loadExerciseDetail } from '../../src/routes/(app)/progress/exercises/[id]/load';
import { loadProgress } from '../../src/routes/(app)/progress/load';
import { PROGRESS_VIEWS } from '../../src/routes/(app)/progress/params';
import {
	LIST_LIMIT,
	loadReviews,
	weeklyKey
} from '../../src/routes/(app)/progress/reviews/[[key]]/load';
import {
	generateAnalyticsDataset,
	generateReviewHistory,
	loadAnalyticsDataset,
	loadReviewHistory,
	type ReviewTemplates
} from './analytics-dataset';
import { FIRST_MONDAY, WEEKS } from './dataset';
import {
	kb,
	loadProblems,
	PAGE_DATA_LIMIT_BYTES,
	PAGE_LIMIT_MS,
	PAGE_TARGET_MS,
	TIMED_RUNS,
	timeLoad,
	WARM_UPS
} from './page-load';
import {
	checkPlan,
	pendingOf,
	scansOf,
	sizeClass,
	wholeReadsOf,
	type Catalog,
	type ExpectedIndex,
	type PlanNode
} from './plan-check';

/** The periods each /progress view is timed at: the longest, and the one it opens on. */
export const TIMED_PERIODS = ['all', '12w'] as const satisfies readonly Period[];

export interface Harness {
	client: pg.Client;
	db: NodePgDatabase<typeof schema>;
	/** The database's one owner, whose history M3's cases read first. */
	owner: string;
	readCatalog: () => Promise<Catalog>;
	render: (plan: PlanNode) => string[];
}

type Query = { toSQL(): { sql: string; params: unknown[] } };
/** A page load, timed by name. */
type Load = [name: string, load: () => Promise<unknown>];
type Case = [name: string, expected: readonly ExpectedIndex[], query: () => Query];

interface Explained {
	Plan: PlanNode;
	'Planning Time': number;
	'Execution Time': number;
}

/** The Wednesday of the dataset's last week, as M3's cases read it. */
const TODAY = addDays(FIRST_MONDAY, (WEEKS - 1) * 7 + 2);
const ZONE_SLACK_MS = 14 * 3_600_000;
const instants = ({ from, to }: { from: IsoDate; to: IsoDate }) => ({
	start: new Date(Date.parse(`${from}T00:00:00Z`) - ZONE_SLACK_MS),
	end: new Date(Date.parse(`${addDays(to, 1)}T00:00:00Z`) + ZONE_SLACK_MS)
});
/** segmentFacts at 'all' reads nearly every run's segments: opted in to a whole read. */
const SEGMENTS_WHOLE_READ = { wholeRead: 'run_record_segments' } as const;
/**
 * setFacts at 'all' reads nearly every set (one owner's two years are 94 % of set_records here):
 * opted in to a whole read, which Postgres rightly picks over walking the index for most of the
 * table. 12 weeks and the short second window still gate the index.
 */
const SETS_WHOLE_READ = { wholeRead: 'set_records' } as const;

/**
 * The rows a plan reads: an aggregate's input (a fact query's one JSON array), its InitPlans (the
 * ids it probes with) aside, else its own.
 */
function rowsRead(top: PlanNode): PlanNode {
	const input = (top.Plans ?? []).filter((p) => p['Parent Relationship'] !== 'InitPlan');
	return top['Node Type'] === 'Aggregate' && input.length === 1 ? rowsRead(input[0]!) : top;
}

/** Noon on TODAY: the instant each page load runs at (its day comes from TODAY itself). */
const NOW = new Date(`${TODAY}T12:00:00Z`);
const ORIGIN = {
	requestId: 'db-explain',
	method: 'GET',
	path: '/progress',
	routeId: null,
	appVersion: 'explain'
};

/**
 * The SQL a builder that runs its statement itself (db.execute) would send: it is called on an
 * executor that records the statement and returns no rows.
 */
async function capturedSql(build: (db: Executor) => Promise<unknown>): Promise<Query> {
	let statement: SQL | undefined;
	const recorder = {
		execute: (query: SQL) => {
			statement = query;
			return Promise.resolve({ rows: [] });
		}
	} as unknown as Executor;
	await build(recorder);
	const query = new PgDialect().sqlToQuery(statement!);
	return { toSQL: () => ({ sql: query.sql, params: query.params }) };
}

/** The machine, day and commit a timing was taken on. */
function machine(): string {
	const commit = (process.env.GITHUB_SHA ?? execSync('git rev-parse HEAD').toString()).slice(0, 7);
	const cpu = `${os.cpus()[0]?.model ?? 'cpu'} × ${os.cpus().length}`;
	return `${new Date().toISOString().slice(0, 10)} · commit ${commit} · ${cpu} · ${os.platform()}`;
}

export function analyticsExplain({ client, db, owner, readCatalog, render }: Harness) {
	const data = generateAnalyticsDataset(owner);
	const A = a.ANALYTICS_INDEXES;

	// What the loader would read: 12 weeks to today, and 'all' window by window.
	const ranges: [string, { from: IsoDate; to: IsoDate }][] = [
		['12 weeks', { from: addDays(mondayOf(TODAY), -7 * 12), to: TODAY }],
		...windowsOf(FIRST_MONDAY, TODAY).map((w, i, all): [string, typeof w] => [
			`all, window ${i + 1} of ${all.length}`,
			w
		])
	];
	const program = data.programs.find((p) => p.status === 'active')!.id!;
	const version = data.heads.find((head) => head.programId === program)!.versionId;
	const versionWeeks = new Set(
		data.programVersionWeeks.filter((m) => m.versionId === version).map((m) => m.weekId)
	);

	function casesFor(label: string, range: { from: IsoDate; to: IsoDate }): Case[] {
		const { start, end } = instants(range);
		const counted = data.workouts.filter(
			(w) =>
				w.status === a.COUNTED_STATUS && !w.deletedAt && w.startedAt! >= start && w.startedAt! < end
		);
		const runs = counted.filter((w) => w.kind === 'run').map((w) => w.id!);
		const plannedIds = [
			...new Set(counted.flatMap((w) => (w.kind === 'strength' && w.plannedSessionId) || []))
		];
		const planned = data.plannedSessions.filter(
			(s) => versionWeeks.has(s.weekId) && s.scheduledOn >= range.from && s.scheduledOn <= range.to
		);
		const plannedRuns = planned.filter((s) => s.discipline === 'running').map((s) => s.id!);
		const prescriptions = a.prescriptionFacts(db, plannedIds);
		const facts = a.plannedFacts(db, owner);
		const cases: Case[] = [
			[
				'setFacts',
				label.startsWith('all') ? [A.setFacts, SETS_WHOLE_READ] : [A.setFacts],
				() => a.setFacts(db, owner, { start, end })
			],
			['sessionFacts', [A.sessionFacts], () => a.sessionFacts(db, owner, { start, end })],
			[
				`segmentFacts, ${runs.length} runs`,
				label.startsWith('all') ? [A.segmentFacts, SEGMENTS_WHOLE_READ] : [A.segmentFacts],
				() => a.segmentFacts(db, owner, runs)
			],
			[
				`prescriptionFacts: exercises, ${plannedIds.length} sessions`,
				[A.prescriptionFacts.exercises],
				() => prescriptions.exercises
			],
			[
				`prescriptionFacts: sets, ${plannedIds.length} sessions`,
				[A.prescriptionFacts.exercises, A.prescriptionFacts.sets],
				() => prescriptions.sets
			],
			[
				'plannedFacts: planned',
				[A.plannedFacts.planned],
				() => facts.planned(version, range.from, range.to)
			],
			[
				`plannedFacts: completed, ${planned.length} lineages`,
				[A.plannedFacts.completed],
				() => facts.completed(planned.map((s) => s.lineageId!))
			],
			[
				`plannedFacts: runSegments, ${plannedRuns.length} runs`,
				[A.plannedFacts.runSegments],
				() => facts.runSegments(plannedRuns)
			],
			['recoveryFacts', [], () => a.recoveryFacts(db, owner, range.from, range.to)],
			['programsInRange', [], () => a.programsInRange(db, owner, range.from, range.to)]
		];
		return cases.map(([name, expected, query]) => [`${name} (${label})`, expected, query]);
	}

	// The reviews the services write, and what the cases and loads read of them.
	const week = addDays(mondayOf(TODAY), -7);
	/** Last week's counted workouts, whose spans a rollup's write reads. */
	const lastWeekWorkouts = data.workouts.flatMap((w) =>
		w.status === a.COUNTED_STATUS &&
		!w.deletedAt &&
		w.startedAt! >= new Date(`${week}T00:00:00Z`) &&
		w.startedAt! < new Date(`${mondayOf(TODAY)}T00:00:00Z`)
			? [w.id!]
			: []
	);
	const loaded = {
		block: { programId: '', blockLineage: '' },
		superseded: { weekly: '', cycle: '' },
		/** proposalChain's statement from a revised proposal (it runs itself: captured). */
		chain: undefined as Query | undefined,
		/** proposalHeads' statement for the proposals the first page's reviews link (captured). */
		heads: undefined as Query | undefined,
		page: [] as {
			kind: r.ReviewKind;
			id: string;
			startsOn: string | null;
			endsOn: string | null;
		}[],
		lift: '',
		/** Every exercise the owner's sets name, as exerciseMuscles reads them. */
		exercises: [] as string[]
	};
	/** A failed read fails the timing instead of showing the load-failed notice. */
	const rethrow = (async ({ error }) => {
		throw error;
	}) satisfies typeof recordServerError;
	const deps = { db, today: () => Promise.resolve(TODAY), record: rethrow };
	const R = r.REVIEW_INDEXES;
	const lastOf = (kind: r.ReviewKind) => loaded.page.findLast((row) => row.kind === kind);

	const CASES: Case[] = [
		...ranges.flatMap(([label, range]) => casesFor(label, range)),
		[
			"exerciseMuscles, every exercise the owner's sets name",
			[],
			() => a.exerciseMuscles(db, loaded.exercises)
		],
		['blockInputs, the active program', [], () => a.blockInputs(db, program)],
		[
			'strengthWeekRows, every week of the strength week rollups',
			[sw.STRENGTH_WEEKS_INDEXES.weeks],
			() => sw.strengthWeekRows(db, owner, FIRST_MONDAY, mondayOf(TODAY))
		],
		[
			`workoutSpans, last week's ${lastWeekWorkouts.length} workouts`,
			[sw.STRENGTH_WEEKS_INDEXES.spans],
			() => sw.workoutSpans(db, owner, lastWeekWorkouts)
		],
		['firstActivity', [], () => a.firstActivity(db, owner)],
		['reviews liveWeeklyReview', [R.liveWeeklyReview], () => r.liveWeeklyReview(db, owner, week)],
		[
			'reviews liveCycleReview',
			[R.liveCycleReview],
			() => r.liveCycleReview(db, owner, loaded.block.programId, loaded.block.blockLineage)
		],
		[
			'reviews weeklyReview, a superseded revision',
			[R.weeklyReview],
			() => r.weeklyReview(db, owner, loaded.superseded.weekly)
		],
		[
			'reviews cycleReview, a superseded revision',
			[R.cycleReview],
			() => r.cycleReview(db, owner, loaded.superseded.cycle)
		],
		[
			`reviews reviewsPage, first page of ${LIST_LIMIT}`,
			[R.reviewsPage.weekly, R.reviewsPage.cycle],
			() => r.reviewsPage(db, owner, { limit: LIST_LIMIT })
		],
		[
			`reviews reviewsPage, second page of ${LIST_LIMIT}`,
			[R.reviewsPage.weekly, R.reviewsPage.cycle],
			() => {
				const [weekly, cycle] = [lastOf('weekly'), lastOf('cycle')];
				const before = {
					weekly: weekly!.startsOn!,
					...(cycle && { cycle: { endsOn: cycle.endsOn, id: cycle.id } })
				};
				return r.reviewsPage(db, owner, { before, limit: LIST_LIMIT });
			}
		],
		['reviews proposalChain, a revised proposal', [], () => loaded.chain!],
		["reviews proposalHeads, the first page's proposals", [], () => loaded.heads!]
	];

	/** Every page load the owner waits for, on two years of data. */
	const LOADS: Load[] = [
		...TIMED_PERIODS.flatMap((period) =>
			PROGRESS_VIEWS.map((view): Load => [
				`/progress ${view}, ${period}`,
				() => loadProgress(owner, { view, period, origin: ORIGIN }, NOW, deps)
			])
		),
		[
			`/progress/reviews/${weeklyKey(week)}`,
			() => loadReviews(owner, { key: weeklyKey(week), origin: ORIGIN }, NOW, deps)
		],
		[
			'the cycle review (getCycleReviewView, with the next block for each start)',
			() => getCycleReviewView(owner, { ...loaded.block, today: TODAY }, { db })
		],
		[
			'/progress/exercises/[id], the most-logged lift, all',
			() =>
				loadExerciseDetail(
					owner,
					{ exerciseId: loaded.lift, period: 'all', origin: ORIGIN },
					NOW,
					deps
				)
		]
	];

	/**
	 * The heavy /progress loads, timed again with every week summed from the facts, as before the
	 * rollups and until the first write after a deploy: recorded beside the gated loads, which read
	 * the rollups.
	 */
	const FROM_FACTS: Load[] = TIMED_PERIODS.flatMap((period) =>
		(['overview', 'strength'] as const).map((view): Load => [
			`/progress ${view}, ${period}, every week summed from the facts`,
			() => loadProgress(owner, { view, period, origin: ORIGIN }, NOW, deps)
		])
	);
	/** Every closed week marked stale, as a write to each would mark it. */
	const markStale = (weeks?: readonly IsoDate[]) =>
		client.query(
			`update strength_week_rollups set generation = generation + 1, written_at = null,
				digest = null, split = false
			 where owner_id = $1 and ($2::date[] is null or week_start = any($2::date[]))`,
			[owner, weeks ?? null]
		);
	/**
	 * Every view's page data at every period, the Strength view's whole dashboard and the
	 * overview's, devalue'd, on a Monday, a Wednesday and a Sunday of the dataset's last week.
	 */
	async function pages(): Promise<Map<string, string>> {
		const out = new Map<string, string>();
		for (const today of [addDays(TODAY, -2), TODAY, addDays(TODAY, 4)]) {
			const on = { ...deps, today: () => Promise.resolve(today) };
			const now = new Date(`${today}T12:00:00Z`);
			for (const period of PERIODS) {
				for (const view of PROGRESS_VIEWS) {
					const data = await loadProgress(owner, { view, period, origin: ORIGIN }, now, on);
					out.set(`${today} ${view} ${period}`, stringify(data));
				}
				const strength = await getStrengthDashboard(db, owner, { period, today });
				out.set(`${today} strength dashboard ${period}`, stringify(strength));
			}
		}
		return out;
	}

	let catalog: Catalog | undefined;
	let backfill = '';
	const results: string[] = [];
	const plans: string[] = [];
	const timings: string[] = [];
	let machineLine = '';

	/**
	 * A load timed, its line kept for the report; it fails over the page data limit, and over
	 * PAGE_LIMIT_MS unless its time is only `recorded`.
	 */
	async function time(name: string, load: () => Promise<unknown>, recorded = false) {
		const timing = await timeLoad(load);
		const slow = loadProblems({ ...timing, size: { raw: 0, gzip: 0 } });
		const problems = recorded ? loadProblems({ ...timing, median: 0 }) : loadProblems(timing);
		const verdict = timing.median <= PAGE_TARGET_MS ? 'within' : 'over';
		const gate = problems.length
			? problems.join('; ')
			: recorded
				? `time recorded${slow.length ? `: ${slow.join('; ')}` : ''}`
				: 'pass';
		timings.push(
			`| ${name} | ${timing.median.toFixed(1)} ms | ${timing.p95.toFixed(1)} ms | ${verdict} ${PAGE_TARGET_MS} ms | ${kb(timing.size.gzip)} (${kb(timing.size.raw)}) | ${gate} |`
		);
		console.log(
			`\n${name} (${machineLine})\nmedian ${timing.median.toFixed(1)} ms, p95 ${timing.p95.toFixed(1)} ms, page data ${kb(timing.size.gzip)} gzip (${kb(timing.size.raw)})`
		);
		expect(problems, name).toEqual([]);
	}

	describe('M6 analytics on the analytics owner', () => {
		beforeAll(async () => {
			await loadAnalyticsDataset(client, data);
			// The live reviews a page load reads, written by the services on this data.
			const weekly = await createWeeklyReview(owner, { weekStartsOn: week, today: TODAY }, { db });
			const block = await reviewableBlock(owner, TODAY, { db });
			if (!block) throw new Error(`no block is reviewable on ${TODAY}`);
			loaded.block = { programId: block.programId, blockLineage: block.blockLineage };
			const cycle = await createCycleReview(owner, { ...loaded.block, today: TODAY }, { db });
			const proposal = await client.query<ReviewTemplates['nextCycle']>(
				`select summary, rationale, payload, evidence, diff, impact, payload_hash as "payloadHash"
				 from coach_proposals where id = $1`,
				[cycle.review.proposalId]
			);
			const template = (review: typeof weekly.review | typeof cycle.review) => ({
				snapshot: review.snapshot,
				summary: review.summary,
				snapshotVersion: review.snapshotVersion,
				analyticsVersion: review.analyticsVersion,
				inputsDigest: review.inputsDigest!
			});
			const templates = {
				weekly: template(weekly.review),
				cycle: template(cycle.review),
				nextCycle: proposal.rows[0]!
			};
			const written = { week, blockLineage: block.blockLineage };
			const history = generateReviewHistory(data, templates, { today: TODAY, written });
			await loadReviewHistory(client, history);
			loaded.superseded = {
				weekly: history.weeklyReviews.find((row) => row.supersededBy)!.id!,
				cycle: history.cycleReviews.find((row) => row.supersededBy)!.id!
			};
			const revised = history.coachProposals.find((p) => p.revisionOf)!.revisionOf!;
			loaded.chain = await capturedSql((recorder) => r.proposalChain(recorder, owner, revised));
			loaded.page = await r.reviewsPage(db, owner, { limit: LIST_LIMIT });
			const linked = new Map(
				[...history.weeklyReviews, ...history.cycleReviews].map((row) => [row.id, row.proposalId])
			);
			const ids = loaded.page.flatMap((row) => linked.get(row.id) ?? []);
			loaded.heads = await capturedSql((recorder) => r.proposalHeads(recorder, owner, ids));
			const lifts = await client.query<{ id: string }>(
				`select exercise_id as id from set_records where owner_id = $1
				 group by exercise_id order by count(*) desc, exercise_id limit 1`,
				[owner]
			);
			loaded.lift = lifts.rows[0]!.id;
			const named = await client.query<{ id: string }>(
				'select distinct exercise_id as id from set_records where owner_id = $1',
				[owner]
			);
			loaded.exercises = named.rows.map((row) => row.id);
			catalog = await readCatalog();
			machineLine = machine();
		}, 120_000);

		it.each(CASES)('%s', async (name, expected, build) => {
			const { sql, params } = build().toSQL();
			const explained = await client.query<{ 'QUERY PLAN': Explained[] }>(
				`explain (analyze, buffers, format json) ${sql}`,
				params
			);
			const result = explained.rows[0]!['QUERY PLAN'][0]!;
			const top = result.Plan;
			const problems = checkPlan(top, expected, catalog!);
			if (!Number(rowsRead(top)['Actual Rows']))
				problems.push('no rows: the plan is not on real data');
			const notes = [
				...pendingOf(expected, catalog!).map((p) => `pending ${p.index}`),
				...wholeReadsOf(top, expected, catalog!).map(
					(r) => `whole read of ${r.relation} (${Math.round(r.share * 100)} %)`
				)
			];
			const lines = render(top);
			console.log(`\n${name}\n${lines.join('\n')}\nExecution ${result['Execution Time']} ms`);
			const scans = scansOf(top, catalog!)
				.map(
					(s) =>
						`${s.size === 'large' ? '**' : ''}${s.node} ${s.index ?? s.relation}${s.size === 'large' ? '**' : ''}`
				)
				.join(', ');
			const declared = expected
				.map((e) => (typeof e === 'string' ? e : 'index' in e ? e.index : `whole ${e.wholeRead}`))
				.join(', ');
			const buffers = `${String(top['Shared Hit Blocks'])}/${String(top['Shared Read Blocks'])}`;
			const gate = problems.length ? problems.join('; ') : ['pass', ...notes].join(', ');
			results.push(
				`| ${name} | ${declared || 'small, recorded'} | ${scans} | ${String(rowsRead(top)['Actual Rows'])} | ${result['Execution Time'].toFixed(3)} ms | ${result['Planning Time'].toFixed(3)} ms | ${buffers} | ${gate} |`
			);
			plans.push(`### ${name}`, '', '```text', ...lines, '```', '');
			expect(problems, `${name}\n${lines.join('\n')}`).toEqual([]);
		});

		it('leaves no gate waiting for an index: every declared index is a hard gate', () => {
			const pending = CASES.flatMap(([name, expected]) =>
				expected.flatMap((entry) =>
					typeof entry === 'object' && 'pendingIndex' in entry ? [`${name}: ${entry.index}`] : []
				)
			);
			expect(pending).toEqual([]);
		});

		it.each(FROM_FACTS)(
			`times %s: ${WARM_UPS} warm-ups, then the median and p95 of ${TIMED_RUNS} runs`,
			async (name, load) => {
				await markStale();
				await time(name, load, true);
			},
			120_000
		);

		it("writes every closed week once, as a deploy's first sync of a finished workout does", async () => {
			await markStale();
			const started = performance.now();
			const written = await refreshStrengthWeeks(db, owner, NOW);
			const took = performance.now() - started;
			const { rows } = await client.query<{ split: number; weeks: number }>(
				`select count(*) filter (where split)::int as split, count(*)::int as weeks
				 from strength_week_rollups where owner_id = $1 and written_at is not null`,
				[owner]
			);
			backfill = `${written} closed weeks written in ${took.toFixed(0)} ms, ${rows[0]!.split} of them split`;
			console.log(`\nstrength week rollups: ${backfill}`);
			expect(written).toBe(rows[0]!.weeks);
			expect(written).toBe(daysBetween(FIRST_MONDAY, mondayOf(TODAY)) / 7);
			// A second write finds every week current and writes nothing.
			expect(await refreshStrengthWeeks(db, owner, NOW)).toBe(0);
		});

		it('gives the same page data from the rollups as from the facts, for every view and period', async () => {
			await markStale();
			const facts = await pages();
			await refreshStrengthWeeks(db, owner, NOW);
			expect(await pages()).toEqual(facts);
			// Some weeks stale, the rest from their rollups: every third week, then the second half.
			const { rows } = await client.query<{ week: IsoDate }>(
				`select week_start::text as week from strength_week_rollups
					 where owner_id = $1 and written_at is not null order by week_start`,
				[owner]
			);
			const weeks = rows.map((row) => row.week);
			for (const stale of [weeks.filter((_, i) => i % 3 === 0), weeks.slice(weeks.length >> 1)]) {
				await markStale(stale);
				expect(await pages()).toEqual(facts);
				await refreshStrengthWeeks(db, owner, NOW);
			}
		}, 300_000);

		it.each(LOADS)(
			`times %s: ${WARM_UPS} warm-ups, then the median and p95 of ${TIMED_RUNS} runs`,
			time,
			120_000
		);
	});

	return {
		/** The M6 section of test-results/explain.md; empty when the load never ran. */
		report: (): string[] =>
			catalog
				? [
						'## M6 analytics',
						'',
						`The analytics owner (scripts/explain/analytics-dataset.ts), today ${TODAY}.`,
						'',
						'| Relation | Rows | Pages | Size |',
						'| --- | ---: | ---: | --- |',
						...[...catalog.relations]
							.filter(([, size]) => size.tuples > 0)
							.map(
								([name, z]) =>
									`| ${name} | ${Math.round(z.tuples)} | ${z.pages} | ${sizeClass(z)} |`
							),
						'',
						'| Query | Declared index | Scans (large relations in bold) | Rows | Execution | Planning | Buffers hit/read | Gate |',
						'| --- | --- | --- | ---: | ---: | ---: | ---: | --- |',
						...results,
						'',
						`Page loads on two years of data, serialisation included (${machineLine}): ${WARM_UPS} warm-ups, then the median and p95 of ${TIMED_RUNS} runs. The target is reported; a median over ${PAGE_LIMIT_MS} ms or page data over ${kb(PAGE_DATA_LIMIT_BYTES)} gzip fails. The loads 'every week summed from the facts' run before the strength week rollups are written (${backfill || 'not written'}) and are recorded; the rest read them.`,
						'',
						'| Load | Median | p95 | Target | Page data gzip (raw) | Gate |',
						'| --- | ---: | ---: | --- | ---: | --- |',
						...timings,
						'',
						...plans
					]
				: []
	};
}
