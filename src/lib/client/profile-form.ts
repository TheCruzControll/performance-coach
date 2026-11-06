/**
 * Saving training-profile sections from the browser (the Profile edit screens and onboarding).
 *
 * - Validation uses the SAME zod schemas as the services (src/lib/domain/profile/schemas.ts).
 *   They load on demand — `warmValidation()` on idle after the screen is interactive — so no
 *   route pays for a validator in its initial JavaScript (`pnpm budgets` fails if one does), and
 *   the first submit is still instant.
 * - Saving posts the section as JSON to a form action of the current page (same-origin, so the
 *   server's CSRF Origin check passes). The server validates again and stays the authority
 *   (src/lib/server/forms/profile.ts).
 */
import { applyAction, deserialize, type ActionResult } from '$app/forms';
import type { FieldErrors, SchemaName } from '#lib/domain/profile/schemas.ts';

const loadSchemas = () => import('#lib/domain/profile/schemas.ts');

const UNREACHABLE = 'Can’t reach the server. Check your connection.';
const NOT_SAVED = 'That didn’t save. Try again.';

let warmed = false;
/** Fetch the validation chunk once the browser is idle (call from onMount). */
export function warmValidation(): void {
	if (warmed || typeof window === 'undefined') return;
	warmed = true;
	const go = () => void loadSchemas().catch(() => {}); // retried by the first check()
	if ('requestIdleCallback' in window) requestIdleCallback(go, { timeout: 2000 });
	else setTimeout(go, 800);
}

/** Validate a section; `null` when valid, otherwise field path → message. */
export async function check(name: SchemaName, value: unknown): Promise<FieldErrors | null> {
	const { SCHEMAS, validate } = await loadSchemas();
	const result = validate(SCHEMAS[name], value);
	return result.ok ? null : result.errors;
}

/** POST `payload` as JSON to a form action of the current page (e.g. `?/save`). */
export async function post(
	action: string,
	payload?: unknown,
	fields: Record<string, string> = {}
): Promise<ActionResult> {
	const body = new FormData();
	if (payload !== undefined) body.set('payload', JSON.stringify(payload));
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	const response = await fetch(action, {
		method: 'POST',
		body,
		headers: { accept: 'application/json', 'x-sveltekit-action': 'true' }
	});
	return deserialize(await response.text());
}

export interface SaveOutcome<T = Record<string, unknown>> {
	ok: boolean;
	errors: FieldErrors;
	/** Data returned by a successful action. */
	data?: T;
	/** A failure that is not about one field: the network, the server, a record that is gone. */
	failed?: string;
}

/**
 * What a form action's result means for the form: validation failures are field errors, any
 * other failure is a message, and a redirect (the next onboarding step) counts as saved.
 */
export function toOutcome<T = Record<string, unknown>>(result: ActionResult): SaveOutcome<T> {
	switch (result.type) {
		case 'success':
			return { ok: true, errors: {}, data: result.data as T };
		case 'redirect':
			return { ok: true, errors: {} };
		case 'failure': {
			const errors = (result.data?.errors ?? {}) as FieldErrors;
			if (Object.keys(errors).length) return { ok: false, errors };
			const message: unknown = result.data?.message;
			return { ok: false, errors: {}, failed: typeof message === 'string' ? message : NOT_SAVED };
		}
		case 'error':
			return { ok: false, errors: {} };
	}
}

/**
 * Validate, then save. Redirects (the next onboarding step, an expired session) and server
 * errors are handed to SvelteKit; validation failures come back as field errors.
 */
export async function save<T = Record<string, unknown>>(
	action: string,
	payload: unknown,
	schema?: SchemaName,
	fields?: Record<string, string>
): Promise<SaveOutcome<T>> {
	if (schema) {
		// When the validation chunk cannot load, post anyway: the server validates too.
		const errors = await check(schema, payload).catch(() => null);
		if (errors) return { ok: false, errors };
	}
	let result: ActionResult;
	try {
		result = await post(action, payload, fields);
	} catch {
		return { ok: false, errors: {}, failed: UNREACHABLE };
	}
	if (result.type === 'redirect' || result.type === 'error') await applyAction(result);
	return toOutcome<T>(result);
}

/** Focus the first invalid control after errors render (keyboard and screen-reader users). */
export function focusFirstError(root: ParentNode = document): void {
	requestAnimationFrame(() => {
		const el = root.querySelector<HTMLElement>('[aria-invalid="true"], .invalid input');
		el?.focus({ preventScroll: false });
	});
}
