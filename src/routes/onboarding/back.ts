import { goto } from '$app/navigation';
import type { SectionForm } from '#lib/client/section-form.svelte.ts';

/**
 * Back from a step: save what changed first (save-as-you-go; the step is not marked done), and
 * go back even when the half-filled step can't be saved yet.
 */
export async function saveAndGoBack<T>(form: SectionForm<T>, href: string): Promise<void> {
	if (form.dirty) {
		const outcome = await form.submit('?/save', { then: 'back' });
		if (outcome.ok) return;
	}
	// eslint-disable-next-line svelte/no-navigation-without-resolve -- callers pass resolve()d paths
	await goto(href);
}
