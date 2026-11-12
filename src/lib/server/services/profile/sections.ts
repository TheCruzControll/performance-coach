/**
 * Training-profile sections saved as a whole: experience, strength baselines, running and
 * Muay Thai specifics, equipment, injuries, exercise likes/dislikes, schedule. Each save
 * validates with the shared schema (src/lib/domain/profile/schemas.ts), runs in one
 * transaction, and keeps ids (and history, for baselines) for what did not change. A save that
 * replaces a set of rows takes its section's lock first, so concurrent saves of one section (a
 * double-tapped Save, a second tab) run one after the other and the last one is stored whole.
 */
import { estimateOneRepMax } from '../../../domain/e1rm';
import { BASELINE_SOURCE_KIND, RACE_DISTANCE_INFO } from '../../../domain/profile/catalog';
import {
	baselinesSchema,
	equipmentSchema,
	exercisePreferencesSchema,
	experienceSchema,
	type ExercisePreferencesData,
	injuriesSchema,
	scheduleSchema,
	specificsSchema
} from '../../../domain/profile/schemas';
import type {
	EquipmentProfile,
	ExercisePreference,
	ExperienceEntry,
	HeartRate,
	Injury,
	MuayThaiProfile,
	RunningProfile,
	Schedule,
	StrengthBaseline
} from '../../../domain/profile/types';
import type { PreferenceSource } from '../../../domain/training/vocabulary';
import { toMetres } from '../../../domain/units';
import {
	createProfileRepository,
	type BaselineRow,
	type ExercisePreferenceRow,
	type NewBaseline,
	type NewPreference,
	type RunningRow
} from '../../db';
import { measure } from '../../observability/timing';
import { resolveExerciseNames, type ExerciseDef } from '../exercises/index';
import {
	parseWith,
	ProfileInputError,
	resolveDeps,
	toBaseline,
	toCommitment,
	toExercisePreference,
	toExperienceList,
	toInjury,
	toRace,
	type ProfileDeps
} from './shared';

// ---- experience --------------------------------------------------------------------------------

export async function getExperience(ownerId: string, deps: ProfileDeps = {}) {
	const { db } = resolveDeps(deps);
	const rows = await measure('db', () => createProfileRepository(db).listExperience(ownerId));
	return toExperienceList(rows);
}

export async function saveExperience(
	ownerId: string,
	input: unknown,
	deps: ProfileDeps = {}
): Promise<ExperienceEntry[]> {
	const { entries } = parseWith(experienceSchema, input);
	const { db, now } = resolveDeps(deps);
	return measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createProfileRepository(tx);
			await repo.lockSection(ownerId, 'experience');
			await repo.ensureProfile(ownerId);
			await repo.replaceExperience(
				ownerId,
				entries.map((e) => ({
					discipline: e.discipline,
					customLabel: e.discipline === 'custom' ? (e.customLabel ?? '') : '',
					level: e.level,
					years: e.years,
					sessionsPerWeek: e.sessionsPerWeek,
					notes: e.notes
				})),
				now()
			);
			return toExperienceList(await repo.listExperience(ownerId));
		})
	);
}

// ---- strength baselines ------------------------------------------------------------------------

export async function getBaselines(ownerId: string, deps: ProfileDeps = {}) {
	const { db } = resolveDeps(deps);
	const repo = createProfileRepository(db);
	const { profile, rows } = await measure('db', async () => ({
		profile: await repo.getProfile(ownerId),
		rows: await repo.listCurrentBaselines(ownerId)
	}));
	return { unknown: profile?.baselinesUnknown ?? false, lifts: rows.map(toBaseline) };
}

/** Every stored baseline (superseded ones included), newest first. */
export async function baselineHistory(ownerId: string, deps: ProfileDeps = {}) {
	const { db } = resolveDeps(deps);
	return (await createProfileRepository(db).listBaselineHistory(ownerId)).map(toBaseline);
}

const SAME_FIELDS = [
	'source',
	'value',
	'unit',
	'achievedOn',
	'setWeight',
	'setReps',
	'setRpe',
	'notes'
] as const satisfies readonly (keyof BaselineRow & keyof NewBaseline)[];

/**
 * Save the current 1RMs. All of them are optional (PRD §3): `unknown: true` with no lifts
 * means week 1 establishes them. The kind is derived from the source here — a client can never
 * mark an estimate as measured — and estimates from a set are computed with the shared e1RM
 * function. A changed lift supersedes its previous row; removed lifts are superseded too.
 */
export async function saveBaselines(
	ownerId: string,
	input: unknown,
	deps: ProfileDeps = {}
): Promise<{ unknown: boolean; lifts: StrengthBaseline[] }> {
	const data = parseWith(baselinesSchema, input);
	const { db, now } = resolveDeps(deps);
	return measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createProfileRepository(tx);
			await repo.lockSection(ownerId, 'baselines');
			await repo.ensureProfile(ownerId);
			const at = now();
			const current = await repo.listCurrentBaselines(ownerId);
			const key = (lift: string, label: string | null) => `${lift}:${(label ?? '').toLowerCase()}`;
			const byKey = new Map(current.map((row) => [key(row.lift, row.customLabel), row]));

			const toInsert: NewBaseline[] = [];
			const keep = new Set<string>();
			for (const lift of data.lifts) {
				const customLabel = lift.lift === 'custom' ? (lift.customLabel ?? '') : '';
				let value = lift.value!;
				let method: string | null = null;
				let confidence: NewBaseline['confidence'] = null;
				if (lift.source === 'set') {
					const estimate = estimateOneRepMax({
						weight: lift.setWeight!,
						reps: lift.setReps!,
						rpe: lift.setRpe
					})!;
					value = Math.round(estimate.value * 100) / 100;
					method = estimate.method;
					confidence = estimate.confidence;
				}
				const row: NewBaseline = {
					ownerId,
					lift: lift.lift,
					customLabel,
					kind: BASELINE_SOURCE_KIND[lift.source],
					source: lift.source,
					value,
					unit: lift.unit,
					achievedOn: lift.achievedOn,
					setWeight: lift.source === 'set' ? lift.setWeight : null,
					setReps: lift.source === 'set' ? lift.setReps : null,
					setRpe: lift.source === 'set' ? lift.setRpe : null,
					method,
					confidence,
					notes: lift.notes,
					recordedAt: at
				};
				const existing = byKey.get(key(lift.lift, customLabel));
				if (existing && SAME_FIELDS.every((f) => (existing[f] ?? null) === (row[f] ?? null))) {
					keep.add(existing.id);
				} else {
					toInsert.push(row);
				}
			}
			await repo.supersedeBaselines(
				ownerId,
				current.filter((row) => !keep.has(row.id)).map((row) => row.id),
				at
			);
			await repo.insertBaselines(toInsert);
			await repo.updateProfile(ownerId, { baselinesUnknown: data.unknown }, at);
			return {
				unknown: data.unknown,
				lifts: (await repo.listCurrentBaselines(ownerId)).map(toBaseline)
			};
		})
	);
}

// ---- running & Muay Thai -----------------------------------------------------------------------

export interface Specifics {
	running: RunningProfile | null;
	muayThai: MuayThaiProfile | null;
}

export async function getSpecifics(ownerId: string, deps: ProfileDeps = {}): Promise<Specifics> {
	const { db } = resolveDeps(deps);
	const repo = createProfileRepository(db);
	const { running, races, muayThai } = await measure('db', async () => ({
		running: await repo.getRunning(ownerId),
		races: await repo.listRaces(ownerId),
		muayThai: await repo.getMuayThai(ownerId)
	}));
	return {
		running: running
			? {
					unit: running.unit,
					weeklyDistance: running.weeklyDistance,
					runsPerWeek: running.runsPerWeek,
					longestRun: running.longestRun,
					easyPaceSeconds: running.easyPaceSeconds,
					...toHeartRate(running),
					races: races.map(toRace),
					notes: running.notes,
					updatedAt: running.updatedAt
				}
			: null,
		muayThai: muayThai
			? {
					sessionsPerWeek: muayThai.sessionsPerWeek,
					sparringPerWeek: muayThai.sparringPerWeek,
					fights: muayThai.fights,
					notes: muayThai.notes,
					updatedAt: muayThai.updatedAt
				}
			: null
	};
}

/** The running profile's heart rates, or null with none stored (the session screen's zones). */
export async function getHeartRate(
	ownerId: string,
	deps: ProfileDeps = {}
): Promise<HeartRate | null> {
	const { db } = resolveDeps(deps);
	const running = await measure('db', () => createProfileRepository(db).getRunning(ownerId));
	return (running && toHeartRate(running).heartRate) ?? null;
}

/** `{ heartRate }` when the row holds at least one heart rate, else nothing (no key at all). */
function toHeartRate(row: RunningRow): { heartRate?: HeartRate } {
	const heartRate = { max: row.maxHr, resting: row.restingHr, threshold: row.thresholdHr };
	return Object.values(heartRate).some((v) => v !== null) ? { heartRate } : {};
}

/** The columns a save writes: none when heart rate was left out, so the stored values stay. */
function heartRateColumns(heartRate: HeartRate | null | undefined) {
	if (heartRate === undefined) return {};
	return {
		maxHr: heartRate?.max ?? null,
		restingHr: heartRate?.resting ?? null,
		thresholdHr: heartRate?.threshold ?? null
	};
}

/** Save running and/or Muay Thai specifics. A `null` section is left as it is. */
export async function saveSpecifics(
	ownerId: string,
	input: unknown,
	deps: ProfileDeps = {}
): Promise<Specifics> {
	const data = parseWith(specificsSchema, input);
	const { db, now } = resolveDeps(deps);
	await measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createProfileRepository(tx);
			await repo.lockSection(ownerId, 'specifics');
			await repo.ensureProfile(ownerId);
			const at = now();
			if (data.running) {
				const { races, heartRate, ...running } = data.running;
				await repo.upsertRunning(ownerId, { ...running, ...heartRateColumns(heartRate) }, at);
				await repo.replaceRaces(
					ownerId,
					races.map((race) => ({
						distance: race.distance,
						customDistance: race.distance === 'other' ? race.customDistance : null,
						distanceMetres:
							RACE_DISTANCE_INFO[race.distance].metres ??
							Math.round(toMetres(race.customDistance!, running.unit) * 10) / 10,
						timeSeconds: race.timeSeconds,
						racedOn: race.racedOn,
						eventName: race.eventName,
						createdAt: at
					}))
				);
			}
			if (data.muayThai) await repo.upsertMuayThai(ownerId, data.muayThai, at);
		})
	);
	return getSpecifics(ownerId, deps);
}

// ---- equipment ---------------------------------------------------------------------------------

export async function getEquipment(
	ownerId: string,
	deps: ProfileDeps = {}
): Promise<EquipmentProfile | null> {
	const { db } = resolveDeps(deps);
	const row = await measure('db', () => createProfileRepository(db).getEquipment(ownerId));
	return row
		? {
				gymType: row.gymType,
				equipment: row.equipment,
				homeEquipment: row.homeEquipment,
				notes: row.notes,
				updatedAt: row.updatedAt
			}
		: null;
}

export async function saveEquipment(
	ownerId: string,
	input: unknown,
	deps: ProfileDeps = {}
): Promise<EquipmentProfile | null> {
	const data = parseWith(equipmentSchema, input);
	const { db, now } = resolveDeps(deps);
	await measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createProfileRepository(tx);
			await repo.ensureProfile(ownerId);
			await repo.upsertEquipment(ownerId, data, now());
		})
	);
	return getEquipment(ownerId, deps);
}

// ---- injuries & limitations --------------------------------------------------------------------

export async function getInjuries(ownerId: string, deps: ProfileDeps = {}): Promise<Injury[]> {
	const { db } = resolveDeps(deps);
	return (await measure('db', () => createProfileRepository(db).listInjuries(ownerId))).map(
		toInjury
	);
}

/**
 * Save the list. Entries with an id update that injury (so its history — created_at, when it
 * was resolved — survives); entries without one are new; injuries left out are deleted.
 */
export async function saveInjuries(
	ownerId: string,
	input: unknown,
	deps: ProfileDeps = {}
): Promise<Injury[]> {
	const { injuries } = parseWith(injuriesSchema, input);
	const { db, now } = resolveDeps(deps);
	return measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createProfileRepository(tx);
			await repo.lockSection(ownerId, 'injuries');
			await repo.ensureProfile(ownerId);
			const at = now();
			const existing = new Map((await repo.listInjuries(ownerId)).map((row) => [row.id, row]));
			const keep: string[] = [];
			for (const injury of injuries) {
				const { id, ...values } = injury;
				const previous = id ? existing.get(id) : undefined;
				if (id && !previous) {
					throw new ProfileInputError({ injuries: 'That injury no longer exists — reload' });
				}
				const resolvedAt = values.active ? null : (previous?.resolvedAt ?? at);
				if (previous) {
					await repo.updateInjury(ownerId, previous.id, { ...values, resolvedAt, updatedAt: at });
					keep.push(previous.id);
				} else {
					const row = await repo.insertInjury({
						...values,
						ownerId,
						resolvedAt,
						createdAt: at,
						updatedAt: at
					});
					keep.push(row.id);
				}
			}
			await repo.deleteInjuriesExcept(ownerId, keep);
			return (await repo.listInjuries(ownerId)).map(toInjury);
		})
	);
}

// ---- exercise likes & dislikes -----------------------------------------------------------------

export async function getExercisePreferences(
	ownerId: string,
	deps: ProfileDeps = {}
): Promise<ExercisePreference[]> {
	const { db } = resolveDeps(deps);
	const rows = await measure('db', () =>
		createProfileRepository(db).listExercisePreferences(ownerId)
	);
	return rows.map(toExercisePreference);
}

/**
 * Save the owner's likes and dislikes, each linked to the library exercise its words name. Two
 * entries for one exercise ('RDL' and 'Romanian deadlift') are a field error at `items`, before
 * anything is written. Takes the same lock as every preference writer (recordExercisePreference
 * in services/training/preferences.ts), so a swap dislike recorded meanwhile waits or is kept.
 */
export async function saveExercisePreferences(
	ownerId: string,
	input: unknown,
	deps: ProfileDeps = {}
): Promise<ExercisePreference[]> {
	const { items } = parseWith(exercisePreferencesSchema, input);
	const { db, now, source } = resolveDeps(deps);
	const named = await resolveExerciseNames(
		ownerId,
		items.map((item) => item.exercise),
		{ db }
	);
	return measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createProfileRepository(tx);
			await repo.lockSection(ownerId, 'exercisePreferences');
			const stored = await repo.listExercisePreferences(ownerId);
			const rows = linkedPreferences(items, named, stored, source);
			await repo.ensureProfile(ownerId);
			await repo.replaceExercisePreferences(ownerId, rows, now());
			return (await repo.listExercisePreferences(ownerId)).map(toExercisePreference);
		})
	);
}

/**
 * The rows a Profile save writes: each item linked to the exercise it names, a kept preference
 * by its stored link first (an exercise of the owner's retired since stays linked), and recorded
 * with the save's source. Throws when two items name one exercise.
 */
function linkedPreferences(
	items: ExercisePreferencesData['items'],
	named: readonly (ExerciseDef | null)[],
	stored: readonly ExercisePreferenceRow[],
	source: PreferenceSource
): NewPreference[] {
	const links = new Map(stored.map((row) => [row.exercise.toLowerCase(), row.exerciseId]));
	const rows = items.map((item, i) => ({
		...item,
		exerciseId: links.get(item.exercise.toLowerCase()) ?? named[i]?.id ?? null,
		source
	}));
	const first = new Map<string, number>();
	for (const [i, { exerciseId, exercise }] of rows.entries()) {
		if (!exerciseId) continue;
		const j = first.get(exerciseId);
		if (j === undefined) {
			first.set(exerciseId, i);
			continue;
		}
		const name = [named[j], named[i]].find((e) => e?.id === exerciseId)?.name ?? exercise;
		throw new ProfileInputError({
			items: `You’ve listed ${name} twice (as “${rows[j]!.exercise}” and “${exercise}”)`
		});
	}
	return rows;
}

// ---- schedule & availability -------------------------------------------------------------------

export async function getSchedule(ownerId: string, deps: ProfileDeps = {}): Promise<Schedule> {
	const { db } = resolveDeps(deps);
	const repo = createProfileRepository(db);
	const { row, commitments } = await measure('db', async () => ({
		row: await repo.getSchedule(ownerId),
		commitments: await repo.listCommitments(ownerId)
	}));
	return {
		daysPerWeek: row?.daysPerWeek ?? null,
		availableDays: row?.availableDays ?? [],
		preferredTimes: row?.preferredTimes ?? [],
		sessionMinutes: row?.sessionMinutes ?? null,
		constraints: row?.constraints ?? null,
		commitments: commitments.map(toCommitment),
		updatedAt: row?.updatedAt ?? null
	};
}

export async function saveSchedule(
	ownerId: string,
	input: unknown,
	deps: ProfileDeps = {}
): Promise<Schedule> {
	const { commitments, ...schedule } = parseWith(scheduleSchema, input);
	const { db, now } = resolveDeps(deps);
	await measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createProfileRepository(tx);
			await repo.lockSection(ownerId, 'schedule');
			await repo.ensureProfile(ownerId);
			const at = now();
			await repo.upsertSchedule(ownerId, schedule, at);
			const existing = new Set((await repo.listCommitments(ownerId)).map((row) => row.id));
			const keep: string[] = [];
			for (const commitment of commitments) {
				const { id, ...values } = commitment;
				if (id && !existing.has(id)) {
					throw new ProfileInputError({ commitments: 'That commitment no longer exists — reload' });
				}
				if (id) {
					await repo.updateCommitment(ownerId, id, { ...values, updatedAt: at });
					keep.push(id);
				} else {
					const row = await repo.insertCommitment({
						...values,
						ownerId,
						createdAt: at,
						updatedAt: at
					});
					keep.push(row.id);
				}
			}
			await repo.deleteCommitmentsExcept(ownerId, keep);
		})
	);
	return getSchedule(ownerId, deps);
}
