/**
 * Editing state for Profile → Body & nutrition, built from what the services return (the
 * profile and the body-weight history, latest first), and what Save posts.
 */
import type { NutritionPhase } from '#lib/domain/profile/catalog.ts';
import type { BodyInput } from '#lib/domain/profile/schemas.ts';
import type { AthleteProfile, BodyWeightEntry } from '#lib/domain/profile/types.ts';
import { cleanFloat, convertWeight, type WeightUnit } from '#lib/domain/units.ts';

/** What the section loads (getBody). */
export interface BodySaved {
	profile: Pick<
		AthleteProfile,
		'weightUnit' | 'birthYear' | 'nutritionPhase' | 'targetWeight' | 'targetDate'
	> & {
		/** The unit the target was set in, which the owner may have changed since. */
		targetWeightUnit: WeightUnit | null;
	};
	bodyWeight: BodyWeightEntry[];
}

export interface BodyDraft {
	birthYear: number | null;
	weightUnit: WeightUnit;
	/** Today's weight in the owner's unit: the latest one recorded until they type another. */
	bodyWeight: number | null;
	/**
	 * The latest weight when it was recorded in the other unit: `bodyWeight` starts as it is
	 * `shown` converted, and is posted only once it differs. Never posted itself.
	 */
	recorded: { value: number; unit: WeightUnit; shown: number } | null;
	/** "Not focusing on it" is `none` on screen and no phase in the data. */
	nutritionPhase: NutritionPhase | 'none';
	targetWeight: number | null;
	targetDate: string | null;
}

export function bodyDraft({ profile, bodyWeight: history }: BodySaved): BodyDraft {
	const latest = history[0];
	const { weightUnit: unit, targetWeight: target, targetWeightUnit: targetUnit } = profile;
	// To the tenth a scale shows, with the domain's exact factors.
	const recorded =
		latest && latest.unit !== unit
			? {
					value: latest.value,
					unit: latest.unit,
					shown: cleanFloat(convertWeight(latest.value, latest.unit, unit), 1)
				}
			: null;
	return {
		birthYear: profile.birthYear,
		weightUnit: unit,
		bodyWeight: recorded?.shown ?? latest?.value ?? null,
		recorded,
		nutritionPhase: profile.nutritionPhase ?? 'none',
		// Converted too, as Save stores it in the owner's unit.
		targetWeight:
			target !== null && targetUnit !== null && targetUnit !== unit
				? cleanFloat(convertWeight(target, targetUnit, unit), 1)
				: target,
		targetDate: profile.targetDate
	};
}

/**
 * What the body schema validates. A converted weight the owner left as it was is not sent:
 * its rounding would otherwise record a new weigh-in that nobody made.
 */
export function bodyPayload({ recorded, ...draft }: BodyDraft): BodyInput {
	return {
		...draft,
		bodyWeight: recorded && draft.bodyWeight === recorded.shown ? null : draft.bodyWeight,
		nutritionPhase: draft.nutritionPhase === 'none' ? null : draft.nutritionPhase
	};
}
