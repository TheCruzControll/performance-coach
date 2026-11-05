/**
 * State for one training-profile form (an onboarding step or a Profile edit screen): the
 * value being edited, field errors, a busy flag and whether anything changed. Saving validates
 * with the shared schema first (src/lib/client/profile-form.ts).
 */
import type { FieldErrors, SchemaName } from '#lib/domain/profile/schemas.ts';
import { focusFirstError, save, type SaveOutcome } from './profile-form';

export class SectionForm<T> {
	value: T = $state() as T;
	errors: FieldErrors = $state({});
	busy = $state(false);
	/** A message for the form as a whole (network, server, or a root-level rule). */
	failed: string | null = $state(null);
	#initial: string;
	readonly #schema: SchemaName | undefined;
	readonly #toPayload: (value: T) => unknown;

	/**
	 * @param toPayload maps the editing state to what the schema validates (e.g. "1:45:30" →
	 *   seconds). Keep array positions 1:1 so error paths still point at the right field.
	 */
	constructor(initial: T, schema?: SchemaName, toPayload: (value: T) => unknown = (v) => v) {
		this.value = initial;
		this.#initial = JSON.stringify(initial);
		this.#schema = schema;
		this.#toPayload = toPayload;
	}

	get dirty(): boolean {
		return JSON.stringify(this.value) !== this.#initial;
	}

	/** Validate and post to `action`; redirects (the next step) are followed. */
	async submit(
		action = '?/save',
		fields?: Record<string, string>,
		options: { validate?: boolean } = {}
	): Promise<SaveOutcome> {
		if (this.busy) return { ok: false, errors: {} };
		this.busy = true;
		this.failed = null;
		try {
			const outcome = await save(
				action,
				this.#toPayload(this.value),
				options.validate === false ? undefined : this.#schema,
				fields
			);
			this.errors = outcome.errors;
			this.failed =
				outcome.failed ??
				(Object.keys(outcome.errors).length ? 'Check the highlighted fields.' : null);
			if (outcome.ok) this.#initial = JSON.stringify(this.value);
			else if (Object.keys(outcome.errors).length) focusFirstError();
			return outcome;
		} finally {
			this.busy = false;
		}
	}
}
