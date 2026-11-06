/**
 * The training-profile sections Profile lists, each edited at /profile/[section]: its key, its
 * title, one line on what it holds and an icon from the shared set. Words only: the editors load
 * on demand through ./editors.ts, so the Profile screen carries none of them.
 *
 * The keys match the server's sections (src/lib/server/forms/sections.ts) and the editors;
 * tests/integration/profile/edit-route.test.ts keeps the three in step.
 */
import type { IconName } from '../icons/icons';

export interface SectionInfo {
	key: string;
	title: string;
	subtitle: string;
	icon: IconName;
}

export const SECTIONS = [
	{
		key: 'goals',
		title: 'Goals',
		subtitle: 'What you’re training for, in order',
		icon: 'target'
	},
	{
		key: 'experience',
		title: 'Experience',
		subtitle: 'Your level in each discipline',
		icon: 'progress'
	},
	{
		key: 'equipment',
		title: 'Equipment',
		subtitle: 'Where you train and what’s there',
		icon: 'plate'
	},
	{
		key: 'strength',
		title: 'Strength',
		subtitle: 'Your 1RMs, or let week one find them',
		icon: 'train'
	},
	{
		key: 'injuries',
		title: 'Injuries',
		subtitle: 'Limitations and movements to avoid',
		icon: 'shield'
	}
] as const satisfies readonly SectionInfo[];

export type SectionKey = (typeof SECTIONS)[number]['key'];
