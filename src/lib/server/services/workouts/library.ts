/**
 * The exercise library as data (PRD §7; the offline workout sync ADR): the live catalogue and the
 * owner's own exercises, in the owner's units, for the device to cache in IndexedDB so the
 * picker and an ad-hoc session work offline. The catalogue reaches the browser only this way,
 * never as code.
 *
 * - Built over M3's listExercises: retired rows and other owners' exercises are never listed.
 * - Each exercise carries what the picker searches and an added exercise logs from: its meta as a
 *   kit has it (rest class, the increment in the owner's weight unit) plus aliases, equipment and
 *   default seconds.
 * - `digest` is a SHA-256 of everything else in the response, so it changes exactly when the
 *   device's copy would: a custom exercise created, renamed or retired, a catalogue change, or
 *   new units. The route serves it as a strong ETag and answers a matching If-None-Match 304.
 * - Two queries, awaited in turn: the exercises, then the profile (read only; an owner with no
 *   profile row gets athlete_profiles' defaults, as a kit does).
 */
import { createHash } from 'node:crypto';
import { DEFAULT_LOAD_INCREMENT } from '../../../domain/units';
import type { ExerciseLibrary, KitUnits, LibraryExercise } from '../../../domain/workout/index';
import { restClassOf } from '../../../domain/workout/timers';
import { createProfileRepository } from '../../db/repositories/profile';
import { measure } from '../../observability/timing';
import { listExercises, type ExerciseDef } from '../exercises/index';
import { resolveDeps, type TrainingDeps } from '../training/shared';
import { DEFAULT_UNITS } from './kit';

/**
 * How the device may keep the response: in its private cache only, and revalidated on every use,
 * which a matching ETag answers with an empty 304. Owner decision: a max-age would let the
 * picker skip the request, but then show a just-created exercise late.
 */
export const LIBRARY_CACHE_CONTROL = 'private, no-cache';

/** The live library, in the owner's units, with its digest. */
export async function getExerciseLibrary(
	ownerId: string,
	deps: TrainingDeps = {}
): Promise<ExerciseLibrary> {
	const { db } = resolveDeps(deps);
	const live = await listExercises(ownerId, {}, { db });
	const profile = await measure('db', () => createProfileRepository(db).getProfile(ownerId));
	const units: KitUnits = profile
		? { weight: profile.weightUnit, distance: profile.distanceUnit }
		: DEFAULT_UNITS;
	const exercises = live.map((e) => libraryExercise(e, units));
	const body = { v: 1 as const, units, exercises };
	const digest = createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex');
	return { v: 1, digest, units, exercises };
}

function libraryExercise(e: ExerciseDef, units: KitUnits): LibraryExercise {
	return {
		id: e.id,
		key: e.key,
		name: e.name,
		aliases: [...e.aliases],
		measure: e.measure,
		loadType: e.loadType,
		unilateral: e.unilateral,
		pattern: e.pattern,
		equipment: [...e.equipment],
		tags: [...e.tags],
		defaultSeconds: e.defaultSeconds,
		restClass: restClassOf(e),
		increment: DEFAULT_LOAD_INCREMENT[units.weight]
	};
}

/** The digest as a strong ETag. */
export const libraryEtag = (digest: string) => `"${digest}"`;

/**
 * Whether an If-None-Match header names this ETag: '*', or a comma-separated list compared
 * weakly (RFC 9110 §13.1.2), so a W/ prefix a proxy added still matches.
 */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
	if (ifNoneMatch === null) return false;
	return ifNoneMatch
		.split(',')
		.map((tag) => tag.trim().replace(/^W\//, ''))
		.some((tag) => tag === '*' || tag === etag);
}
