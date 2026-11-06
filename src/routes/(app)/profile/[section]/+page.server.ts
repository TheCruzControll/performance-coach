import { error } from '@sveltejs/kit';
import { editAction, ownerId } from '#lib/server/forms/profile.ts';
import { profileSection, sectionContext } from '#lib/server/forms/sections.ts';
import { SECTIONS } from '#lib/ui/profile/sections.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * Profile → one training-profile section. The route has no param matcher: a key that is not a
 * section is a 404 from the load and from the action, which costs no route any JavaScript.
 */
export const load: PageServerLoad = async ({ locals, params }) => {
	const section = profileSection(params.section);
	const info = SECTIONS.find((s) => s.key === params.section);
	if (!info) error(404, 'Not found');
	const owner = ownerId(locals);
	const [saved, context] = await Promise.all([section.load(owner), sectionContext(owner)]);
	return { key: info.key, title: info.title, saved, context };
};

export const actions: Actions = {
	save: (event) => editAction(profileSection(event.params.section).save)(event)
};
