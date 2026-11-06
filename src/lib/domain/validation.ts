/**
 * Running a shared zod/mini schema: the one way forms and services report what is wrong, as
 * field errors keyed by dotted path. It holds no schema itself, so a lazily loaded editor that
 * validates with the training schemas does not also carry every profile schema.
 *
 * Not re-exported from src/lib/domain/index.ts: it imports zod, which stays out of every page's
 * initial JavaScript.
 */
import * as z from 'zod/mini';

/** Field path → first message, e.g. `{ 'entries.0.level': 'Pick your level' }`. */
export type FieldErrors = Record<string, string>;

export type Validated<T> = { ok: true; data: T } | { ok: false; errors: FieldErrors };

/** Validate with a shared schema; errors keyed by dotted path (root errors under `''`). */
export function validate<S extends z.ZodMiniType>(
	schema: S,
	input: unknown
): Validated<z.output<S>> {
	const result = z.safeParse(schema, input);
	if (result.success) return { ok: true, data: result.data };
	const errors: FieldErrors = {};
	for (const issue of result.error.issues) {
		const key = issue.path.map(String).join('.');
		errors[key] ??= issue.message;
	}
	return { ok: false, errors };
}
