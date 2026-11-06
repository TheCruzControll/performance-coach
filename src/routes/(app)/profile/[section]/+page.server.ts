import { error, type RequestEvent } from '@sveltejs/kit';
import {
	deleteGoalAction,
	editAction,
	ownerId,
	reorderGoalsAction,
	saveGoalAction
} from '#lib/server/forms/profile.ts';
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
	// A section saved as a whole has a Save bar; one whose every change saves itself has none.
	const saveBar = section.save !== undefined;
	return { key: info.key, title: info.title, saved, context, saveBar };
};

/** Goal actions exist on the goals section only. */
const goals =
	<T>(action: (event: RequestEvent) => T) =>
	(event: RequestEvent) => {
		if (event.params.section !== 'goals') error(404, 'Not found');
		return action(event);
	};

export const actions: Actions = {
	save: (event) => {
		const { save } = profileSection(event.params.section);
		if (!save) error(404, 'Not found');
		return editAction(save)(event);
	},
	saveGoal: goals(saveGoalAction),
	deleteGoal: goals(deleteGoalAction),
	reorderGoals: goals(reorderGoalsAction)
};
