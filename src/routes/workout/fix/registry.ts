/**
 * Fix, by mutation type (the M4 plan's decision 18; the brief's failed-sync recovery): every type
 * points at its family module, so a type without one fails pnpm check. Each module gives each of
 * its types an editor, opened with the refused values, whose Save re-queues the change under the
 * same id in its place; a one-tap rewrite, re-queued the same way; or Discard only, with words
 * that say what discarding keeps. Later slices replace their own family module (run-logging,
 * other-logging, finish-workout, substitutions, pain-flow, custom-exercises-ui).
 *
 * Route-local and lazy: the sync sheet loads this, and each family module loads on demand, so no
 * workout route's initial JavaScript grows.
 */
import type { Mutation, MutationType } from '#lib/domain/workout/index.ts';

export type Fix =
	/** The set editor (SetEditSheet), opened with the refused values. */
	| { kind: 'set-editor' }
	/** One tap: the change rewritten, under its id. */
	| { kind: 'rewrite'; label: string; rewrite: (m: Mutation) => Mutation }
	/** Discard is the only way out. */
	| { kind: 'discard-only' };

/** A type's Fix, and what Discard keeps or drops, in words. */
export type FixEntry = Fix & { discard: string };

/** A family module's entries: one per type it owns. */
export type FamilyFixes<T extends MutationType> = { readonly [K in T]: FixEntry };

type Family<T extends MutationType> = () => Promise<{ fixes: { readonly [K in T]: FixEntry } }>;

const workout = () => import('./workout.ts');
const sets = () => import('./sets.ts');
const structure = () => import('./structure.ts');
const exercises = () => import('./exercises.ts');
const pain = () => import('./pain.ts');
const run = () => import('./run.ts');
const other = () => import('./other.ts');

export const FIX_REGISTRY: { readonly [T in MutationType]: Family<T> } = {
	'workout.start': workout,
	'workout.update': workout,
	'workout.finish': workout,
	'workout.abandon': workout,
	'set.log': sets,
	'set.skip': sets,
	'set.edit': sets,
	'set.delete': sets,
	'exercise.skip': structure,
	'exercise.substitute': structure,
	'exercise.dislike': structure,
	'exercise.create': exercises,
	'pain.report': pain,
	'run.log': run,
	'run.segment': run,
	'other.log': other
};

/** What Fix offers for a change of this type. */
export async function fixFor<T extends MutationType>(type: T): Promise<FixEntry> {
	const { fixes } = await (FIX_REGISTRY[type] as Family<T>)();
	return fixes[type];
}
