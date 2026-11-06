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
	/** The last saved value, serialized (what `dirty` compares against). */
	#saved = $state('');
	readonly #schema: SchemaName | undefined;
	readonly #toPayload: (value: T) => unknown;

	/**
	 * @param toPayload maps the editing state to what the schema validates (e.g. "1:45:30" →
	 *   seconds). Keep array positions 1:1 so error paths still point at the right field.
	 */
	constructor(initial: T, schema?: SchemaName, toPayload: (value: T) => unknown = (v) => v) {
		this.value = initial;
		this.#saved = JSON.stringify(initial);
		this.#schema = schema;
		this.#toPayload = toPayload;
	}

	get dirty(): boolean {
		return JSON.stringify(this.value) !== this.#saved;
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
		// What is sent: edits made while the request is in flight stay unsaved.
		const value = $state.snapshot(this.value) as T;
		try {
			const outcome = await save(
				action,
				this.#toPayload(value),
				options.validate === false ? undefined : this.#schema,
				fields
			);
			const fieldCount = Object.keys(outcome.errors).length;
			this.errors = outcome.errors;
			this.failed =
				outcome.failed ??
				outcome.errors[''] ??
				(fieldCount ? 'Check the highlighted fields.' : null);
			if (outcome.ok) this.#saved = JSON.stringify(value);
			else if (fieldCount) focusFirstError();
			return outcome;
		} finally {
			this.busy = false;
		}
	}
}
