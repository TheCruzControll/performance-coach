/**
 * The db:explain dataset: one owner's two-plus years of hybrid training, generated from a seed
 * (domain/programming/random.ts: mulberry32, no clock, no Math.random), so every run explains the
 * same rows, and loaded with one unnest INSERT per table, as the app stores them.
 * - Every week follows WEEK: six strength sessions over 40 catalogue exercises (warm-ups, RPEs
 *   given or not, skipped and extra sets, missed reps), four runs logged by segment, a Muay Thai
 *   class and, every other week, mobility. A few sessions are missed.
 * - Two weeks off plan, then PROGRAMS programs of PROGRAM_WEEKS weeks back to back, the last one
 *   active. Each has several versions: a revision copies one week's rows (new ids, the same
 *   lineages) with one owner edit and one decision, and shares every other week (ADR 0010).
 *   Workouts name the session of the program's last version they were logged from.
 * - Rows name exercises by catalogue key in exerciseId; the loader resolves the keys to the
 *   seeded rows, applies the owner's edits and soft deletes as UPDATEs (so the audit triggers
 *   write training_audit), then runs ANALYZE.
 */
import { getTableColumns, getTableName } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type pg from 'pg';
import { addDays, daysBetween, type IsoDate } from '../../src/lib/domain/calendar';
import { seededRandom } from '../../src/lib/domain/programming/random';
import { setE1rm } from '../../src/lib/domain/training/metrics';
import type { DecisionKind, RunSegmentKind } from '../../src/lib/domain/training/vocabulary';
import * as t from '../../src/lib/server/db/schema';

export const DATASET_SEED = 'db-explain/1';
/** The Monday the dataset starts on and its length: 106 weeks, 742 days. */
export const FIRST_MONDAY: IsoDate = '2024-10-07';
export const WEEKS = 106;
const PROGRAMS = 8;
const PROGRAM_WEEKS = 13;
const BLOCKS = [
	[5, 'accumulation', 'accumulation'],
	[4, 'intensification', 'intensification'],
	[4, 'realization', 'peak']
] as const;
/** Versions of an archived program; the active one has more than two History pages of 20. */
const VERSIONS = [4, 8] as const;
const ACTIVE_VERSIONS = 26;
/** The share of planned sessions never logged. */
const MISSED = 0.03;

/** Each pool's main lifts come first (MAIN of them), then its accessories. */
const MAIN = 4;
const POOLS = {
	lower:
		'back_squat front_squat deadlift trap_bar_deadlift romanian_deadlift sumo_deadlift box_squat safety_bar_squat leg_press hack_squat bulgarian_split_squat reverse_lunge walking_lunge step_up hip_thrust good_morning lying_leg_curl seated_leg_curl leg_extension standing_calf_raise',
	upper:
		'bench_press overhead_press incline_bench_press close_grip_bench_press weighted_pull_up push_press dumbbell_bench_press incline_dumbbell_press barbell_row chest_supported_dumbbell_row single_arm_dumbbell_row seated_cable_row lat_pulldown face_pull dumbbell_lateral_raise barbell_curl hammer_curl triceps_pushdown skull_crusher dumbbell_fly'
} as const;

/** What each session type is planned and logged as. */
const SESSIONS = {
	strength: { kind: 'strength', discipline: 'strength', minutes: 70, rpe: 8 },
	hypertrophy: { kind: 'strength', discipline: 'strength', minutes: 70, rpe: 7.5 },
	power: { kind: 'strength', discipline: 'strength', minutes: 60, rpe: 7 },
	easy_run: { kind: 'run', discipline: 'running', minutes: 55, rpe: 4, segment: 'easy' },
	interval_run: { kind: 'run', discipline: 'running', minutes: 55, rpe: 8, segment: 'interval' },
	long_run: { kind: 'run', discipline: 'running', minutes: 110, rpe: 5, segment: 'long' },
	muay_thai: { kind: 'other', discipline: 'muay_thai', minutes: 90, rpe: 8, other: 'class' },
	mobility: { kind: 'other', discipline: 'athletic', minutes: 30, rpe: 3, other: 'mobility' }
} as const;
type SessionKey = keyof typeof SESSIONS;

/** The week: day (0 is Monday), order in the day, session type, strength split. */
const WEEK: [number, number, SessionKey, ('lower' | 'upper')?][] = [
	[0, 1, 'strength', 'lower'],
	[1, 1, 'strength', 'upper'],
	[1, 2, 'easy_run'],
	[2, 1, 'hypertrophy', 'lower'],
	[2, 2, 'muay_thai'],
	[3, 1, 'hypertrophy', 'upper'],
	[3, 2, 'interval_run'],
	[4, 1, 'power', 'lower'],
	[4, 2, 'mobility'],
	[5, 1, 'strength', 'upper'],
	[5, 2, 'easy_run'],
	[6, 1, 'long_run']
];

/** The dataset's tables, parents first: the order the loader inserts them in. */
const TABLES = {
	programs: t.programs,
	programVersions: t.programVersions,
	programBlocks: t.programBlocks,
	programVersionBlocks: t.programVersionBlocks,
	programWeeks: t.programWeeks,
	programVersionWeeks: t.programVersionWeeks,
	plannedSessions: t.plannedSessions,
	plannedExercises: t.plannedExercises,
	setPrescriptions: t.setPrescriptions,
	plannedRunSegments: t.plannedRunSegments,
	plannedSessionDetails: t.plannedSessionDetails,
	programmingDecisions: t.programmingDecisions,
	workouts: t.workouts,
	setRecords: t.setRecords,
	runRecords: t.runRecords,
	runRecordSegments: t.runRecordSegments,
	otherSessionRecords: t.otherSessionRecords,
	recoveryNotes: t.recoveryNotes
};
type Row<T extends PgTable> = T['$inferInsert'];
type Rows = { [K in keyof typeof TABLES]: Row<(typeof TABLES)[K]>[] };
/** One week of one version: what a revision copies. */
type WeekRows = Pick<
	Rows,
	| 'programWeeks'
	| 'plannedSessions'
	| 'plannedExercises'
	| 'setPrescriptions'
	| 'plannedRunSegments'
	| 'plannedSessionDetails'
>;

export interface Dataset extends Rows {
	owner: Row<typeof t.owners>;
	/** Each program's current version, pointed at once its versions exist. */
	heads: { programId: string; versionId: string }[];
	/** Applied after the inserts as audited UPDATEs: corrected weights and soft deletes. */
	edits: {
		sets: { clientMutationId: string; weight: number; e1rmKg: number | null }[];
		deletedSets: string[];
		deletedWorkouts: string[];
	};
}

/** The columns a copy gives new ids, its parents' included. */
const LINKS = new Set(['id', 'weekId', 'sessionId', 'plannedExerciseId']);
const at = (date: IsoDate, hours: number) =>
	new Date(Date.parse(`${date}T00:00:00Z`) + hours * 36e5);
const roundTo = (value: number, step: number) => Math.round(value / step) * step;
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

export function generateDataset(seed: string | number = DATASET_SEED): Dataset {
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
	const ownerId = id();
	const d: Dataset = {
		...(Object.fromEntries(Object.keys(TABLES).map((name) => [name, []])) as unknown as Rows),
		owner: { id: ownerId, displayName: 'Explain owner', webauthnUserId: `explain-${id()}` },
		heads: [],
		edits: { sets: [], deletedSets: [], deletedWorkouts: [] }
	};
	/** Each exercise's working weight in week 1; it climbs 0.4% a week. */
	const startKg = new Map(
		Object.values(POOLS).flatMap((pool) =>
			pool.split(' ').map((key, i) => [key, i < MAIN ? between(60, 120) : between(15, 60)] as const)
		)
	);
	const exercisesFor = (split: keyof typeof POOLS, main: number, shuffled: boolean) => {
		const pool = POOLS[split].split(' ');
		const accessories = pool.slice(MAIN);
		return [pool[main % MAIN]!, ...(shuffled ? rng.shuffle(accessories) : accessories).slice(0, 5)];
	};

	/** A week's planned sessions and their children; `keys` gives each strength slot's exercises. */
	function plannedWeek(weekId: string, monday: IsoDate, w: number, keys: string[][]): WeekRows {
		const rows: WeekRows = {
			programWeeks: [],
			plannedSessions: [],
			plannedExercises: [],
			setPrescriptions: [],
			plannedRunSegments: [],
			plannedSessionDetails: []
		};
		WEEK.forEach(([day, order, type], slot) => {
			if (type === 'mobility' && w % 2) return;
			const plan: (typeof SESSIONS)[SessionKey] = SESSIONS[type];
			const sessionId = id();
			rows.plannedSessions.push({
				id: sessionId,
				weekId,
				lineageId: id(),
				scheduledOn: addDays(monday, day),
				orderInDay: order,
				discipline: plan.discipline,
				sessionType: type,
				title: type.replace('_', ' '),
				estMinutes: plan.minutes,
				intensity: plan.rpe >= 8 ? 'hard' : 'moderate',
				targetRpe: plan.rpe,
				status: 'planned',
				source: 'rules'
			});
			keys[slot]?.forEach((exerciseId, i) => {
				const plannedExerciseId = id();
				rows.plannedExercises.push({
					id: plannedExerciseId,
					sessionId,
					lineageId: id(),
					position: i + 1,
					exerciseId
				});
				const [sets, repsMin, repsMax] = i === 0 ? [4, 3, 5] : [3, 8, 12];
				rows.setPrescriptions.push({
					id: id(),
					plannedExerciseId,
					position: 1,
					role: i ? 'working' : 'top',
					sets,
					repsMin,
					repsMax,
					targetRpe: 8,
					loadKind: 'rpe_based'
				});
			});
			if ('segment' in plan) {
				const repeats = plan.segment === 'interval' ? { repeatGroup: 1, repeats: 8 } : {};
				const distanceMetres = { easy: 10_000, interval: 800, long: 20_000 }[plan.segment];
				rows.plannedRunSegments.push({
					id: id(),
					sessionId,
					position: 1,
					kind: plan.segment,
					distanceMetres,
					...repeats
				});
			}
			if ('other' in plan) {
				rows.plannedSessionDetails.push({
					sessionId,
					kind: plan.other,
					durationMinutes: plan.minutes,
					targetRpe: plan.rpe
				});
			}
		});
		return rows;
	}

	/** A revision's copy of a week: every row again under a new id, with the same lineages. */
	function copyWeek(week: WeekRows): WeekRows {
		const fresh = new Map<string, string>();
		const swap = (old: string) => fresh.get(old) ?? fresh.set(old, id()).get(old)!;
		const clone = (row: object) =>
			Object.fromEntries(
				Object.entries(row).map(([k, v]) => [k, LINKS.has(k) ? swap(v as string) : v])
			);
		return Object.fromEntries(
			Object.entries(week).map(([table, rows]: [string, object[]]) => [table, rows.map(clone)])
		) as unknown as WeekRows;
	}

	/** Each planned week of the dataset, as its program's last version has it. */
	const planned = new Map<number, { programId: string; week: WeekRows }>();
	for (let p = 0; p < PROGRAMS; p++) {
		const first = 2 + p * PROGRAM_WEEKS;
		const startsOn = addDays(FIRST_MONDAY, first * 7);
		const active = p === PROGRAMS - 1;
		const programId = id();
		const end = at(addDays(startsOn, PROGRAM_WEEKS * 7), 8);
		d.programs.push({
			id: programId,
			ownerId,
			title: `Hybrid block ${p + 1}`,
			status: active ? 'active' : 'archived',
			archivedAt: active ? null : end,
			createdAt: at(startsOn, -30)
		});
		const keys = WEEK.map(([, , , split], slot) =>
			split ? exercisesFor(split, slot + p, true) : []
		);
		const blocks: string[] = [];
		const weeks: WeekRows[] = [];
		for (const [b, [count, phase, kind]] of BLOCKS.entries()) {
			const blockId = id();
			const blockStart = addDays(startsOn, weeks.length * 7);
			blocks.push(blockId);
			d.programBlocks.push({
				id: blockId,
				programId,
				lineageId: id(),
				position: b + 1,
				phase,
				name: phase,
				startsOn: blockStart,
				endsOn: addDays(blockStart, count * 7 - 1)
			});
			for (let i = 0; i < count; i++) {
				const monday = addDays(startsOn, weeks.length * 7);
				const weekId = id();
				const week = plannedWeek(weekId, monday, first + weeks.length, keys);
				const last = weeks.length === PROGRAM_WEEKS - 1;
				week.programWeeks.push({
					id: weekId,
					blockId,
					lineageId: id(),
					indexInBlock: i + 1,
					startsOn: monday,
					endsOn: addDays(monday, 6),
					kind: last ? 'deload' : kind
				});
				weeks.push(week);
			}
		}
		const versions = active ? ACTIVE_VERSIONS : between(...VERSIONS);
		const edited = Array.from({ length: versions - 1 }, () => rng.int(PROGRAM_WEEKS)).sort(
			(a, b) => a - b
		);
		const all = [...weeks];
		let current = weeks;
		let parentVersionId: string | null = null;
		for (let number = 1; number <= versions; number++) {
			const versionId = id();
			const decide = (kind: DecisionKind, summary: string, affected: string[], createdAt: Date) =>
				d.programmingDecisions.push({
					programId,
					versionId,
					kind,
					summary,
					why: number === 1 ? `The rules chose: ${summary}.` : 'You changed it. No reason given.',
					decidedBy: number === 1 ? 'rules' : 'owner',
					ruleKey: number === 1 ? `explain.${kind}` : null,
					affected,
					createdAt
				});
			const version = {
				id: versionId,
				programId,
				number,
				parentVersionId,
				startsOn,
				firstPlannedDay: startsOn
			};
			if (number === 1) {
				const createdAt = at(startsOn, -24);
				d.programVersions.push({
					...version,
					createdBy: 'rules',
					summary: 'Built from your profile',
					generator: 'perfo-programming/1',
					createdAt
				});
				const week1 = weeks[0]!.plannedSessions;
				for (const kind of [
					'program_purpose',
					'block_structure',
					'split_chosen',
					'run_volume'
				] as const) {
					decide(
						kind,
						kind.replace('_', ' '),
						week1.slice(0, 3).map((s) => s.lineageId!),
						createdAt
					);
				}
				for (const s of week1.filter(
					(s) => SESSIONS[s.sessionType as SessionKey].kind === 'strength'
				)) {
					decide('exercise_selected', `exercises for ${s.title}`, [s.lineageId!], createdAt);
				}
			} else {
				const w = edited[number - 2]!;
				const copy = copyWeek(current[w]!);
				const session = rng.pick(copy.plannedSessions);
				const exercises = copy.plannedExercises.filter((e) => e.sessionId === session.id);
				const lifts = new Set(exercises.map((e) => e.id));
				const edit = rng.pick(
					lifts.size
						? (['session_skipped', 'session_moved', 'prescription_adjusted'] as const)
						: (['session_skipped', 'session_moved'] as const)
				);
				const monday = copy.programWeeks[0]!.startsOn;
				if (edit === 'session_skipped') session.status = 'skipped';
				if (edit === 'session_moved') {
					const day = (daysBetween(monday, session.scheduledOn) + 1 + rng.int(6)) % 7;
					Object.assign(session, {
						status: 'moved',
						movedFrom: session.scheduledOn,
						scheduledOn: addDays(monday, day)
					});
				}
				if (edit === 'prescription_adjusted') {
					copy.setPrescriptions = copy.setPrescriptions.map((line) =>
						lifts.has(line.plannedExerciseId) ? { ...line, targetRpe: 7.5 } : line
					);
				}
				const createdAt = at(addDays(monday, -1), 19 + number / 60);
				const summary = `${edit.replace('_', ' ')}: ${session.title}`;
				d.programVersions.push({ ...version, createdBy: 'owner', summary, createdAt });
				// An adjusted prescription names its exercises too, as a swap does.
				const named = edit === 'prescription_adjusted' ? exercises.map((e) => e.lineageId!) : [];
				decide(edit, summary, [session.lineageId!, ...named], createdAt);
				current = current.map((week, i) => (i === w ? copy : week));
				all.push(copy);
			}
			d.programVersionBlocks.push(...blocks.map((blockId) => ({ versionId, blockId })));
			d.programVersionWeeks.push(
				...current.map((week) => ({ versionId, weekId: week.programWeeks[0]!.id! }))
			);
			parentVersionId = versionId;
		}
		d.heads.push({ programId, versionId: parentVersionId! });
		for (const week of all)
			for (const [table, rows] of Object.entries(week))
				(d[table as keyof WeekRows] as object[]).push(...rows);
		current.forEach((week, i) => planned.set(first + i, { programId, week }));
	}

	const offPlan = WEEK.map(([, , , split], slot) =>
		split ? exercisesFor(split, slot, false) : []
	);
	for (let w = 0; w < WEEKS; w++) {
		const monday = addDays(FIRST_MONDAY, w * 7);
		const { programId = null, week } = planned.get(w) ?? {
			week: plannedWeek('', monday, w, offPlan)
		};
		for (const session of week.plannedSessions) {
			if (session.status === 'skipped' || chance(MISSED)) continue;
			const plan: (typeof SESSIONS)[SessionKey] = SESSIONS[session.sessionType as SessionKey];
			const workoutId = id();
			const startedAt = new Date(
				at(session.scheduledOn, session.orderInDay === 1 ? 6.5 : 17.5).getTime() +
					rng.int(3600) * 1000
			);
			let seconds = 0;
			if (plan.kind === 'strength') {
				let n = 0;
				for (const [i, e] of week.plannedExercises
					.filter((e) => e.sessionId === session.id)
					.entries()) {
					const kg = roundTo(startKg.get(e.exerciseId)! * (1 + 0.004 * w), 2.5);
					const working = between(i === 0 ? 4 : 3, 5);
					const sets = [
						...(i === 0 ? [0.5, 0.7] : []).map((f) => ({
							weight: roundTo(kg * f, 2.5),
							reps: 5,
							warmup: true
						})),
						...Array.from({ length: working }, () => ({
							weight: kg,
							reps: i === 0 ? between(3, 5) : between(8, 12),
							warmup: false
						}))
					];
					sets.forEach((s, k) => {
						const skipped = !s.warmup && chance(0.02);
						const missed = !s.warmup && !skipped && chance(0.02) ? 1 : 0;
						const rpe = s.warmup || skipped || chance(0.25) ? null : 7 + 0.5 * rng.int(5);
						const set = {
							weight: s.weight,
							unit: 'kg' as const,
							reps: skipped ? null : s.reps - missed,
							rpe,
							isWarmup: s.warmup,
							isSkipped: skipped
						};
						seconds = n++ * 150 + rng.int(60);
						d.setRecords.push({
							...set,
							ownerId,
							clientMutationId: id(),
							workoutId,
							exerciseId: e.exerciseId,
							plannedExerciseLineageId: programId && e.lineageId,
							exercisePosition: i + 1,
							setIndex: k + 1,
							missedReps: missed,
							isExtra: working === 5 && k === sets.length - 1,
							e1rmKg: setE1rm(set)?.value ?? null,
							performedAt: new Date(startedAt.getTime() + seconds * 1000)
						});
					});
				}
			} else if (plan.kind === 'run') {
				const pace = between(295, 350);
				const kinds: RunSegmentKind[] =
					plan.segment === 'interval'
						? [
								'warm_up',
								...Array.from(
									{ length: between(6, 10) },
									() => ['interval', 'recovery'] as const
								).flat(),
								'cool_down'
							]
						: Array<RunSegmentKind>(
								plan.segment === 'long' ? between(18, 26) : between(8, 14)
							).fill(plan.segment);
				/** Each segment's metres and seconds. */
				const parts = kinds.map((kind): [number, number] =>
					kind === 'interval'
						? [800, between(184, 200)]
						: kind === 'recovery'
							? [200, 90]
							: [1000, pace + between(-8, 8)]
				);
				parts.forEach(([metres, duration], i) =>
					d.runRecordSegments.push({
						ownerId,
						clientMutationId: id(),
						workoutId,
						position: i + 1,
						kind: kinds[i]!,
						distanceMetres: metres,
						durationSeconds: duration,
						avgHr: between(135, 172)
					})
				);
				seconds = sum(parts.map(([, s]) => s));
				d.runRecords.push({
					workoutId,
					ownerId,
					distanceMetres: sum(parts.map(([m]) => m)),
					durationSeconds: seconds,
					avgHr: between(140, 160),
					rpe: plan.rpe
				});
			} else {
				seconds = plan.minutes * 60;
				d.otherSessionRecords.push({
					workoutId,
					ownerId,
					kind: plan.other,
					durationMinutes: plan.minutes,
					rpe: plan.rpe
				});
			}
			seconds += 300;
			const link = programId
				? { plannedSessionId: session.id, plannedLineageId: session.lineageId, programId }
				: {};
			d.workouts.push({
				id: workoutId,
				ownerId,
				clientId: id(),
				kind: plan.kind,
				discipline: plan.discipline,
				sessionType: session.sessionType,
				title: session.title,
				...link,
				status: 'completed',
				startedAt,
				finishedAt: new Date(startedAt.getTime() + seconds * 1000),
				durationSeconds: seconds,
				sessionRpe: plan.rpe
			});
		}
		for (let day = 0; day < 7; day++) {
			if (chance(0.4)) continue;
			d.recoveryNotes.push({
				ownerId,
				clientMutationId: id(),
				notedOn: addDays(monday, day),
				sleepHours: roundTo(5.5 + rng.next() * 3.5, 0.5),
				soreness: between(1, 5),
				energy: between(1, 5),
				stress: between(1, 5),
				note: chance(0.1) ? 'Slept badly' : null
			});
		}
	}

	for (const set of d.setRecords) {
		const roll = rng.next();
		if (roll < 0.01) d.edits.deletedSets.push(set.clientMutationId);
		else if (roll < 0.03 && set.weight != null) {
			const corrected = {
				weight: set.weight + 2.5,
				unit: 'kg' as const,
				reps: set.reps ?? null,
				rpe: set.rpe ?? null,
				isWarmup: set.isWarmup!,
				isSkipped: set.isSkipped!
			};
			d.edits.sets.push({
				clientMutationId: set.clientMutationId,
				weight: corrected.weight,
				e1rmKg: setE1rm(corrected)?.value ?? null
			});
		}
	}
	d.edits.deletedWorkouts = d.workouts.filter(() => chance(0.01)).map((w) => w.clientId);
	return d;
}

/**
 * One INSERT … SELECT FROM unnest(…) for all of a table's rows, each column cast to its type (json
 * and jsonb values as their JSON text). A column some rows leave out is null in them, not its
 * default: give every row the same columns.
 */
export async function insertAll(
	client: pg.ClientBase,
	table: PgTable,
	rows: Record<string, unknown>[]
) {
	const given = new Set(rows.flatMap((row) => Object.keys(row)));
	const columns = Object.entries(getTableColumns(table)).filter(([key]) => given.has(key));
	const names = columns.map(([, column]) => `"${column.name}"`).join(', ');
	const casts = columns.map(([, column], i) => `$${i + 1}::${column.getSQLType()}[]`).join(', ');
	const json = (value: unknown, type: string) =>
		(type === 'jsonb' || type === 'json') && value != null
			? JSON.stringify(value)
			: (value ?? null);
	await client.query(
		`insert into "${getTableName(table)}" (${names}) select * from unnest(${casts})`,
		columns.map(([key, column]) => rows.map((row) => json(row[key], column.getSQLType())))
	);
}

/**
 * Loads the dataset into a migrated, seeded database in one transaction, then analyses it.
 * `owner: false` loads it for the owner already there (analytics-dataset.ts).
 */
export async function loadDataset(
	client: pg.ClientBase,
	d: Dataset,
	{ owner = true }: { owner?: boolean } = {}
): Promise<void> {
	const catalogue = await client.query<{ key: string; id: string }>(
		'select key, id from exercises where key is not null'
	);
	const ids = new Map(catalogue.rows.map((row) => [row.key, row.id]));
	const resolve = (row: Record<string, unknown>) => {
		if (!('exerciseId' in row)) return row;
		const exerciseId = ids.get(row.exerciseId as string);
		if (!exerciseId) throw new Error(`no catalogue exercise '${String(row.exerciseId)}'`);
		return { ...row, exerciseId };
	};
	const { sets, deletedSets, deletedWorkouts } = d.edits;
	await client.query('begin');
	try {
		if (owner) await insertAll(client, t.owners, [d.owner]);
		for (const [name, table] of Object.entries(TABLES)) {
			await insertAll(
				client,
				table,
				(d[name as keyof Rows] as Record<string, unknown>[]).map(resolve)
			);
		}
		await client.query(
			`update programs set current_version_id = head.version
			 from unnest($1::uuid[], $2::uuid[]) head(program, version) where id = head.program`,
			[d.heads.map((h) => h.programId), d.heads.map((h) => h.versionId)]
		);
		await client.query(
			`update set_records s set weight = e.weight, e1rm_kg = e.e1rm
			 from unnest($1::uuid[], $2::numeric[], $3::numeric[]) e(id, weight, e1rm)
			 where s.client_mutation_id = e.id`,
			[sets.map((s) => s.clientMutationId), sets.map((s) => s.weight), sets.map((s) => s.e1rmKg)]
		);
		// Deleting a workout deletes its sets too (schema/training-log.ts).
		await client.query(
			`update set_records set deleted_at = performed_at + interval '1 day'
			 where client_mutation_id = any($1::uuid[])
			    or workout_id in (select id from workouts where client_id = any($2::uuid[]))`,
			[deletedSets, deletedWorkouts]
		);
		await client.query(
			`update workouts set deleted_at = started_at + interval '1 day' where client_id = any($1::uuid[])`,
			[deletedWorkouts]
		);
		await client.query('commit');
	} catch (err) {
		await client.query('rollback');
		throw err;
	}
	await client.query('analyze');
}
