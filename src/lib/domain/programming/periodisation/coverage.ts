/**
 * What M7's scenario fixtures cover (periodisation-scenarios): the PRD §2 and §5 examples S1–S12,
 * each with the sentence it comes from, and the named non-PRD cases the fixtures also prove. The
 * scenario suite's and the coach scenarios' coverage maps read this list and fail when an id has no
 * passing test. Later slices read it and never edit it.
 */

/** A PRD example the M7 brief names, with where it comes from and the PRD's own words. */
export interface PrdExample {
	title: string;
	section: '§2' | '§5';
	prd: string;
}

/** S1–S12: the PRD §2 multi-goal example and every §2 and §5 conflict and progression example. */
export const PRD_EXAMPLES = {
	S1: {
		title: 'The multi-goal example',
		section: '§2',
		prd: 'Multiple concurrent goals (e.g. Muay Thai fight + maintain strength + marathon + build muscle).'
	},
	S2: {
		title: 'Heavy squats before hard Muay Thai',
		section: '§5',
		prd: "Don't blindly schedule heavy squats right before hard Muay Thai."
	},
	S3: {
		title: 'High-volume legs before a long run',
		section: '§5',
		prd: "Don't blindly schedule high-volume legs before a long run."
	},
	S4: {
		title: 'Intervals after a very demanding day',
		section: '§5',
		prd: "Don't blindly schedule intense intervals right after a very demanding day."
	},
	S5: {
		title: 'A marathon taper with strength maintenance',
		section: '§5',
		prd: 'Marathon prep: structured blocks, progressive mileage, taper, race-specific workouts.'
	},
	S6: {
		title: 'Hypertrophy volume progression',
		section: '§5',
		prd: 'Hypertrophy: sets per muscle group, weekly volume, exercise selection, rep ranges, RPE, frequency, progression; manage hypertrophy blocks; adjust volume from results and recovery.'
	},
	S7: {
		title: 'A reactive deload after declining performance',
		section: '§5',
		prd: 'Declining performance → consider fatigue.'
	},
	S8: {
		title: 'A priority swap mid-block',
		section: '§2',
		prd: 'Goals and priorities change over time; the coach knows which goal wins when demands conflict.'
	},
	S9: {
		title: 'High running volume against leg recovery',
		section: '§2',
		prd: 'High running volume vs. lower-body lifting recovery.'
	},
	S10: {
		title: 'Hard Muay Thai adds fatigue',
		section: '§2',
		prd: 'Hard Muay Thai sessions add fatigue.'
	},
	S11: {
		title: 'Strength volume through marathon prep',
		section: '§2',
		prd: 'Strength volume changes during marathon prep.'
	},
	S12: {
		title: 'Hypertrophy is not competition prep',
		section: '§2',
		prd: 'Hypertrophy phase ≠ competition prep.'
	}
} as const satisfies Record<string, PrdExample>;

export type PrdExampleId = keyof typeof PRD_EXAMPLES;

/** The cases outside the PRD's examples that the fixtures prove, with what each is for. */
export const NAMED_CASES = {
	budget: 'The longest season stays inside the plan budget (blocks and decisions).',
	maintenance: 'An off-season with no event plans a maintenance block that holds every goal.',
	paused: "Every goal paused plans M3's all-goals-paused maintenance, unchanged.",
	journey: "The Playwright journey's exact profile, so its first week is pinned in the domain."
} as const;

export type NamedCaseId = keyof typeof NAMED_CASES;

/** Every id a fixture can cover. */
export type CoverageId = PrdExampleId | NamedCaseId;

/** Every coverage id, S1–S12 first, then the named cases. */
export const COVERAGE_IDS = [
	...(Object.keys(PRD_EXAMPLES) as PrdExampleId[]),
	...(Object.keys(NAMED_CASES) as NamedCaseId[])
] as const satisfies readonly CoverageId[];
