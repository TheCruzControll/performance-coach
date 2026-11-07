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

/**
 * The form's JSON `payload` (`undefined` when the field is absent or blank) and its `then` field,
 * where to go once it is saved (onboarding's Back and Finish later); 400 if unreadable.
 */
export async function readForm(
	request: Request
): Promise<{ payload: unknown; then: string | undefined }> {
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		error(400, UNREADABLE);
	}
	const raw = form.get('payload');
	const then = form.get('then');
	const rest = { then: typeof then === 'string' ? then : undefined };
	if (typeof raw !== 'string' || raw === '') return { payload: undefined, ...rest };
	try {
		return { payload: JSON.parse(raw), ...rest };
	} catch {
		error(400, UNREADABLE);
	}
}
