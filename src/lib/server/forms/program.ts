/**
 * Form actions for the program screens (M3: the session edits, Build my program): the owner
 * check and JSON payload of every form (read.ts), then the training services' failures as what
 * the screen shows. The services stay the authority and validate the payload again. The mapping
 * knows only the shared errors (services/training/shared.ts), never which service threw:
 * - TrainingInputError → `fail(400, { errors })`, keyed by dotted field path
 * - any ConflictError → `fail(409, { reason })`: the screen picks its copy by reason ('version'
 *   for an edit made on an older version, 'program_exists', the generator's own reasons)
 * - TrainingNotFoundError → `fail(404, { message })`
 * Anything else is rethrown, for handleError to record as the server's error.
 */
import { error, fail } from '@sveltejs/kit';
import {
	ConflictError,
	TrainingInputError,
	TrainingNotFoundError
} from '../services/training/shared';
import { ownerId, readForm, type FormEvent } from './read';

/** A program change run for the signed-in owner with what the form posted. */
export type ProgramChange<T> = (owner: string, payload: unknown) => Promise<T>;

const GONE = 'That no longer exists. Reload to see the latest.';

/** Run a change; the owner's input errors, conflicts and missing records become form failures. */
async function attempt<T>(change: () => Promise<T>) {
	try {
		return { ok: true as const, value: await change() };
	} catch (err) {
		if (err instanceof TrainingInputError) {
			return { ok: false as const, failure: fail(400, { errors: err.errors }) };
		}
		if (err instanceof ConflictError) {
			return { ok: false as const, failure: fail(409, { reason: err.reason }) };
		}
		if (err instanceof TrainingNotFoundError) {
			return { ok: false as const, failure: fail(404, { message: GONE }) };
		}
		throw err;
	}
}

/**
 * A program screen's action whose form posts plain fields (no `payload`), so it works before
 * JavaScript runs: run `change` with them, then return its result or the failure.
 */
export function programFieldsAction<T>(change: (owner: string, form: FormData) => Promise<T>) {
	return async ({ locals, request }: FormEvent) => {
		const owner = ownerId(locals);
		let form: FormData;
		try {
			form = await request.formData();
		} catch {
			error(400, 'The form could not be read. Reload and try again.');
		}
		const result = await attempt(() => change(owner, form));
		return result.ok ? result.value : result.failure;
	};
}

/** A program screen's action: run `change`, then return its result or the failure. */
export function programAction<T>(change: ProgramChange<T>) {
	return async ({ locals, request }: FormEvent) => {
		const owner = ownerId(locals);
		const { payload } = await readForm(request);
		const result = await attempt(() => change(owner, payload));
		return result.ok ? result.value : result.failure;
	};
}
