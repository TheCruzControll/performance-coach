/**
 * The editors the edit screen (/profile/[section]) loads on demand, by section key. Each entry
 * imports a section's editor and the helper that builds its editing state from what the route
 * loaded. Only the edit route imports this file, so no other screen carries an editor, and no
 * editor is part of the route's initial JavaScript (docs/performance.md).
 */
import type { Component } from 'svelte';
import type { Discipline } from '#lib/domain/profile/catalog.ts';
import type { FieldErrors, SchemaName } from '#lib/domain/profile/schemas.ts';
import type { AthleteProfile } from '#lib/domain/profile/types.ts';
import type { SectionKey } from './sections';

/** What every editor is told about the athlete (from the edit route's load). */
export interface SectionContext {
	disciplines: Discipline[];
	units: { weight: AthleteProfile['weightUnit']; distance: AthleteProfile['distanceUnit'] };
}

/** Every editor's props: the state it edits (bound), field errors by dotted path, context. */
export interface EditorProps<T> {
	value: T;
	errors?: FieldErrors;
	context: SectionContext;
}

/** One section, ready to edit. */
export interface SectionEditor {
	Editor: Component<EditorProps<unknown>>;
	/** The editing state, built from what the section's load returned. */
	draft(saved: unknown): unknown;
	/** The schema the browser checks before posting (the services check it again). */
	schema: SchemaName;
}

/**
 * An editor and its draft, checked against each other here and stored without their type: the
 * screen only ever hands a draft back to the editor it was built for.
 */
function section<T>(
	Editor: Component<EditorProps<T>>,
	draft: (saved: never) => T,
	schema: SchemaName
): SectionEditor {
	return { Editor: Editor as unknown as SectionEditor['Editor'], draft, schema };
}

export const EDITORS: Record<SectionKey, () => Promise<SectionEditor>> = {
	equipment: () =>
		Promise.all([import('./EquipmentEditor.svelte'), import('./equipment')]).then(
			([editor, { equipmentDraft }]) => section(editor.default, equipmentDraft, 'equipment')
		)
};
