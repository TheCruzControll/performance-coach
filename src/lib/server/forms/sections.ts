/**
 * The training-profile sections Profile edits at /profile/[section]: how each one loads and
 * saves through the services. The route has no param matcher (a matcher would cost every
 * route's initial JS, docs/performance.md), so a key that is not listed here is a 404.
 *
 * Keys match the list Profile shows (src/lib/ui/profile/sections.ts) and the editors the screen
 * loads (src/lib/ui/profile/editors.ts); tests/integration/profile/edit-route.test.ts keeps the
 * three in step.
 */
import { error } from '@sveltejs/kit';
import {
	getAthleteProfile,
	getBody,
	getEquipment,
	getOnboarding,
	saveBody,
	saveEquipment,
	type ProfileDeps
} from '../services/profile';
import type { SaveSection } from './profile';

export interface ProfileSection {
	/** What the section's editor starts from. */
	load: (owner: string, deps?: ProfileDeps) => Promise<unknown>;
	save: SaveSection;
}

const SECTIONS: Record<string, ProfileSection> = {
	equipment: { load: getEquipment, save: saveEquipment },
	body: { load: getBody, save: saveBody }
};

export const SECTION_KEYS = Object.keys(SECTIONS);

/** The section for a URL segment; anything else (`constructor` included) is a 404. */
export function profileSection(key: string): ProfileSection {
	if (!Object.hasOwn(SECTIONS, key)) error(404, 'Not found');
	return SECTIONS[key]!;
}

/**
 * What every section editor is told about the athlete: the disciplines in play and units. The
 * reads take turns, as `deps` may hand both one transaction (docs/architecture.md).
 */
export async function sectionContext(owner: string, deps: ProfileDeps = {}) {
	const onboarding = await getOnboarding(owner, deps);
	const profile = await getAthleteProfile(owner, deps);
	return {
		disciplines: onboarding.disciplines,
		units: { weight: profile.weightUnit, distance: profile.distanceUnit }
	};
}
