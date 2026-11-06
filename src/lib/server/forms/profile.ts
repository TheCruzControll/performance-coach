/**
 * Form actions for the training profile, shared by the Profile edit screens and the onboarding
 * steps: both save through the same services (src/lib/server/services/profile), so a section
 * behaves the same wherever it is edited, and the same as when the coach edits it.
 *
 * A section posts its state as JSON in a `payload` field (src/lib/client/profile-form.ts). The
 * services validate it again and stay the authority: input the owner can fix becomes
 * `fail(400, { errors })` keyed by dotted field path, a record that no longer exists
 * `fail(404, { message })`.
 */
import { error, fail, type RequestEvent } from '@sveltejs/kit';
import { isProfileInputError, ProfileNotFoundError, type ProfileDeps } from '../services/profile';

/** What a form action reads from its request (any route's RequestEvent is one). */
export type FormEvent = Pick<RequestEvent, 'locals' | 'request'>;

/** A service function that saves one section, e.g. `saveEquipment`. */
export type SaveSection = (owner: string, payload: unknown, deps: ProfileDeps) => Promise<unknown>;

const UNREADABLE = 'The form could not be read. Reload and try again.';

/** The signed-in owner (the auth guard already refused anyone else; this is the second lock). */
export function ownerId(locals: App.Locals): string {
	if (!locals.session || locals.session.kind !== 'owner') error(401, 'Sign in to continue.');
	return locals.session.ownerId;
}

/** The section's JSON `payload` (`undefined` when the field is absent or blank). */
async function readForm(request: Request): Promise<{ payload: unknown }> {
	let raw: FormDataEntryValue | null;
	try {
		raw = (await request.formData()).get('payload');
	} catch {
		error(400, UNREADABLE);
	}
	if (typeof raw !== 'string' || raw === '') return { payload: undefined };
	try {
		return { payload: JSON.parse(raw) };
	} catch {
		error(400, UNREADABLE);
	}
}

/** Run a save; the owner's input errors and missing records become form failures. */
async function attempt<T>(save: () => Promise<T>) {
	try {
		return { ok: true as const, value: await save() };
	} catch (err) {
		if (isProfileInputError(err)) {
			return { ok: false as const, failure: fail(400, { errors: err.errors }) };
		}
		if (err instanceof ProfileNotFoundError) {
			const message = 'That no longer exists. Reload to see the latest.';
			return { ok: false as const, failure: fail(404, { message }) };
		}
		throw err;
	}
}

/**
 * A Profile edit screen's `save` action: store the section, then `{ saved: true, section }`
 * with the section as stored, which the screen edits from then on (a new injury's id, say).
 */
export function editAction(saveSection: SaveSection) {
	return async ({ locals, request }: FormEvent) => {
		const owner = ownerId(locals);
		const { payload } = await readForm(request);
		const result = await attempt(() => saveSection(owner, payload, { source: 'profile' }));
		if (!result.ok) return result.failure;
		return { saved: true as const, section: result.value };
	};
}
