/**
 * Train's Add session as a form action: the sheet posts its day, kind, time, effort, length and
 * reason as JSON through programAction (forms/program.ts), with the version it was opened on. The
 * program service (services/programs/add.ts) stays the authority: it checks the day, builds the
 * session and writes the next version, and what it refuses reaches the sheet as field errors (400)
 * or a conflict (409).
 *
 * - Today is the owner's (ownerToday), computed here on each request, never sent by the browser.
 * - An add never blocks on the week's findings: they come back in `warnings`, which the sheet
 *   need not wait for.
 *
 * Kept out of +page.server.ts so integration tests can run the action on a test transaction.
 */
import type { IsoDate } from '#lib/domain/calendar.ts';
import { programAction } from '#lib/server/forms/program.ts';
import { ownerToday } from '#lib/server/local-date.ts';
import { addSession, type EditAt } from '#lib/server/services/programs/index.ts';
import type { TrainingDeps } from '#lib/server/services/training/shared.ts';

export type AddDeps = Pick<TrainingDeps, 'db' | 'now'>;

/** Where an add applies: the version the sheet named (none is never current) and today. */
async function editAt(owner: string, payload: unknown, { db, now }: AddDeps): Promise<EditAt> {
	const named = (payload as { version?: unknown } | null | undefined)?.version;
	const today: IsoDate = await ownerToday(owner, now?.() ?? new Date(), { db });
	return { version: typeof named === 'number' ? named : Number.NaN, today };
}

/** The sheet's add actions, on the app's database unless `deps` names another. */
export function addActions(deps: AddDeps = {}) {
	return {
		/** Add a session to a planned week: the new version's number, its title and the week's findings. */
		addSession: programAction(async (owner, payload) => {
			const added = await addSession(owner, payload, await editAt(owner, payload, deps), deps);
			return {
				version: added.number,
				title: added.title,
				warnings: added.warnings.map(({ severity, message }) => ({ severity, message }))
			};
		})
	};
}
