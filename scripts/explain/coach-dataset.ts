/**
 * The db:explain coach dataset (m5-plan 'coach-explain'): what two years of using the coach leave
 * on top of dataset.ts's training, generated from its own seed (mulberry32, no clock, no
 * Math.random), so every run explains the same rows, and loaded as the app stores them.
 * - COACH_VOLUMES.threads conversations over the dataset's days, the newest last, and
 *   COACH_VOLUMES.archivedThreads of them archived. Each is a transcript of turns: a segment
 *   preamble, then per turn the owner's message, tool rounds (an assistant tool_use row and its
 *   tool_results row) and the answer, or a display_only row when the turn was stopped. A few run
 *   for weeks: a segment ends at SEGMENT.messages, behind a thread summary note.
 * - One run per turn, with a model call per step and a tool call per tool_use block.
 * - Proposals from some turns, named by the run and tool call that made them, inserted 'proposed'
 *   and decided by UPDATE (applied, rejected or superseded), as the guards require. The last
 *   OPEN_DAYS days' are still open.
 * - Notes: thread summaries, workout analyses of most logged workouts, and the coach's decisions
 *   behind applied goal and preference proposals.
 * - COACH_VOLUMES.painReports pain reports on logged workouts, a few soft-deleted by UPDATE so the
 *   audit trigger records them.
 * Rows name exercises by catalogue key, as dataset.ts's do. Load it after loadDataset, whose owner,
 * workouts and program versions it names; the loader analyses the database again.
 */
import type pg from 'pg';
import { addDays, type IsoDate } from '../../src/lib/domain/calendar';
import { SEGMENT } from '../../src/lib/domain/coach/budgets';
import { PRICING } from '../../src/lib/domain/coach/pricing';
import { TOOL_CATALOGUE, TOOL_NAMES } from '../../src/lib/domain/coach/tools';
import { BODY_AREAS, SEVERITIES } from '../../src/lib/domain/profile/catalog';
import { seededRandom } from '../../src/lib/domain/programming/random';
import { PAIN_ACTIONS } from '../../src/lib/domain/workout/mutations';
import * as t from '../../src/lib/server/db/schema';
import type { AppliedRef } from '../../src/lib/server/db/schema/coaching';
import { FIRST_MONDAY, insertAll, WEEKS, type Dataset } from './dataset';

export const COACH_DATASET_SEED = 'db-explain-coach/1';

/**
 * Decision (m5-plan 'coach-explain'): the volumes the coach's plans are gated on. About three
 * conversations a day for two years, a quarter of them archived, and the plan's 2,000 pain
 * reports: enough that every coach relation is large by plan-check.ts's rule, so it is gated.
 */
export const COACH_VOLUMES = Object.freeze({
	threads: 2_000,
	archivedThreads: 500,
	painReports: 2_000
});

/** The coach's last day: the Wednesday of the dataset's last week, history.explain.ts's today. */
export const COACH_LAST_DAY: IsoDate = addDays(FIRST_MONDAY, (WEEKS - 1) * 7 + 2);
/** Proposals made in the last OPEN_DAYS days still wait for the owner. */
export const OPEN_DAYS = 14;

/** The model every run asks for: the coach's own, the first one priced. */
const MODEL = Object.keys(PRICING)[0]!;
const tools = (effect: string) => TOOL_NAMES.filter((n) => TOOL_CATALOGUE[n].effect === effect);
const READ_TOOLS = tools('read');
const PROPOSING_TOOLS = tools('propose');
/** The kinds proposed, with what applying each records: a version, or an applied_ref. */
const APPLIED = {
	program_adjustment: null,
	session_substitution: 'substitution',
	goal_update: 'goal',
	preference_update: 'preference'
} as const;
const MINUTE = 60_000;
const DAY = 1_440 * MINUTE;

/** The coach's tables, parents first: the order the loader inserts them in. */
const TABLES = {
	coachThreads: t.coachThreads,
	coachMessages: t.coachMessages,
	agentRuns: t.agentRuns,
	agentModelCalls: t.agentModelCalls,
	coachProposals: t.coachProposals,
	agentToolCalls: t.agentToolCalls,
	coachNotes: t.coachNotes,
	painReports: t.painReports
};
type Rows = { [K in keyof typeof TABLES]: (typeof TABLES)[K]['$inferInsert'][] };

/** How the owner decided a proposal: applied after the inserts as an UPDATE. */
export interface ProposalDecision {
	id: string;
	status: 'applied' | 'rejected' | 'superseded';
	closedAt: Date;
	appliedVersionId: string | null;
	appliedRef: AppliedRef | null;
	decisionNote: string | null;
	supersededReason: 'program_changed' | null;
}

export interface CoachDataset extends Rows {
	decisions: ProposalDecision[];
	/** Pain reports the owner deleted, applied as audited UPDATEs. */
	deletedPainReports: string[];
}

/** `n` sentences on `topic`: text of a realistic length. */
const prose = (n: number, topic: string) =>
	Array.from(
		{ length: n },
		(_, i) => `Point ${i + 1} on ${topic}: easy days easy, heavy sets honest.`
	).join(' ');

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const USAGE = Object.keys(ZERO_USAGE) as (keyof typeof ZERO_USAGE)[];

export function generateCoachDataset(base: Dataset, seed: string | number = COACH_DATASET_SEED) {
	const rng = seededRandom(seed);
	const hex = () =>
		Math.floor(rng.next() * 2 ** 32)
			.toString(16)
			.padStart(8, '0');
	/** A version 4 uuid from four draws. */
	const id = () => {
		const h = hex() + hex() + hex() + hex();
		return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20)}`;
	};
	const between = (min: number, max: number) => min + rng.int(max - min + 1);
	const chance = (p: number) => rng.next() < p;
	const ownerId = base.owner.id!;
	const d: CoachDataset = {
		...(Object.fromEntries(Object.keys(TABLES).map((name) => [name, []])) as unknown as Rows),
		decisions: [],
		deletedPainReports: []
	};
	const start = Date.parse(`${FIRST_MONDAY}T06:00:00Z`);
	const end = Date.parse(`${COACH_LAST_DAY}T21:00:00Z`);
	const deleted = new Set(base.edits.deletedWorkouts);
	// The live workouts logged by the coach's last day, an hour and a half before its end.
	const workouts = base.workouts.filter(
		(w) => !deleted.has(w.clientId) && +w.finishedAt! < end - 90 * MINUTE
	);
	const workoutRef = (w: (typeof workouts)[number]) =>
		({ type: 'workout', id: w.clientId, label: w.title ?? 'Workout' }) as const;
	const versions = base.programs.map((p) =>
		base.programVersions.filter((v) => v.programId === p.id).sort((a, b) => a.number - b.number)
	);
	/** The newest program version made by `time`: the one a segment started then names. */
	const byTime = versions.flat().sort((a, b) => +a.createdAt! - +b.createdAt!);
	const versionAt = (time: number) => byTime.findLast((v) => +v.createdAt! <= time)?.id ?? null;

	/** A proposal a tool call made at `createdAt`, decided by the owner unless it is recent. */
	function propose(threadId: string, runId: string, toolUseId: string, createdAt: Date) {
		const proposalId = id();
		const kind = rng.pick(Object.keys(APPLIED) as (keyof typeof APPLIED)[]);
		const program =
			kind === 'program_adjustment' ? rng.pick(versions.filter((v) => v.length > 1)) : [];
		const n = rng.int(Math.max(program.length - 1, 1));
		d.coachProposals.push({
			id: proposalId,
			ownerId,
			kind,
			title: `Adjust ${kind.replace('_', ' ')}`,
			summary: prose(1, 'the change'),
			rationale: prose(3, 'why it helps'),
			payload: { ops: Array.from({ length: between(1, 6) }, () => prose(1, 'one change')) },
			evidence: { workouts: [id(), id()] },
			programId: program[n]?.programId,
			baseVersionId: program[n]?.id,
			threadId,
			runId,
			toolUseId,
			payloadVersion: 1,
			payloadHash: hex() + hex(),
			// As services/coach/proposals.ts stores them (StoredDiff, StoredImpact), which its
			// cards read; the same draws as before, so the rest of the dataset is unchanged.
			diff: {
				rows: [],
				summaryLines: Array.from({ length: between(2, 8) }, () => prose(1, 'before and after')),
				warnings: []
			},
			impact: { weeks: [], lines: [`${between(1, 6)} sessions`, `${between(-30, 30)} min`] },
			createdAt
		});
		if (+createdAt > end - OPEN_DAYS * DAY) return proposalId;
		const closedAt = new Date(Math.min(end, +createdAt + between(10, 4_000) * MINUTE));
		const roll = rng.next();
		const status = roll < 0.6 ? 'applied' : roll < 0.87 ? 'rejected' : 'superseded';
		const refKind = status === 'applied' ? APPLIED[kind] : null;
		const ref = refKind ? { kind: refKind, id: id() } : null;
		d.decisions.push({
			id: proposalId,
			status,
			closedAt,
			appliedVersionId: status === 'applied' ? (program[n + 1]?.id ?? null) : null,
			appliedRef: ref,
			decisionNote: status === 'rejected' && chance(0.5) ? 'Not this week.' : null,
			supersededReason: status === 'superseded' ? 'program_changed' : null
		});
		if (ref && ref.kind !== 'substitution') {
			const [what, why] = [prose(1, 'the change'), prose(2, 'why')];
			d.coachNotes.push({
				id: id(),
				ownerId,
				kind: 'coach_decision',
				subjects: [{ type: ref.kind, id: ref.id }],
				body: { kind, what, why, proposalId },
				summary: what,
				createdAt: closedAt
			});
		}
		return proposalId;
	}

	const starts = Array.from({ length: COACH_VOLUMES.threads }, () =>
		Math.round(start + rng.next() * (end - start))
	).sort((a, b) => a - b);
	for (const [i, opened] of starts.entries()) {
		const threadId = id();
		const promptVersion = `explain-prompt-${i < starts.length / 2 ? 1 : 2}`;
		// A few conversations run for weeks, over several segments.
		const turns = chance(0.02) ? between(20, 60) : between(1, 6);
		let [clock, seq, segment, segmentStart, segmentAt] = [opened, 0, 1, 0, opened];
		let lastRun: string | undefined;
		const at = () => new Date((clock += between(2, 20) * 1_000));
		type Message = Omit<Rows['coachMessages'][number], 'ownerId' | 'threadId' | 'seq' | 'segment'>;
		const message = ({ status, ...row }: Omit<Message, 'createdAt'>) =>
			d.coachMessages.push({
				id: id(),
				ownerId,
				threadId,
				seq: ++seq,
				segment,
				status: status ?? 'complete',
				createdAt: at(),
				...row
			});
		const preamble = () => {
			[segmentStart, segmentAt] = [seq, clock];
			const content = `<memory>${prose(40, 'what the coach knows')}</memory>`;
			message({ role: 'user', kind: 'segment_preamble', apiVisible: true, content });
		};
		preamble();
		for (let turn = 0; turn < turns; turn++) {
			if (seq - segmentStart >= SEGMENT.messages) {
				d.coachNotes.push({
					id: id(),
					ownerId,
					kind: 'thread_summary',
					subjects: [{ type: 'date', id: new Date(clock).toISOString().slice(0, 10) }],
					body: { summary: prose(4, 'the conversation so far') },
					summary: prose(2, 'the conversation so far'),
					runId: lastRun,
					createdAt: new Date(clock)
				});
				segment++;
				preamble();
			}
			const gap = chance(0.15) ? between(1, 6) * DAY : between(2, 40) * MINUTE;
			if (turn && clock + gap > end) break;
			if (turn) clock += gap;
			const asked = id();
			const text = `Question ${turn + 1}: ${prose(2, 'my training')}`;
			message({
				id: asked,
				role: 'user',
				kind: 'owner_message',
				apiVisible: true,
				content: text,
				display: { text },
				clientMessageId: id()
			});
			const runId = id();
			const startedAt = new Date(clock);
			const rounds = rng.int(3);
			const proposes = rounds > 0 && chance(0.06);
			const totals = { costMicros: 0, ...ZERO_USAGE };
			let toolCalls = 0;
			for (let call = 0; call <= rounds; call++) {
				const usage = {
					inputTokens: between(800, 4_000),
					outputTokens: between(150, 1_500),
					cacheReadTokens: between(0, 50_000),
					cacheWriteTokens: between(0, 6_000)
				};
				const { inputTokens: i, outputTokens: o, cacheReadTokens: r, cacheWriteTokens: w } = usage;
				const costMicros = i * 4 + o * 20 + Math.round(r / 5) + w * 5;
				for (const key of USAGE) totals[key] += usage[key];
				totals.costMicros += costMicros;
				d.agentModelCalls.push({
					id: id(),
					ownerId,
					runId,
					callIndex: call,
					requestId: `req_${hex()}`,
					model: MODEL,
					stopReason: call < rounds ? 'tool_use' : 'end_turn',
					...usage,
					costMicros,
					capCostMicros: costMicros,
					ttftMs: between(400, 2_500),
					latencyMs: between(1_500, 12_000),
					createdAt: at()
				});
				if (call === rounds) break;
				const blocks = Array.from({ length: chance(0.3) ? 2 : 1 }, (_, b) => {
					const proposal = proposes && call === rounds - 1 && b === 0;
					const name = rng.pick(proposal ? PROPOSING_TOOLS : READ_TOOLS);
					return { id: `toolu_${hex()}${hex()}`, name, proposal, input: { weeks: 4 } };
				});
				const uses = blocks.map((b) => ({
					type: 'tool_use',
					id: b.id,
					name: b.name,
					input: b.input
				}));
				const content = [{ type: 'text', text: 'Let me look at that.' }, ...uses];
				message({ role: 'assistant', kind: 'assistant', apiVisible: true, runId, content });
				for (const b of blocks) {
					toolCalls++;
					d.agentToolCalls.push({
						id: id(),
						ownerId,
						runId,
						callIndex: call,
						toolUseId: b.id,
						name: b.name,
						status: chance(0.97) ? 'succeeded' : 'failed',
						input: b.input,
						output: { rows: prose(8, b.name) },
						proposalId: b.proposal ? propose(threadId, runId, b.id, new Date(clock)) : null,
						startedAt: new Date(clock),
						durationMs: between(20, 900),
						createdAt: at()
					});
				}
				const results = blocks.map((b) => ({
					type: 'tool_result',
					tool_use_id: b.id,
					content: prose(10, b.name)
				}));
				message({ role: 'user', kind: 'tool_results', apiVisible: true, runId, content: results });
			}
			const stopped = chance(0.03);
			const answer = prose(between(4, 12), 'your question');
			// A stopped answer is shown but never replayed.
			message({
				role: 'assistant',
				kind: stopped ? 'display_only' : 'assistant',
				apiVisible: !stopped,
				status: stopped ? 'stopped' : undefined,
				runId,
				content: [{ type: 'text', text: answer }],
				display: { blocks: [{ kind: 'fact', text: answer }] }
			});
			d.agentRuns.push({
				id: runId,
				ownerId,
				threadId,
				triggerMessageId: asked,
				kind: 'turn',
				provider: 'anthropic',
				model: MODEL,
				servedModel: MODEL,
				effort: 'high',
				promptVersion,
				status: stopped ? 'cancelled' : 'completed',
				stopReason: stopped ? null : 'end_turn',
				modelCalls: rounds + 1,
				toolCalls,
				...totals,
				capCostMicros: totals.costMicros,
				ttftMs: between(400, 2_500),
				latencyMs: clock - +startedAt,
				cancelRequestedAt: stopped ? new Date(clock) : null,
				startedAt,
				finishedAt: new Date(clock)
			});
			lastRun = runId;
		}
		d.coachThreads.push({
			id: threadId,
			ownerId,
			title: `About my training, part ${i + 1}`,
			titleSource: chance(0.1) ? 'owner' : 'first_message',
			entry: chance(0.4) ? { from: 'workout', ref: workoutRef(rng.pick(workouts)) } : null,
			segment,
			segmentPromptVersion: promptVersion,
			segmentProgramVersionId: versionAt(segmentAt),
			createdAt: new Date(opened),
			lastMessageAt: new Date(clock)
		});
	}
	// Archived: conversations quiet for OPEN_DAYS, archived a day to a month later.
	const quiet = d.coachThreads.filter((row) => +row.lastMessageAt! < end - OPEN_DAYS * DAY);
	for (const row of rng.shuffle(quiet).slice(0, COACH_VOLUMES.archivedThreads)) {
		row.archivedAt = new Date(Math.min(end, +row.lastMessageAt! + between(1, 30) * DAY));
	}

	for (const w of workouts.filter(() => chance(0.6))) {
		d.coachNotes.push({
			id: id(),
			ownerId,
			kind: 'workout_analysis',
			subjects: [workoutRef(w)],
			body: { verdict: prose(3, 'the workout') },
			summary: prose(2, 'the workout'),
			createdAt: new Date(+w.finishedAt! + 30 * MINUTE)
		});
	}
	const sets = Map.groupBy(base.setRecords, (s) => s.workoutId);
	for (let i = 0; i < COACH_VOLUMES.painReports; i++) {
		const w = rng.pick(workouts);
		const set = sets.has(w.id!) ? rng.pick(sets.get(w.id!)!) : null;
		const action = rng.pick(PAIN_ACTIONS);
		const reportId = id();
		d.painReports.push({
			id: reportId,
			ownerId,
			workoutId: w.id!,
			exerciseId: set?.exerciseId,
			exercisePosition: set?.exercisePosition ?? 1,
			bodyArea: rng.pick(BODY_AREAS),
			severity: rng.pick(SEVERITIES),
			action,
			substitutionClientId: action === 'substituted' ? id() : null,
			note: chance(0.6) ? prose(between(1, 3), 'where it hurt') : null,
			reportedAt: new Date(+w.startedAt! + between(5, 80) * MINUTE)
		});
		if (chance(0.03)) d.deletedPainReports.push(reportId);
	}
	return d;
}

/** Loads the coach dataset after loadDataset, in one transaction, then analyses the database. */
export async function loadCoachDataset(client: pg.ClientBase, d: CoachDataset): Promise<void> {
	const catalogue = await client.query<{ key: string; id: string }>(
		'select key, id from exercises where key is not null'
	);
	const ids = new Map(catalogue.rows.map((row) => [row.key, row.id]));
	const resolve = (row: Record<string, unknown>) =>
		typeof row.exerciseId === 'string' ? { ...row, exerciseId: ids.get(row.exerciseId) } : row;
	await client.query('begin');
	try {
		for (const [name, table] of Object.entries(TABLES)) {
			const rows = d[name as keyof Rows] as Record<string, unknown>[];
			await insertAll(client, table, rows.map(resolve));
		}
		await client.query(
			`update coach_proposals p set status = e.status, closed_at = e."closedAt",
			   applied_version_id = e."appliedVersionId", applied_ref = e."appliedRef",
			   decision_note = e."decisionNote", superseded_reason = e."supersededReason"
			 from jsonb_to_recordset($1::jsonb) e(id uuid, status text, "closedAt" timestamptz,
			   "appliedVersionId" uuid, "appliedRef" jsonb, "decisionNote" text, "supersededReason" text)
			 where p.id = e.id`,
			[JSON.stringify(d.decisions)]
		);
		await client.query(
			`update pain_reports set deleted_at = reported_at + interval '1 day' where id = any($1::uuid[])`,
			[d.deletedPainReports]
		);
		await client.query('commit');
	} catch (err) {
		await client.query('rollback');
		throw err;
	}
	await client.query('analyze');
}
