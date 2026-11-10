/**
 * The analytics owner of db:explain is as large as the M6 plan asks, deterministic, and holds the
 * rows that make M6's joins real: sets linked to their prescriptions, workouts never completed
 * with live sets, a soft-deleted workout whose sets are live, and inserts only, all for the one
 * owner it is loaded for.
 */
import { describe, expect, it } from 'vitest';
import { generateDataset } from './dataset';
import { ANALYTICS_SEED, generateAnalyticsDataset } from './analytics-dataset';

const OWNER = generateDataset().owner.id!;
const data = generateAnalyticsDataset(OWNER);

describe('the analytics explain dataset', { timeout: 30_000 }, () => {
	it('is the same for the same seed, other rows than the M3 dataset, all of them the given owner’s', () => {
		const again = generateAnalyticsDataset(OWNER, ANALYTICS_SEED);
		expect(again.workouts.slice(0, 5)).toEqual(data.workouts.slice(0, 5));
		expect(again.recoveryNotes.length).toBe(data.recoveryNotes.length);
		expect(data.workouts[0]!.clientId).not.toBe(generateDataset().workouts[0]!.clientId);
		expect(data.owner.id).toBe(OWNER);
		const owned = [
			data.programs,
			data.workouts,
			data.setRecords,
			data.runRecords,
			data.recoveryNotes
		];
		for (const rows of owned)
			expect(new Set(rows.map((row) => row.ownerId))).toEqual(new Set([OWNER]));
	});

	it('logs ≥ 600 strength workouts with ≥ 15k sets, ≥ 400 runs with ≥ 6k segments', () => {
		expect(data.workouts.filter((w) => w.kind === 'strength').length).toBeGreaterThanOrEqual(600);
		expect(data.setRecords.length).toBeGreaterThanOrEqual(15_000);
		expect(data.runRecords.length).toBeGreaterThanOrEqual(400);
		expect(data.runRecordSegments.length).toBeGreaterThanOrEqual(6_000);
	});

	it('holds about 150 Muay Thai classes with rounds, and about 730 recovery notes', () => {
		const classes = data.workouts.filter((w) => w.discipline === 'muay_thai');
		expect(classes.length).toBeGreaterThanOrEqual(140);
		expect(classes.length).toBeLessThanOrEqual(160);
		const records = data.otherSessionRecords.filter((o) => o.kind === 'class');
		expect(records.length).toBe(classes.length);
		for (const record of records) {
			expect(record.metrics).toEqual([
				{ key: 'rounds', label: 'Rounds', unit: null, value: expect.any(Number) }
			]);
		}
		expect(data.recoveryNotes.length).toBeGreaterThanOrEqual(700);
		expect(data.recoveryNotes.length).toBeLessThanOrEqual(742);
		expect(new Set(data.recoveryNotes.map((n) => n.notedOn)).size).toBe(data.recoveryNotes.length);
	});

	it('plans about 100 weeks with prescriptions, the generated versions storing their input', () => {
		expect(data.programWeeks.length).toBeGreaterThanOrEqual(100);
		expect(data.setPrescriptions.length).toBeGreaterThan(1_000);
		for (const week of data.programWeeks) {
			expect(week.targets).toMatchObject({ volumeFactor: week.kind === 'deload' ? 0.6 : 1 });
		}
		const generated = data.programVersions.filter((v) => v.generator);
		expect(generated.length).toBe(data.programs.length);
		for (const version of data.programVersions) {
			expect(version.inputSnapshot != null).toBe(version.generator != null);
		}
	});

	it('links ≥ 80 % of sets to a planned exercise of their workout’s planned session', () => {
		const sessionOf = new Map(data.workouts.map((w) => [w.id, w.plannedSessionId]));
		const lines = new Set(data.plannedExercises.map((e) => `${e.sessionId}/${e.lineageId}`));
		const prescribed = new Set(data.setPrescriptions.map((line) => line.plannedExerciseId));
		const exerciseOf = new Map(
			data.plannedExercises.map((e) => [`${e.sessionId}/${e.lineageId}`, e.id])
		);
		const linked = data.setRecords.filter((set) => {
			const key = `${sessionOf.get(set.workoutId)}/${set.plannedExerciseLineageId}`;
			return lines.has(key) && prescribed.has(exerciseOf.get(key)!);
		});
		expect(linked.length / data.setRecords.length).toBeGreaterThanOrEqual(0.8);
	});

	it('leaves about 3 % of workouts abandoned or in progress, their sets live', () => {
		const open = data.workouts.filter((w) => w.status !== 'completed');
		const share = open.length / data.workouts.length;
		expect(share).toBeGreaterThan(0.015);
		expect(share).toBeLessThan(0.045);
		expect(open.some((w) => w.status === 'abandoned')).toBe(true);
		const inProgress = open.filter((w) => w.status === 'in_progress');
		expect(inProgress.length).toBeGreaterThan(0);
		for (const w of inProgress) expect(w.finishedAt).toBeNull();
		const ids = new Set(open.map((w) => w.id));
		const live = data.setRecords.filter((s) => ids.has(s.workoutId) && s.deletedAt === null);
		expect(live.length).toBeGreaterThan(100);
	});

	it('writes edits into the rows, keeps a deleted workout’s sets live, and leaves no UPDATE', () => {
		expect(data.edits).toEqual({ sets: [], deletedSets: [], deletedWorkouts: [] });
		const deleted = new Set(data.workouts.filter((w) => w.deletedAt).map((w) => w.id));
		expect(deleted.size).toBeGreaterThan(0);
		expect(data.setRecords.some((s) => deleted.has(s.workoutId) && s.deletedAt === null)).toBe(
			true
		);
		expect(data.setRecords.some((s) => s.deletedAt !== null)).toBe(true);
		const m3 = generateDataset(ANALYTICS_SEED);
		const edit = m3.edits.sets[0]!;
		const set = data.setRecords.find((s) => s.clientMutationId === edit.clientMutationId)!;
		expect(set.weight).toBe(edit.weight);
		expect(set.e1rmKg).toBe(edit.e1rmKg);
	});
});
