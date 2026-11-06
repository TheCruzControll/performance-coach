/**
 * The editors the edit screen (/profile/[section]) loads on demand, by section key. Each entry
 * imports a section's editor and the helper that builds its editing state from what the route
 * loaded. Only the edit route imports this file, so no other screen carries an editor, and no
 * editor is part of the route's initial JavaScript (docs/performance.md).
 */
import type { Component } from 'svelte';
import type { Discipline } from '#lib/domain/profile/catalog.ts';
import type { FieldErrors, SchemaName } from '#lib/domain/profile/schemas.ts';
import type { AthleteProfile, Goal } from '#lib/domain/profile/types.ts';
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
	/** Profile: the section's whole story, such as a goal's status and past goals. */
	manage?: boolean;
}

/** One section, ready to edit. */
export interface SectionEditor {
	Editor: Component<EditorProps<unknown>>;
	/** The editing state, built from what the section's load returned and the context. */
	draft(saved: unknown, context: SectionContext): unknown;
	/** The schema the browser checks before posting (the services check it again). */
	schema: SchemaName;
	/** What is posted, when that is not the editing state as it stands (SectionForm). */
	payload?: (value: unknown) => unknown;
}

/**
 * An editor and its draft, checked against each other here and stored without their type: the
 * screen only ever hands a draft back to the editor it was built for.
 */
function section<T>(
	Editor: Component<EditorProps<T>>,
	draft: (saved: never, context: SectionContext) => T,
	schema: SchemaName,
	payload?: (value: T) => unknown
): SectionEditor {
	return {
		Editor: Editor as unknown as SectionEditor['Editor'],
		draft,
		schema,
		payload: payload as SectionEditor['payload']
	};
}

export const EDITORS: Record<SectionKey, () => Promise<SectionEditor>> = {
	// The goals as loaded: each goal is drafted in its own sheet, and saves on its own.
	goals: () =>
		import('./GoalsEditor.svelte').then((editor) =>
			section(editor.default, (goals: Goal[]) => goals, 'goal')
		),
	experience: () =>
		Promise.all([import('./ExperienceEditor.svelte'), import('./experience')]).then(
			([editor, { experienceDraft, experiencePayload }]) =>
				section(editor.default, experienceDraft, 'experience', experiencePayload)
		),
	equipment: () =>
		Promise.all([import('./EquipmentEditor.svelte'), import('./equipment')]).then(
			([editor, { equipmentDraft }]) => section(editor.default, equipmentDraft, 'equipment')
		),
	strength: () =>
		Promise.all([import('./BaselinesEditor.svelte'), import('./strength')]).then(
			([editor, { baselinesDraft, baselinesPayload }]) =>
				section(editor.default, baselinesDraft, 'baselines', baselinesPayload)
		)
};
