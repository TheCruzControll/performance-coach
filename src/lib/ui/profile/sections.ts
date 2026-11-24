/**
 * The training-profile sections Profile lists, each edited at /profile/[section]: its key, its
 * title, the group Profile shows it in, and the lede a few show under their title. Words only:
 * the editors load on demand through ./editors.ts, so the Profile screen carries none of them.
 *
 * The keys match the server's sections (src/lib/server/forms/sections.ts) and the editors;
 * tests/integration/profile/edit-route.test.ts keeps the three in step.
 */

export interface SectionInfo {
	key: string;
	title: string;
	group: 'you' | 'training';
	/** The line under the section's title, shown with it as soon as the screen renders. */
	lede?: string;
}

export const SECTIONS = [
	{ key: 'goals', title: 'Goals', group: 'you' },
	{ key: 'basics', title: 'Name and units', group: 'you' },
	{ key: 'body', title: 'Body and nutrition', group: 'you' },
	{ key: 'injuries', title: 'Injuries', group: 'you', lede: 'What your coach plans around.' },
	{ key: 'schedule', title: 'Schedule', group: 'training' },
	{ key: 'equipment', title: 'Equipment', group: 'training' },
	{
		key: 'strength',
		title: 'Strength',
		group: 'training',
		lede: 'Your best lifts. Add only what you know.'
	},
	{
		key: 'experience',
		title: 'Experience',
		group: 'training',
		lede: 'Your level in each thing you train.'
	},
	{ key: 'specifics', title: 'Running and Muay Thai', group: 'training' },
	{ key: 'exercises', title: 'Exercises you like and avoid', group: 'training' }
] as const satisfies readonly SectionInfo[];

export type SectionKey = (typeof SECTIONS)[number]['key'];

/** Profile's groups of sections, in order, each with its heading. */
export const SECTION_GROUPS = [
	{ id: 'you', title: 'You' },
	{ id: 'training', title: 'Training' }
] as const satisfies readonly { id: SectionInfo['group']; title: string }[];

export const sectionsIn = (group: SectionInfo['group']) =>
	SECTIONS.filter((s) => s.group === group);
