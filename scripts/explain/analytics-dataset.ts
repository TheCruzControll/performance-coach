/**
 * The analytics owner of db:explain (m6-plan 'analytics-plans'): a second owner as large as
 * dataset.ts's, loaded into the same reset database, so M6's fact queries are explained on two
 * years of data that really exercise their joins.
 * - It is dataset.ts's generator on its own seed (the same PRNG, weeks, programs and catalogue),
 *   so ≥ 600 strength workouts, ≥ 15k sets, ≥ 400 runs with ≥ 6k segments and about 100 weeks
 *   of program versions with prescriptions, nearly every set linked to its planned exercise.
 * - On top: NOT_COMPLETED of the workouts abandoned or still in progress with their sets live (so
 *   the completed-workout join is real), a second Muay Thai class every other week (about 150,
 *   with rounds), a recovery note nearly every day (about 730), and the generator's input stored
 *   on each program's first version (targets.ts reads it).
 * - The owner's corrections and soft deletes are written into the rows, and a soft-deleted workout
 *   keeps its sets live: the loader only inserts, so no training_audit rows are written.
 * - The app allows one owner (owners_singleton_uq), and the size gate is set for one owner's
 *   history. So the loader replaces dataset.ts's training and program rows (TRUNCATE, the reset
 *   code's one bypass of the history guards) with these, under the same owner, then analyses: the
 *   relations hold one owner's two years, as production would.
 */
import { addDays, type IsoDate } from '../../src/lib/domain/calendar';
import { LIFTS } from '../../src/lib/domain/profile/catalog';
import type { ProgrammingInput } from '../../src/lib/domain/programming/input';
import { seededRandom } from '../../src/lib/domain/programming/random';
import { GYM_PRESETS } from '../../src/lib/domain/programming/rules/defaults';
import type pg from 'pg';
import { FIRST_MONDAY, generateDataset, loadDataset, WEEKS, type Dataset } from './dataset';

/** The first of its seeds whose missed sessions leave ≥ 400 runs (407). */
export const ANALYTICS_SEED = 'db-explain/analytics/3';
/** The share of workouts never completed: two in three abandoned, the rest still in progress. */
export const NOT_COMPLETED = 0.03;
/** The share of days without a recovery note. */
const NO_NOTE = 0.015;
const DAY_MS = 86_400_000;

/** What the owner's programs were generated from: a hybrid athlete with one strength goal. */
const INPUT = {
	goals: [
		{
			...{ kind: 'general', title: 'Get stronger', disciplines: ['strength'] },
			...{ customDiscipline: null, eventType: null, eventDate: null, focus: null },
			...{ targetDate: null, priority: 1 }
		}
	],
	paused: [],
	maintenance: false,
	disciplines: ['strength', 'running', 'muay_thai'],
	experience: { strength: 'intermediate', running: 'intermediate', muay_thai: 'intermediate' },
	daysPerWeek: 6,
	availableDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
	preferredTimes: ['morning', 'evening'],
	sessionMinutes: 70,
	commitments: [],
	equipment: [...GYM_PRESETS.commercial],
	injuries: [],
	likes: [],
	dislikes: [],
	customExercises: [],
	baselines: Object.fromEntries(
		LIFTS.filter((lift) => lift !== 'custom').map((lift) => [lift, null])
	) as ProgrammingInput['baselines'],
	running: null,
	muayThai: null,
	nutritionPhase: null,
	bodyWeightKg: 80,
	assumptions: [],
	refs: { goals: [], paused: [], commitments: [] }
} satisfies ProgrammingInput;

/** Each week's stored targets (a deload's volume is 0.6), as a build stores them. */
const targetsOf = (kind: string | undefined) => ({
	...{ rpeCap: kind === 'deload' ? 7 : 9, volumeFactor: kind === 'deload' ? 0.6 : 1 },
	...{ loadStep: kind === 'deload' ? 0 : 0.025, runVolumeFactor: kind === 'deload' ? 0.7 : 1 }
});

/** The analytics history of `ownerId` (the one owner of the database it is loaded into). */
export function generateAnalyticsDataset(ownerId: string, seed: string = ANALYTICS_SEED): Dataset {
	const d = generateDataset(seed);
	const rng = seededRandom(`${seed}/analytics`);
	const hex = () =>
		Math.floor(rng.next() * 2 ** 32)
			.toString(16)
			.padStart(8, '0');
	const id = () => {
		const h = hex() + hex() + hex() + hex();
		return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20)}`;
	};
	const generated = d.owner.id!;
	for (const rows of Object.values(d))
		if (Array.isArray(rows))
			for (const row of rows as { ownerId?: string }[])
				if (row.ownerId === generated) row.ownerId = ownerId;
	d.owner = { ...d.owner, id: ownerId };

	// The edits as stored rows: a correction's weight, a soft-deleted set, a soft-deleted workout
	// whose sets stay live.
	const corrected = new Map(d.edits.sets.map((edit) => [edit.clientMutationId, edit]));
	const deletedSets = new Set(d.edits.deletedSets);
	const deletedWorkouts = new Set(d.edits.deletedWorkouts);
	d.setRecords = d.setRecords.map((set) => {
		const edit = corrected.get(set.clientMutationId);
		const deletedAt = deletedSets.has(set.clientMutationId)
			? new Date(set.performedAt!.getTime() + DAY_MS)
			: null;
		return { ...set, ...(edit && { weight: edit.weight, e1rmKg: edit.e1rmKg }), deletedAt };
	});
	d.edits = { sets: [], deletedSets: [], deletedWorkouts: [] };

	const extra = {
		workouts: [] as Dataset['workouts'],
		others: [] as Dataset['otherSessionRecords']
	};
	for (let w = 0; w < WEEKS; w += 2) {
		const workoutId = id();
		const startedAt = new Date(Date.parse(`${addDays(FIRST_MONDAY, w * 7 + 5)}T17:00:00Z`));
		extra.workouts.push({
			...{ id: workoutId, ownerId, clientId: id(), kind: 'other', discipline: 'muay_thai' },
			...{ sessionType: 'muay_thai', title: 'muay thai', status: 'completed', startedAt },
			...{ finishedAt: new Date(startedAt.getTime() + 5_700_000), durationSeconds: 5_700 },
			sessionRpe: 8
		});
		extra.others.push({ workoutId, ownerId, kind: 'class', durationMinutes: 90, rpe: 8 });
	}
	d.workouts = [...d.workouts, ...extra.workouts].map((workout) => {
		const deletedAt = deletedWorkouts.has(workout.clientId)
			? new Date(workout.startedAt!.getTime() + DAY_MS)
			: null;
		const roll = rng.next();
		if (roll >= NOT_COMPLETED) return { ...workout, deletedAt };
		return roll < (NOT_COMPLETED * 2) / 3
			? { ...workout, deletedAt, status: 'abandoned' }
			: { ...workout, deletedAt, status: 'in_progress', finishedAt: null, durationSeconds: null };
	});
	const rounds = (kind: string) =>
		kind === 'class' ? [{ key: 'rounds', label: 'Rounds', unit: null, value: 5 + rng.int(6) }] : [];
	d.otherSessionRecords = [...d.otherSessionRecords, ...extra.others].map((other) => ({
		...other,
		metrics: rounds(other.kind)
	}));

	const noted = new Set<IsoDate>(d.recoveryNotes.map((note) => note.notedOn));
	for (let day = 0; day < WEEKS * 7; day++) {
		const notedOn = addDays(FIRST_MONDAY, day);
		if (noted.has(notedOn) || rng.next() < NO_NOTE) continue;
		d.recoveryNotes.push({
			...{ ownerId, clientMutationId: id(), notedOn, sleepHours: 6 + 0.5 * rng.int(6) },
			...{ soreness: 1 + rng.int(5), energy: 1 + rng.int(5), stress: 1 + rng.int(5), note: null }
		});
	}

	d.programWeeks = d.programWeeks.map((week) => ({ ...week, targets: targetsOf(week.kind) }));
	d.programVersions = d.programVersions.map((version) =>
		version.generator ? { ...version, inputSnapshot: INPUT } : version
	);
	return d;
}

/** Truncates the owner's training and program rows, inserts the analytics history, analyses. */
export async function loadAnalyticsDataset(client: pg.ClientBase, d: Dataset): Promise<void> {
	await client.query('truncate programs, workouts, recovery_notes cascade');
	await loadDataset(client, d, { owner: false });
}
