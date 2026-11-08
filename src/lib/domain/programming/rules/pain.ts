/**
 * What 'This hurts' offers instead of the exercise (PRD §8; m4-plan open question 7: a coaching
 * judgement the owner reviews). ../pain.ts applies them; the area's exclusions themselves are
 * M3's INJURY_EXCLUSIONS (../avoidance.ts), so what an area rules out has one definition.
 *
 * Each rule is data with its rationale, so a coaching change is a value here, not code.
 */
import type { Equipment, Severity } from '../../profile/catalog.ts';
import type { ExerciseTag } from '../../training/vocabulary.ts';

export interface PainRule<T> {
	value: T;
	/** Why, for the owner's review. */
	rationale: string;
}

export interface PainRules {
	/** The area is treated as an injury of this severity: what it rules out is never offered. */
	severity: PainRule<Severity>;
	/** Whether an option may never be harder to do than the exercise it replaces. */
	noHarder: PainRule<boolean>;
	/** Tags that load the body hardest: options with fewer of them rank first. */
	loadTags: PainRule<readonly ExerciseTag[]>;
	/** Equipment that guides the movement: options that use it rank first, after load. */
	supportedEquipment: PainRule<readonly Equipment[]>;
	/** The options offered per area, best first. */
	limit: PainRule<number>;
}

export const PAIN_RULES: PainRules = {
	severity: {
		value: 'moderate',
		rationale:
			'Mid-session the coach cannot tell how bad it is. A moderate injury leaves out what loads the area hardest (overhead work for a shoulder, deep knee bends and landings for a knee, spinal loading for a lower back) and still keeps enough to finish the session; stopping is always offered first.'
	},
	noHarder: {
		value: true,
		rationale: 'Pain is a reason to make the work simpler, never to learn a harder movement.'
	},
	loadTags: {
		value: ['spinal_loading', 'high_impact', 'explosive'],
		rationale: 'Less axial load and less impact give a sore area the least to absorb.'
	},
	supportedEquipment: {
		value: ['machines', 'cables'],
		rationale: 'A machine or cable fixes the path and takes balance out of it.'
	},
	limit: {
		value: 3,
		rationale:
			'A short list reads at a glance when something hurts, and keeps the saved start kit small.'
	}
};

/** What an option is gentler by, as the kit's reasons read it. */
export const GENTLER_WORDS = {
	simpler: 'Simpler to do',
	lessLoad: 'Less load and impact',
	supported: 'Guided by a machine or cable'
} as const;
