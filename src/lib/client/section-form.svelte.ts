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

	/** A new form at the last saved value: what is left once the edits are discarded. */
	reverted(): SectionForm<T> {
		return new SectionForm(JSON.parse(this.#saved) as T, this.#schema, this.#toPayload);
	}

	/**
	 * Validate and post to `action`; redirects (the next step) are followed. `quiet` is for
	 * leaving the form: a failure is only returned, never shown or focused.
	 */
	async submit(
		action = '?/save',
		fields?: Record<string, string>,
		options: { validate?: boolean; quiet?: boolean } = {}
	): Promise<SaveOutcome> {
		if (this.busy) return { ok: false, errors: {} };
		this.busy = true;
		if (!options.quiet) this.failed = null;
		// What is sent: edits made while the request is in flight stay unsaved. A JSON copy, as
		// the section is posted and compared as JSON: `$state.snapshot` would add its clone
		// helper to the Svelte runtime that every route loads.
		const value = JSON.parse(JSON.stringify(this.value)) as T;
		try {
			const outcome = await save(
				action,
				this.#toPayload(value),
				options.validate === false ? undefined : this.#schema,
				fields
			);
			if (outcome.ok) this.#saved = JSON.stringify(value);
			if (options.quiet) return outcome;
			const fieldCount = Object.keys(outcome.errors).length;
			this.errors = outcome.errors;
			this.failed =
				outcome.failed ??
				outcome.errors[''] ??
				(fieldCount ? 'Check the highlighted fields.' : null);
			if (!outcome.ok && fieldCount) focusFirstError();
			return outcome;
		} finally {
			this.busy = false;
		}
	}
}
