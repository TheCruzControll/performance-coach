/**
 * Profile → Name & units (and onboarding's welcome step, which uses the same editor): what the
 * coach calls the athlete and the units it plans in. The editing state is exactly what the
 * basics schema validates. It leaves the time zone out, so a save keeps the saved one.
 */
import { preferences } from '#lib/client/preferences.svelte.ts';
import type { BasicsInput } from '#lib/domain/profile/schemas.ts';
import type { AthleteProfile } from '#lib/domain/profile/types.ts';

export function basicsDraft(saved: AthleteProfile): BasicsInput {
	return { name: saved.name, weightUnit: saved.weightUnit, distanceUnit: saved.distanceUnit };
}

/**
 * Once saved, this device shows weights and distances in the coach's units too. Its own switch
 * stays on Profile (Preferences, "This device") for a device the owner wants otherwise.
 */
export function deviceFollows(saved: BasicsInput): void {
	preferences.setUnits(saved.weightUnit);
	preferences.setDistance(saved.distanceUnit);
}
