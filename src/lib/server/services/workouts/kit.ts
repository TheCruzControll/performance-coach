/**
 * The start kit (PRD §7–§9; the offline workout sync ADR, 'The start kit'): everything a planned
 * session needs once it has started, so the workout never waits for the network. Built on the
 * server, because the catalogue and the generator never reach the browser: it arrives as data.
 *
 * - kitForLineage: the current version's session with this lineage, pinned to its row (start).
 *   kitForSession: a pinned planned_sessions id, whichever version holds it (adoption). A
 *   malformed id, an unknown one and another owner's all read as null, which the route answers 404.
 * - A strength kit carries, per exercise: its meta, load type, rest class (timers.ts restClassOf)
 *   and superset number; one KitSet per prescribed set, with M3's describePrescription line and
 *   instruction and only the loads M3's prescribedLoad can compute (rounded to M1's increment);
 *   its previous completed session's sets; its prior bests and best e1RM, always labelled
 *   estimated; and, for an exercise that competes for it, its most reps.
 * - A from_e1rm load is a fraction of the latest estimate: the best e1RM of the previous completed
 *   session's sets, never the lifetime best, so an older, higher estimate cannot overload it. With
 *   no estimate there, the set has no weight. On the device, today's top set replaces it as soon
 *   as one is logged (prefill.ts).
 * - Bests and 'last time' come from before the workout: before now for a kit to start, and before
 *   the start of the owner's workout in progress on this session for one to adopt, so a set it
 *   has already synced is never its own prior best (summary.ts).
 * - Loads, paces and distances read in the training profile's units (M2's canonical preference;
 *   the plan's open question on device units keeps this default).
 * - So every substitution works offline, a strength exercise also carries M3's ranked
 *   alternatives (domain/programming/alternatives.ts) with their reasons, what each needs and its
 *   own last top set; why nothing fits when none does; and, per body area, the gentler options
 *   'This hurts' offers (domain/programming/pain.ts). The catalogue and the rules stay here: the
 *   kit carries only the exercises and words.
 * - Its query count does not grow with the session: the session and its children, the profile,
 *   the owner's programming input (built once per kit; the alternatives are ranked in memory), the
 *   exercises, the alternatives' rows by key, then queries/history.ts's batched builders, one
 *   query each, awaited in turn.
 */
import { localDay } from '../../../domain/dates';
import { BODY_AREAS, type BodyArea } from '../../../domain/profile/catalog';
import { alternativesFor, type Alternative } from '../../../domain/programming/alternatives';
import { libraryOf, whyNothingFits } from '../../../domain/programming/eligibility';
import {
	toExerciseKey,
	type ExerciseKey,
	type ProgrammingInput
} from '../../../domain/programming/input';
import { gentlerFor } from '../../../domain/programming/pain';
import { GENTLER_WORDS } from '../../../domain/programming/rules/pain';
import { describePrescription, prescribedLoad } from '../../../domain/training/describe';
import { bestE1rm, personalRecords } from '../../../domain/training/metrics';
import type { SetPrescription } from '../../../domain/training/types';
import { DEFAULT_LOAD_INCREMENT, type WeightUnit } from '../../../domain/units';
import type {
	KitAlternative,
	KitExercise,
	KitExerciseMeta,
	KitSet,
	KitUnits,
	LoggedSet,
	PrescribedWeight,
	StartKit
} from '../../../domain/workout/index';
import { prKinds } from '../../../domain/workout/logging';
import { topSetOf } from '../../../domain/workout/prefill';
import { restClassOf } from '../../../domain/workout/timers';
import {
	createHistoryRepository,
	type HistorySetRow,
	type LastSessionSetRow
} from '../../db/repositories/history';
import { createProfileRepository } from '../../db/repositories/profile';
import { createProgramsRepository, type SessionRow } from '../../db/repositories/programs';
import type { Executor } from '../../db/types';
import { measure } from '../../observability/timing';
import { ACTIVE_WORKOUTS_LIMIT } from './canonical';
import { getExercisesByIds, resolveKeys, type ExerciseDef } from '../exercises/index';
import { isUuid } from '../ids';
import { alternativeWhy, programmingInputFor } from '../programs/alternatives';
import { toStoredSessions, type StoredExercise } from '../programs/mapping';
import { resolveDeps, type TrainingDeps } from '../training/shared';

/** athlete_profiles' own defaults, for an owner with no profile row yet. */
export const DEFAULT_UNITS: KitUnits = { weight: 'kg', distance: 'km' };
const DEFAULT_TIME_ZONE = 'UTC';

/** A planned session row, with the program and version the kit names. */
interface Pinned {
	session: SessionRow;
	programId: string;
	versionNumber: number;
}

/** The kit of the active program's current-version session with this lineage; null if none. */
export async function kitForLineage(
	ownerId: string,
	lineage: string,
	deps: TrainingDeps = {}
): Promise<StartKit | null> {
	if (!isUuid(lineage)) return null;
	const { db, now } = resolveDeps(deps);
	const programs = createProgramsRepository(db);
	const pinned = await measure('db', async () => {
		const current = await programs.currentProgram(ownerId);
		const hit = current && (await programs.sessionByLineage(current.version.id, lineage));
		return current && hit
			? {
					session: hit.session,
					programId: current.program.id,
					versionNumber: current.version.number
				}
			: null;
	});
	return pinned && buildKit(db, ownerId, pinned, now());
}

/** The kit of the planned session row with this id, in any of the owner's programs; null if none. */
export async function kitForSession(
	ownerId: string,
	sessionId: string,
	deps: TrainingDeps = {}
): Promise<StartKit | null> {
	if (!isUuid(sessionId)) return null;
	const { db, now } = resolveDeps(deps);
	const found = await measure('db', async () => {
		const pinned = await createProgramsRepository(db).sessionById(ownerId, sessionId);
		if (!pinned) return null;
		const active = await createHistoryRepository(db).activeWorkouts(ownerId, ACTIVE_WORKOUTS_LIMIT);
		// Newest first: the last match is the earliest workout in progress on this session.
		const started = active.findLast((w) => w.plannedSessionId === sessionId)?.startedAt;
		return { pinned, before: started ?? now() };
	});
	return found && buildKit(db, ownerId, found.pinned, found.before);
}

async function buildKit(
	db: Executor,
	ownerId: string,
	{ session, programId, versionNumber }: Pinned,
	before: Date
): Promise<StartKit> {
	const { children, profile } = await measure('db', async () => ({
		children: await createProgramsRepository(db).sessionChildren([session.id]),
		profile: await createProfileRepository(db).getProfile(ownerId)
	}));
	const units: KitUnits = profile
		? { weight: profile.weightUnit, distance: profile.distanceUnit }
		: DEFAULT_UNITS;
	const stored = toStoredSessions({ sessions: [session], ...children }).get(session.id)!;
	const base = {
		v: 1 as const,
		title: stored.title,
		sessionType: stored.type,
		discipline: stored.discipline,
		date: stored.date,
		plannedLineage: stored.lineage,
		plannedSessionId: stored.id,
		programId,
		versionNumber,
		units
	};
	switch (stored.kind) {
		case 'run':
			return { ...base, kind: 'run', run: { segments: stored.segments } };
		case 'other': {
			const { kind, durationMinutes, targetRpe, metrics } = stored.details;
			return { ...base, kind: 'other', other: { kind, durationMinutes, targetRpe, metrics } };
		}
		case 'strength': {
			const exerciseOf = new Map(children.exercises.map((row) => [row.id, row.exerciseId]));
			const planned = stored.exercises.map((e) => ({ ...e, exerciseId: exerciseOf.get(e.id)! }));
			const context = {
				units,
				timeZone: profile?.timeZone ?? DEFAULT_TIME_ZONE,
				before
			};
			return {
				...base,
				kind: 'strength',
				exercises: await strengthExercises(db, ownerId, planned, context)
			};
		}
	}
}

interface KitContext {
	units: KitUnits;
	timeZone: string;
	/** History counts only sets performed before this instant. */
	before: Date;
}

/**
 * The kit's exercises, in order: the owner's programming input once, every exercise's choices in
 * memory, the exercises (planned and the owner's own offered ones) in one query, the offered
 * catalogue exercises by key in another, then each batched history read.
 */
async function strengthExercises(
	db: Executor,
	ownerId: string,
	planned: (StoredExercise & { exerciseId: string })[],
	{ units, timeZone, before }: KitContext
): Promise<KitExercise[]> {
	const ids = [...new Set(planned.map((e) => e.exerciseId))];
	const input = await programmingInputFor(ownerId, { db });
	const keys = [...new Set(planned.map((e) => toExerciseKey(e.exercise)))];
	const choices = new Map(keys.map((key) => [key, choicesFor(key, input)]));
	const offered = [...new Set([...choices.values()].flatMap(offeredKeys))];
	const ownIds = offered.flatMap((key) =>
		key.startsWith(CUSTOM) ? [key.slice(CUSTOM.length)] : []
	);
	const library = await getExercisesByIds(ownerId, [...ids, ...ownIds], { db });
	const rows = await resolveKeys(
		offered.filter((key) => !key.startsWith(CUSTOM)),
		{ db }
	);
	const defOf = (key: ExerciseKey) =>
		key.startsWith(CUSTOM) ? library.get(key.slice(CUSTOM.length)) : rows.get(key);
	const offeredIds = offered.flatMap((key) => defOf(key)?.id ?? []);
	const metas = new Map(ids.map((id) => [id, metaOf(library.get(id)!, units.weight)]));
	const competing = ids.filter((id) => prKinds(metas.get(id)!).includes('most_reps'));
	const history = createHistoryRepository(db);
	const { last, records, most } = await measure('db', async () => ({
		// The offered exercises' last sessions give their last top sets.
		last: await history.lastSessionSets(ownerId, [...new Set([...ids, ...offeredIds])], before),
		records: await history.personalRecords(ownerId, ids, before),
		most: await history.mostReps(ownerId, competing, before)
	}));
	const lastOf = Map.groupBy(last, (row) => row.exerciseId);
	const bestOf = Map.groupBy(records.bestE1rms, (row) => row.exercise.id);
	const repsOf = Map.groupBy(records.repMaxes, (row) => row.exercise.id);
	const mostOf = new Map(most.map((row) => [row.exerciseId, row.reps]));
	const setsOf = (rows: { set: HistorySetRow }[] | undefined) => (rows ?? []).map((r) => r.set);

	/** An offered exercise as the kit carries it; none for a key with no library row. */
	const toKit = ({ key, reasons }: Offered): KitAlternative[] => {
		const def = defOf(key);
		if (!def) return [];
		const previous = previousOf(lastOf.get(def.id), timeZone);
		const top = previous && topSetOf(previous.sets, def.loadType);
		return [
			{
				exercise: metaOf(def, units.weight),
				reasons,
				equipment: [...def.equipment],
				lastTopSet: top && { ...top, date: previous.date }
			}
		];
	};

	return planned.map((e, i) => {
		const choice = choices.get(toExerciseKey(e.exercise))!;
		const best = bestE1rm(setsOf(bestOf.get(e.exerciseId)));
		const lastTime = lastOf.get(e.exerciseId);
		const latest = bestE1rm(setsOf(lastTime))?.value ?? null;
		return {
			position: i + 1,
			plannedLineage: e.lineage,
			superset: e.superset,
			exercise: metas.get(e.exerciseId)!,
			sets: e.sets.flatMap((p) => kitSets(p, units.weight, latest)),
			instructions: e.instructions,
			previous: previousOf(lastTime, timeZone),
			bestE1rm: best && { kg: best.value, estimated: true },
			priorBests: personalRecords(setsOf(repsOf.get(e.exerciseId))).map((record) => ({
				reps: record.reps,
				weightKg: record.weightKg,
				date: localDay(record.set.performedAt, timeZone)
			})),
			mostReps: mostOf.get(e.exerciseId) ?? null,
			alternatives: choice.alternatives.flatMap(toKit),
			blocked: choice.blocked,
			gentler: Object.fromEntries(
				Object.entries(choice.gentler).map(([area, options]) => [area, options.flatMap(toKit)])
			)
		};
	});
}

const CUSTOM = 'custom:';
const LIKED = 'One you like';

/** An exercise offered in a planned one's place, with its reasons. */
interface Offered {
	key: ExerciseKey;
	reasons: string[];
}

/** What a planned exercise can become, by key: M3's alternatives and each area's gentler ones. */
interface Choices {
	alternatives: Offered[];
	/** Why nothing fits, when no alternative does; otherwise empty. */
	blocked: string[];
	gentler: Partial<Record<BodyArea, Offered[]>>;
}

const offeredKeys = (choice: Choices) =>
	[...choice.alternatives, ...Object.values(choice.gentler).flat()].map((o) => o.key);

/** The choices of the library exercise `key`, ranked in memory from the built input. */
function choicesFor(key: ExerciseKey, input: ProgrammingInput): Choices {
	const original = libraryOf(input).find((e) => e.key === key);
	// A retired catalogue exercise a stored program still names is no longer in the library.
	if (!original) return { alternatives: [], blocked: [whyNothingFits([], input)], gentler: {} };
	const why = ({ key: k, via }: Alternative) => {
		const exercise = libraryOf(input).find((e) => e.key === k)!;
		return [alternativeWhy(original, exercise, via), ...(input.likes.includes(k) ? [LIKED] : [])];
	};
	const ranked = alternativesFor(key, input);
	return {
		alternatives: ranked.alternatives.map((a) => ({ key: a.key, reasons: why(a) })),
		blocked: ranked.alternatives.length ? [] : [whyNothingFits(ranked.blocked, input)],
		gentler: Object.fromEntries(
			BODY_AREAS.map((area) => [
				area,
				gentlerFor(key, input, area).options.map((o) => ({
					key: o.key,
					reasons: [...o.gentler.map((by) => GENTLER_WORDS[by]), ...why(o)]
				}))
			])
		)
	};
}

function metaOf(e: ExerciseDef, unit: WeightUnit): KitExerciseMeta {
	return {
		id: e.id,
		key: e.key,
		name: e.name,
		measure: e.measure,
		loadType: e.loadType,
		unilateral: e.unilateral,
		pattern: e.pattern,
		tags: [...e.tags],
		equipment: [...e.equipment],
		restClass: restClassOf(e),
		increment: DEFAULT_LOAD_INCREMENT[unit]
	};
}

/** What a computed load rests on: as prescribed, or a measured or an estimated 1RM. */
const basisOf = (p: SetPrescription): PrescribedWeight['basis'] =>
	p.loadKind === 'absolute' ? 'absolute' : p.loadBasis === 'measured' ? 'measured' : 'estimated';

/** One prescription line as its sets, each with M3's words and the load only it can compute. */
function kitSets(p: SetPrescription, unit: WeightUnit, oneRepMaxKg: number | null): KitSet[] {
	const options = { unit, oneRepMaxKg };
	const words = describePrescription(p, options);
	const value = prescribedLoad(p, options);
	const relative = p.loadKind === 'percent_1rm' || p.loadKind === 'from_e1rm';
	const set: KitSet = {
		role: p.role,
		repsMin: p.repsMin,
		repsMax: p.repsMax,
		seconds: p.seconds,
		metres: p.metres,
		targetRpe: p.targetRpe,
		prescribedWeight: value === null ? null : { value, unit, basis: basisOf(p) },
		...(relative && { load: { kind: p.loadKind, fraction: p.loadValue } }),
		restSeconds: p.restSeconds,
		line: words.headline,
		instruction: words.instruction
	};
	return Array.from({ length: p.sets }, () => ({ ...set }));
}

/** The previous session's sets as the device records a set, on the day it started there. */
export function previousOf(rows: LastSessionSetRow[] | undefined, timeZone: string) {
	if (!rows?.length) return null;
	return {
		date: localDay(rows[0]!.startedAt, timeZone),
		sets: rows.map(({ set }): LoggedSet => ({
			reps: set.reps,
			seconds: set.seconds,
			metres: set.metres,
			weight: set.weight,
			assistance: set.assistance,
			unit: set.unit,
			rpe: set.rpe,
			missedReps: set.missedReps,
			isWarmup: set.isWarmup,
			isExtra: set.isExtra
		}))
	};
}
