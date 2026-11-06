/**
 * The db:explain dataset is deterministic and as large as the brief asks: one owner's two-plus
 * years of strength, runs and Muay Thai, and about a hundred weeks of programs whose versions
 * share their weeks copy-on-write (ADR 0010), as the app writes them.
 */
import { describe, expect, it } from 'vitest';
import { daysBetween } from '../../src/lib/domain/calendar';
import { DATASET_SEED, generateDataset, type Dataset } from './dataset';

const data = generateDataset();

/** The dataset's row lists, by name. */
type Table = {
	[K in keyof Dataset]: Dataset[K] extends readonly unknown[] ? K : never;
}[keyof Dataset];
const TABLES = (Object.keys(data) as (keyof Dataset)[]).filter((key): key is Table =>
	Array.isArray(data[key])
);

const counts = (dataset: Dataset) =>
	Object.fromEntries(TABLES.map((table) => [table, dataset[table].length]));
const firstRows = (dataset: Dataset) =>
	Object.fromEntries(TABLES.map((table) => [table, dataset[table].slice(0, 3)]));

const isoDay = (instant: Date) => instant.toISOString().slice(0, 10);

// Generating it takes about a second, more on a busy machine.
describe('the explain dataset', { timeout: 20_000 }, () => {
	it('gives the same counts and first rows for the same seed, and other rows for another', () => {
		const again = generateDataset(DATASET_SEED);
		expect(TABLES.length).toBeGreaterThanOrEqual(17);
		expect(counts(again)).toEqual(counts(data));
		expect(firstRows(again)).toEqual(firstRows(data));
		expect(again.edits).toEqual(data.edits);
		const other = generateDataset('another seed');
		expect(other.workouts[0]!.clientId).not.toBe(data.workouts[0]!.clientId);
		expect(other.setRecords[0]!.clientMutationId).not.toBe(data.setRecords[0]!.clientMutationId);
	});

	it('logs ≥ 600 strength workouts with ≥ 15k sets over about 40 exercises', () => {
		const strength = data.workouts.filter((w) => w.kind === 'strength');
		expect(strength.length).toBeGreaterThanOrEqual(600);
		expect(data.setRecords.length).toBeGreaterThanOrEqual(15_000);
		const exercises = new Set(data.setRecords.map((set) => set.exerciseId));
		expect(exercises.size).toBeGreaterThanOrEqual(35);
		expect(exercises.size).toBeLessThanOrEqual(45);
		// Warm-ups, RPEs given and left out, skipped and extra sets, missed reps.
		const share = (test: (set: Dataset['setRecords'][number]) => boolean) =>
			data.setRecords.filter(test).length / data.setRecords.length;
		expect(share((s) => s.isWarmup === true)).toBeGreaterThan(0.05);
		expect(share((s) => s.rpe != null)).toBeGreaterThan(0.5);
		expect(share((s) => s.rpe == null && !s.isWarmup)).toBeGreaterThan(0.05);
		expect(share((s) => s.isSkipped === true)).toBeGreaterThan(0);
		expect(share((s) => s.isExtra === true)).toBeGreaterThan(0);
		expect(share((s) => (s.missedReps ?? 0) > 0)).toBeGreaterThan(0);
		// Owner edits and soft deletes, which the loader applies as audited UPDATEs.
		expect(data.edits.sets.length).toBeGreaterThan(data.setRecords.length * 0.01);
		expect(data.edits.deletedSets.length).toBeGreaterThan(0);
		expect(data.edits.deletedWorkouts.length).toBeGreaterThan(0);
	});

	it('logs ≥ 400 runs with ≥ 6k segments, about 150 other sessions and recovery notes', () => {
		const runs = data.workouts.filter((w) => w.kind === 'run');
		expect(runs.length).toBeGreaterThanOrEqual(400);
		expect(data.runRecords).toHaveLength(runs.length);
		expect(data.runRecordSegments.length).toBeGreaterThanOrEqual(6_000);
		const other = data.workouts.filter((w) => w.kind === 'other');
		expect(other.length).toBeGreaterThanOrEqual(130);
		expect(other.length).toBeLessThanOrEqual(170);
		expect(other.some((w) => w.discipline === 'muay_thai')).toBe(true);
		expect(data.otherSessionRecords).toHaveLength(other.length);
		expect(data.recoveryNotes.length).toBeGreaterThan(300);
	});

	it('spans at least 730 days', () => {
		const days = data.workouts.map((w) => isoDay(w.startedAt as Date)).sort();
		expect(daysBetween(days[0]!, days.at(-1)!)).toBeGreaterThanOrEqual(730);
	});

	it('plans about 100 weeks in programs of several versions, one of them active', () => {
		expect(data.programs.filter((p) => p.status === 'active')).toHaveLength(1);
		const weekLineages = new Set(data.programWeeks.map((w) => w.lineageId));
		expect(weekLineages.size).toBeGreaterThanOrEqual(95);
		expect(weekLineages.size).toBeLessThanOrEqual(110);
		for (const program of data.programs) {
			const versions = data.programVersions.filter((v) => v.programId === program.id);
			expect(versions.length, program.title).toBeGreaterThanOrEqual(3);
		}
		// Enough versions for History to page: more than two pages of 20 on the active program.
		const active = data.programs.find((p) => p.status === 'active')!;
		expect(data.programVersions.filter((v) => v.programId === active.id).length).toBeGreaterThan(
			20
		);
		// Logged training names its planned sessions.
		const sessionIds = new Set(data.plannedSessions.map((s) => s.id));
		const planned = data.workouts.filter((w) => w.plannedSessionId);
		expect(planned.length).toBeGreaterThan(data.workouts.length * 0.9);
		expect(planned.every((w) => sessionIds.has(w.plannedSessionId!))).toBe(true);
	});

	it('shares weeks between versions copy-on-write: each revision copies exactly one week', () => {
		const weeks = new Map(data.programWeeks.map((w) => [w.id!, w]));
		const membership = (versionId: string) =>
			data.programVersionWeeks.filter((m) => m.versionId === versionId).map((m) => m.weekId);
		for (const program of data.programs) {
			const versions = data.programVersions
				.filter((v) => v.programId === program.id)
				.sort((a, b) => a.number - b.number);
			const lineages = (versionId: string) =>
				membership(versionId)
					.map((id) => weeks.get(id)!.lineageId)
					.sort();
			const all = lineages(versions[0]!.id!);
			expect(new Set(all).size).toBe(all.length);
			for (const [i, version] of versions.entries()) {
				expect(lineages(version.id!), `version ${version.number}`).toEqual(all);
				if (i === 0) continue;
				const parent = new Set(membership(versions[i - 1]!.id!));
				const fresh = membership(version.id!).filter((id) => !parent.has(id));
				expect(fresh, `version ${version.number} copies one week`).toHaveLength(1);
				expect(version.parentVersionId).toBe(versions[i - 1]!.id);
				// The copy's sessions are new rows with the lineages of the week it replaces.
				const copied = data.plannedSessions.filter((s) => s.weekId === fresh[0]);
				expect(copied.length).toBeGreaterThan(0);
				const decisions = data.programmingDecisions.filter((d) => d.versionId === version.id);
				expect(decisions).toHaveLength(1);
			}
		}
	});
});
