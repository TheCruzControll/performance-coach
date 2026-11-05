/**
 * Saving training-profile forms from the browser.
 *
 * - Validation uses the SAME zod schemas as the services (src/lib/domain/profile/schemas.ts).
 *   They load on demand — `warmValidation()` on idle after the screen is interactive — so no
 *   route pays for a validator in its initial JavaScript, and the first submit is still instant.
 * - Saving posts the section as JSON to the page's form action (same-origin, so the server's
 *   CSRF Origin check passes) and returns SvelteKit's action result; the server validates again
 *   and stays the authority.
 */
import { applyAction, deserialize, type ActionResult } from '$app/forms';
import type { FieldErrors, SchemaName } from '#lib/domain/profile/schemas.ts';

const loadSchemas = () => import('#lib/domain/profile/schemas.ts');

let warmed = false;
/** Fetch the validation chunk once the browser is idle (call from onMount). */
export function warmValidation(): void {
	if (warmed || typeof window === 'undefined') return;
	warmed = true;
	const go = () => void loadSchemas();
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
	/** A network or server failure (not the owner's input). */
	failed?: string;
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
		const errors = await check(schema, payload);
		if (errors) return { ok: false, errors };
	}
	let result: ActionResult;
	try {
		result = await post(action, payload, fields);
	} catch {
		return { ok: false, errors: {}, failed: 'Can’t reach the server. Check your connection.' };
	}
	if (result.type === 'failure') {
		const errors = (result.data?.errors as FieldErrors | undefined) ?? {};
		const message = result.data?.message as string | undefined;
		return { ok: false, errors, failed: Object.keys(errors).length ? undefined : message };
	}
	if (result.type === 'success') return { ok: true, errors: {}, data: result.data as T };
	await applyAction(result);
	return { ok: result.type === 'redirect', errors: {} };
}

/** Errors under `prefix.` re-keyed relative to it (for a nested editor). */
export function scoped(errors: FieldErrors, prefix: string): FieldErrors {
	const out: FieldErrors = {};
	for (const [key, message] of Object.entries(errors)) {
		if (key === prefix) out[''] = message;
		else if (key.startsWith(`${prefix}.`)) out[key.slice(prefix.length + 1)] = message;
	}
	return out;
}

/** Focus the first invalid control after errors render (keyboard and screen-reader users). */
export function focusFirstError(root: ParentNode = document): void {
	requestAnimationFrame(() => {
		const el = root.querySelector<HTMLElement>('[aria-invalid="true"], .invalid input');
		el?.focus({ preventScroll: false });
	});
}
