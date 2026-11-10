/**
 * M6's fact queries in db:explain (m6-plan 'analytics-plans'), on the analytics owner
 * (analytics-dataset.ts) loaded into history.explain.ts's database after M3's cases have run.
 * - Every builder of db/queries/analytics.ts runs with the parameters facts.ts passes, for 12
 *   weeks and for 'all' in its windows of at most MAX_RANGE_DAYS (windowsOf), through the same
 *   plan check as M3's builders: on a large relation, the ANALYTICS_INDEXES entry and no Seq Scan
 *   (or a pending index for analytics-explain; segmentFacts at 'all' may read its table whole); ANALYTICS_SMALL reads are recorded.
 *   Each case must return rows, so a join is planned on real linked rows, never on empty input.
 *   workouts stays below the size gate for one owner's two years (about 1.2k rows, 34 pages), so a
 *   Seq Scan of it under the completed-workout join is the right plan: recorded, not gated.
 * - Then the facts-plus-domain pipeline: the strength, running and general dashboard services at
 *   'all', cold and the median of WARM_RUNS warm runs (none when cold takes over WARM_LIMIT_MS),
 *   against PIPELINE_TARGET_MS. The time is recorded, never gated: a miss is the baseline the
 *   levers start from (m6-plan, problem 17).
 * - history.explain.ts writes the returned lines as the M6 section of test-results/explain.md.
 */
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { addDays, mondayOf, type IsoDate } from '../../src/lib/domain/calendar';
import * as a from '../../src/lib/server/db/queries/analytics';
import type * as schema from '../../src/lib/server/db/schema';
import { windowsOf } from '../../src/lib/server/services/analytics/facts';
import { getGeneralDashboard } from '../../src/lib/server/services/analytics/general';
import { getRunningDashboard } from '../../src/lib/server/services/analytics/running';
import { getStrengthDashboard } from '../../src/lib/server/services/analytics/strength';
import { generateAnalyticsDataset, loadAnalyticsDataset } from './analytics-dataset';
import { FIRST_MONDAY, WEEKS } from './dataset';
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

/** Decision (m6-plan): the server time a Progress page aims for; reported, not gated. */
export const PIPELINE_TARGET_MS = 150;
/** The warm runs whose median is reported, after one cold run. */
export const WARM_RUNS = 5;
/**
 * Owner decision (this slice's default, for the m6-plan's 'CI grows by at most 30 s'): a dashboard
 * whose cold run takes longer is reported cold only, its warm runs skipped.
 */
export const WARM_LIMIT_MS = 2_000;

export interface Harness {
	client: pg.Client;
	db: NodePgDatabase<typeof schema>;
	/** The database's one owner, whose history M3's cases read first. */
	owner: string;
	readCatalog: () => Promise<Catalog>;
	render: (plan: PlanNode) => string[];
}

type Query = { toSQL(): { sql: string; params: unknown[] } };
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
const median = (values: number[]) => {
	const sorted = [...values].sort((x, y) => x - y);
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** segmentFacts at 'all' reads nearly every run's segments: the one case opted in to a whole read. */
const SEGMENTS_WHOLE_READ = { wholeRead: 'run_record_segments' } as const;

const DASHBOARDS = {
	strength: getStrengthDashboard,
	running: getRunningDashboard,
	general: getGeneralDashboard
} as const;

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
			['setFacts', [A.setFacts], () => a.setFacts(db, owner, { start, end })],
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

	const CASES: Case[] = [
		...ranges.flatMap(([label, range]) => casesFor(label, range)),
		['blockInputs, the active program', [], () => a.blockInputs(db, program)],
		['firstActivity', [], () => a.firstActivity(db, owner)]
	];

	let catalog: Catalog | undefined;
	const results: string[] = [];
	const plans: string[] = [];
	const timings: string[] = [];

	describe('M6 analytics on the analytics owner', () => {
		beforeAll(async () => {
			await loadAnalyticsDataset(client, data);
			catalog = await readCatalog();
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
			if (!Number(top['Actual Rows'])) problems.push('no rows: the plan is not on real data');
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
				`| ${name} | ${declared || 'small, recorded'} | ${scans} | ${String(top['Actual Rows'])} | ${result['Execution Time'].toFixed(3)} ms | ${result['Planning Time'].toFixed(3)} ms | ${buffers} | ${gate} |`
			);
			plans.push(`### ${name}`, '', '```text', ...lines, '```', '');
			expect(problems, `${name}\n${lines.join('\n')}`).toEqual([]);
		});

		it(`times the dashboards at 'all': cold, then the median of ${WARM_RUNS} warm runs`, async () => {
			const time = async (dashboard: (typeof DASHBOARDS)[keyof typeof DASHBOARDS]) => {
				const started = performance.now();
				await dashboard(db, owner, { period: 'all', today: TODAY });
				return performance.now() - started;
			};
			for (const [name, dashboard] of Object.entries(DASHBOARDS)) {
				const cold = await time(dashboard);
				const warm: number[] = [];
				while (cold <= WARM_LIMIT_MS && warm.length < WARM_RUNS) warm.push(await time(dashboard));
				const middle = warm.length ? median(warm) : null;
				const verdict = (middle ?? cold) <= PIPELINE_TARGET_MS ? 'within' : 'over';
				timings.push(
					`| ${name} | ${cold.toFixed(1)} ms | ${middle === null ? `skipped: cold over ${WARM_LIMIT_MS} ms` : `${middle.toFixed(1)} ms`} | ${verdict} ${PIPELINE_TARGET_MS} ms |`
				);
			}
			console.log(`\nPipeline at 'all' (facts + domain)\n${timings.join('\n')}`);
			expect(timings).toHaveLength(Object.keys(DASHBOARDS).length);
		}, 120_000);
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
						`Facts-plus-domain pipeline at 'all': each dashboard service, cold, then the median of ${WARM_RUNS} warm runs unless cold took over ${WARM_LIMIT_MS} ms.`,
						'',
						'| Dashboard | Cold | Warm median | Target |',
						'| --- | ---: | ---: | --- |',
						...timings,
						'',
						...plans
					]
				: []
	};
}
