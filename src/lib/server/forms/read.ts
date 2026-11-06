/**
 * Reading a form action's request, for every screen that saves: who sent it, and what it says.
 * A screen posts its state as JSON in a `payload` field (src/lib/client/profile-form.ts), and the
 * services validate it again. The Profile forms (profile.ts) and the program forms (program.ts)
 * each map their own services' failures.
 */
import { error, type RequestEvent } from '@sveltejs/kit';

/** What a form action reads from its request (any route's RequestEvent is one). */
export type FormEvent = Pick<RequestEvent, 'locals' | 'request'>;

const UNREADABLE = 'The form could not be read. Reload and try again.';

/** The signed-in owner (the auth guard already refused anyone else; this is the second lock). */
export function ownerId(locals: App.Locals): string {
	if (!locals.session || locals.session.kind !== 'owner') error(401, 'Sign in to continue.');
	return locals.session.ownerId;
}

/** The form's JSON `payload` (`undefined` when the field is absent or blank); 400 if unreadable. */
export async function readForm(request: Request): Promise<{ payload: unknown }> {
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
