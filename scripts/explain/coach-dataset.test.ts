/**
 * The db:explain coach dataset is deterministic, as large as the plan asks (2,000 pain reports,
 * 500 archived conversations) and shaped as the app writes it: transcripts the model could replay,
 * runs and tool calls that name them, and proposals decided only as the guards allow.
 */
import { describe, expect, it } from 'vitest';
import { SEGMENT } from '../../src/lib/domain/coach/budgets';
import {
	COACH_DATASET_SEED,
	COACH_LAST_DAY,
	COACH_VOLUMES,
	generateCoachDataset,
	OPEN_DAYS,
	type CoachDataset
} from './coach-dataset';
import { FIRST_MONDAY, generateDataset } from './dataset';

const base = generateDataset();
const data = generateCoachDataset(base);

const TABLES = [
	'coachThreads',
	'coachMessages',
	'agentRuns',
	'agentModelCalls',
	'coachProposals',
	'agentToolCalls',
	'coachNotes',
	'painReports'
] as const;
const counts = (d: CoachDataset) => Object.fromEntries(TABLES.map((t) => [t, d[t].length]));
const byThread = Map.groupBy(data.coachMessages, (m) => m.threadId);
const time = (value: Date | undefined | null) => (value ? value.getTime() : NaN);
const START = Date.parse(`${FIRST_MONDAY}T00:00:00Z`);
const END = Date.parse(`${COACH_LAST_DAY}T23:59:59Z`);

// Generating both datasets takes a second or two, more on a busy machine.
describe('the explain coach dataset', { timeout: 30_000 }, () => {
	it('gives the same rows for the same seed, and other rows for another', () => {
		const again = generateCoachDataset(base, COACH_DATASET_SEED);
		expect(counts(again)).toEqual(counts(data));
		for (const table of TABLES) expect(again[table].slice(0, 3)).toEqual(data[table].slice(0, 3));
		expect(again.decisions).toEqual(data.decisions);
		expect(again.deletedPainReports).toEqual(data.deletedPainReports);
		const other = generateCoachDataset(base, 'another seed');
		expect(other.coachThreads[0]!.id).not.toBe(data.coachThreads[0]!.id);
		expect(other.painReports[0]!.id).not.toBe(data.painReports[0]!.id);
	});

	it('holds the planned volumes: conversations, archived ones and pain reports', () => {
		expect(data.coachThreads).toHaveLength(COACH_VOLUMES.threads);
		expect(COACH_VOLUMES).toMatchObject({ archivedThreads: 500, painReports: 2_000 });
		const archived = data.coachThreads.filter((t) => t.archivedAt);
		expect(archived).toHaveLength(COACH_VOLUMES.archivedThreads);
		for (const t of archived) expect(time(t.archivedAt)).toBeGreaterThan(time(t.lastMessageAt));
		expect(data.painReports).toHaveLength(COACH_VOLUMES.painReports);
		expect(data.deletedPainReports.length).toBeGreaterThan(0);
		expect(data.coachMessages.length).toBeGreaterThan(20_000);
		expect(data.agentRuns.length).toBeGreaterThan(5_000);
		expect(data.agentToolCalls.length).toBeGreaterThan(5_000);
		expect(data.coachProposals.length).toBeGreaterThan(200);
		expect(data.coachNotes.length).toBeGreaterThan(500);
	});

	it('spans the training dataset, newest conversation last, never after its last day', () => {
		const opened = data.coachThreads.map((t) => time(t.createdAt));
		expect(opened).toEqual([...opened].sort((a, b) => a - b));
		expect(opened[0]! - START).toBeLessThan(7 * 86_400_000);
		expect(END - opened.at(-1)!).toBeLessThan(7 * 86_400_000);
		const instants = [
			...data.coachMessages.map((m) => time(m.createdAt)),
			...data.agentRuns.map((r) => time(r.finishedAt)),
			...data.painReports.map((p) => time(p.reportedAt)),
			...data.decisions.map((x) => time(x.closedAt))
		];
		expect(instants.every((at) => at >= START && at <= END)).toBe(true);
	});

	it('stores transcripts the model could replay: gapless seqs, a preamble opening each segment', () => {
		for (const thread of data.coachThreads) {
			const rows = byThread.get(thread.id!)!;
			expect(rows.map((m) => m.seq)).toEqual(rows.map((_, i) => i + 1));
			const segments = Map.groupBy(rows, (m) => m.segment!);
			expect([...segments.keys()]).toEqual(
				Array.from({ length: thread.segment! }, (_, i) => i + 1)
			);
			for (const segment of segments.values()) {
				expect(segment[0]!.kind).toBe('segment_preamble');
			}
			expect(time(thread.lastMessageAt)).toBeGreaterThanOrEqual(time(rows.at(-1)!.createdAt));
		}
		// Some conversations run past a segment, so a thread's display page spans many rows.
		const long = data.coachThreads.filter((t) => t.segment! > 1);
		expect(long.length).toBeGreaterThan(10);
		expect(Math.max(...[...byThread.values()].map((r) => r.length))).toBeGreaterThan(
			2 * SEGMENT.messages
		);
	});

	it('runs a turn per owner message, its calls and tool calls named by the transcript', () => {
		const messages = new Map(data.coachMessages.map((m) => [m.id!, m]));
		const owners = data.coachMessages.filter((m) => m.kind === 'owner_message');
		expect(data.agentRuns).toHaveLength(owners.length);
		const uses = new Set(
			data.coachMessages.flatMap((m) =>
				Array.isArray(m.content)
					? m.content.filter((b) => b.type === 'tool_use').map((b) => `${m.runId} ${b.id}`)
					: []
			)
		);
		const calls = Map.groupBy(data.agentModelCalls, (c) => c.runId);
		for (const run of data.agentRuns) {
			const trigger = messages.get(run.triggerMessageId)!;
			expect(trigger).toMatchObject({ kind: 'owner_message', threadId: run.threadId });
			expect(calls.get(run.id!)!.map((c) => c.callIndex)).toEqual(
				Array.from({ length: run.modelCalls! }, (_, i) => i)
			);
			expect(run.finishedAt).toBeTruthy();
		}
		for (const call of data.agentToolCalls) {
			expect(uses.has(`${call.runId} ${call.toolUseId}`), call.toolUseId).toBe(true);
		}
	});

	it('decides proposals only as the guards allow, and leaves the last fortnight open', () => {
		const decided = new Map(data.decisions.map((x) => [x.id, x]));
		const toolCalls = new Map(data.agentToolCalls.map((c) => [c.proposalId, c]));
		const cutoff = END - OPEN_DAYS * 86_400_000;
		for (const p of data.coachProposals) {
			expect(p.status ?? 'proposed').toBe('proposed');
			expect(toolCalls.get(p.id!)).toMatchObject({ runId: p.runId, toolUseId: p.toolUseId });
			const decision = decided.get(p.id!);
			expect(decision === undefined, p.id).toBe(time(p.createdAt) > cutoff);
			if (!decision) continue;
			expect(time(decision.closedAt)).toBeGreaterThanOrEqual(time(p.createdAt));
			const applied = decision.status === 'applied';
			// coach_proposals_applied_ck and coach_proposals_superseded_ck.
			expect(applied).toBe(decision.appliedVersionId !== null || decision.appliedRef !== null);
			expect(decision.status === 'superseded').toBe(decision.supersededReason !== null);
			if (decision.appliedVersionId) expect(p.kind).toBe('program_adjustment');
		}
		const statuses = new Set(data.decisions.map((x) => x.status));
		expect([...statuses].sort()).toEqual(['applied', 'rejected', 'superseded']);
		expect(data.coachProposals.length).toBeGreaterThan(data.decisions.length);
	});

	it('reports pain on live logged workouts, naming an exercise logged in them', () => {
		const deleted = new Set(base.edits.deletedWorkouts);
		const workouts = new Map(base.workouts.map((w) => [w.id!, w]));
		const logged = new Set(base.setRecords.map((s) => `${s.workoutId} ${s.exerciseId}`));
		for (const report of data.painReports) {
			const workout = workouts.get(report.workoutId)!;
			expect(deleted.has(workout.clientId)).toBe(false);
			if (report.exerciseId)
				expect(logged.has(`${report.workoutId} ${report.exerciseId}`)).toBe(true);
			expect(report.substitutionClientId != null).toBe(report.action === 'substituted');
		}
		expect(data.painReports.filter((r) => r.exerciseId).length).toBeGreaterThan(1_000);
	});
});
