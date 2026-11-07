/**
 * The session screen's edits as form actions: Move, the interference check its sheet runs
 * before saving, Swap, Adjust (a set prescription, a run segment or another session's details)
 * and Skip. Each posts its JSON payload through programAction (forms/program.ts), which maps
 * the services' refusals to what the sheet shows; the program services stay the authority.
 *
 * - A payload names the version the screen showed (`version`): the service writes only while it
 *   is still the current one, so an edit from a page left open is a 409 ('version'), never lost.
 * - Today is the owner's (ownerToday), computed here on each request, never sent by the browser.
 * - A move that breaks an interference rule goes ahead, with its warnings (BLOCKS_EDIT in
 *   domain/programming/interference.ts blocks none by default); checkMove gives the same
 *   warnings first and writes nothing.
 *
 * Kept out of +page.server.ts so integration tests can run the actions on a test transaction.
 */
import type { IsoDate } from '#lib/domain/calendar.ts';
import type { Severity } from '#lib/domain/programming/interference.ts';
import { programAction } from '#lib/server/forms/program.ts';
import { ownerToday } from '#lib/server/local-date.ts';
import {
	adjustPrescription,
	adjustRunSegment,
	adjustSessionDetails,
	checkMove,
	moveSession,
	skipSession,
	swapExercise,
	type EditAt,
	type RevisedVersion
} from '#lib/server/services/programs/index.ts';
import type { TrainingDeps } from '#lib/server/services/training/shared.ts';

export type EditDeps = Pick<TrainingDeps, 'db' | 'now'>;

/** A rule the move would newly break, as the sheet lists it before saving. */
export interface MoveWarningView {
	severity: Severity;
	/** One sentence naming its days and sessions. */
	message: string;
}

/** Where a posted edit applies: the version it names (none is never current) and today. */
async function editAt(owner: string, payload: unknown, { db, now }: EditDeps): Promise<EditAt> {
	const named = (payload as { version?: unknown } | null | undefined)?.version;
	const today: IsoDate = await ownerToday(owner, now?.() ?? new Date(), { db });
	return { version: typeof named === 'number' ? named : Number.NaN, today };
}

/** An edit service the screen posts to: it saves the next version. */
type VersionedEdit = (
	owner: string,
	input: unknown,
	at: EditAt,
	deps: EditDeps
) => Promise<RevisedVersion>;

/** The screen's edit actions, on the app's database unless `deps` names another. */
export function editActions(deps: EditDeps = {}) {
	/** An action that runs `edit` where the payload applies: the new version's number. */
	const versioned = (edit: VersionedEdit) =>
		programAction(async (owner, payload) => {
			const revised = await edit(owner, payload, await editAt(owner, payload, deps), deps);
			return { version: revised.number };
		});
	return {
		/** Move the session to another day of its week: the new version's number. */
		move: programAction(async (owner, payload) => {
			const moved = await moveSession(owner, payload, await editAt(owner, payload, deps), deps);
			return { version: moved.number };
		}),
		/** What the move would warn about, before it is saved; nothing is written. */
		checkMove: programAction(async (owner, payload) => {
			const warnings = await checkMove(owner, payload, await editAt(owner, payload, deps), deps);
			return {
				warnings: warnings.map(({ severity, message }): MoveWarningView => ({ severity, message }))
			};
		}),
		/** Swap an exercise for this session only, or never again: the new version's number. */
		swap: programAction(async (owner, payload) => {
			const swapped = await swapExercise(owner, payload, await editAt(owner, payload, deps), deps);
			return { version: swapped.number };
		}),
		/** Adjust one of a strength exercise's set prescriptions. */
		adjust: versioned(adjustPrescription),
		/** Adjust a run segment (repeats go to its whole repeat group). */
		adjustSegment: versioned(adjustRunSegment),
		/** Adjust another session's length and RPE. */
		adjustDetails: versioned(adjustSessionDetails),
		/** Skip the session, with an optional reason. */
		skip: versioned(skipSession)
	};
}
