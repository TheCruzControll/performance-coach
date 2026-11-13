/**
 * The 'not told yet' defaults (PRD §2, §3). A complete M2 profile needs only one goal and
 * daysPerWeek, so anything else may be missing. buildProgrammingInput (../input.ts) fills each gap
 * from this table and lists every default it applied as an assumption; m3/13 turns each one into
 * a default_assumed decision whose 'why' is the row's words (assumptionFacts below): what was
 * missing, what was assumed, why that is a safe start, and where in Profile to say otherwise.
 *
 * The values live here and nowhere else, so changing one, such as the equipment default the owner
 * may want as bodyweight only (m3-plan open question), is a one-line edit. Each later generator
 * stage keeps its own numbers in its own rules/<area>.ts.
 */
import { DISCIPLINE_INFO } from '../../profile/catalog.ts';
import type { Discipline, Equipment, GymType } from '../../profile/catalog.ts';
import { STEP_INFO } from '../../profile/onboarding.ts';
import type { OnboardingStep } from '../../profile/onboarding.ts';
import type { Assumption, ProgrammingInput } from '../input.ts';

export interface DefaultRule {
	/** What it fills in. */
	value: number | string;
	/** Minutes by discipline, where one differs from `value`. */
	byDiscipline?: Partial<Record<Discipline, number>>;
	/** Where the owner says otherwise: the Profile section (an onboarding step). */
	section: OnboardingStep;
	/** What the coach was not told, as a sentence. `{subject}` names a commitment or discipline. */
	missing: string;
	/** What it assumed, read after 'Assumed'. `{value}` is the value filled in. */
	assumed: string;
	/** Why it is a safe start. */
	rationale: string;
}

/** Keyed by the rule key's last part: `defaults.session_minutes`. Assumptions follow this order. */
export const DEFAULTS = {
	available_days: {
		value: 'every_day',
		section: 'schedule',
		missing: 'You haven’t said which days you can train.',
		assumed: 'any day of the week',
		rationale: 'With no day ruled out, each session can go where it recovers best.'
	},
	preferred_times: {
		value: 'none',
		section: 'schedule',
		missing: 'You haven’t said when in the day you train.',
		assumed: 'no set time of day',
		rationale:
			'Sessions on a day of their own get no time. Beside a class with a set time, a session goes at the other end of the day: a morning before an evening class.'
	},
	session_minutes: {
		value: 60,
		section: 'schedule',
		missing: 'You haven’t said how long a session can be.',
		assumed: '{value}-minute sessions',
		rationale: 'An hour fits a strength session with its warm-up and rests, as onboarding suggests.'
	},
	commitment_intensity: {
		value: 'moderate',
		section: 'schedule',
		missing: 'You haven’t said how hard {subject} is.',
		assumed: '{value} intensity for {subject}',
		rationale:
			'Moderate is the middle, so the days around it are planned neither too softly nor too hard.'
	},
	commitment_minutes: {
		value: 60,
		byDiscipline: { muay_thai: 90 },
		section: 'schedule',
		missing: 'You haven’t said how long {subject} lasts.',
		assumed: '{value} minutes for {subject}',
		rationale: 'Most classes run for an hour, and Muay Thai classes usually run for 90 minutes.'
	},
	equipment: {
		value: 'commercial',
		section: 'equipment',
		missing: 'You haven’t said where you train or what is there.',
		assumed: 'a commercial gym',
		rationale:
			'It is where most people train: racks, barbells, benches, dumbbells, cables and machines. Nothing needing more is prescribed.'
	},
	experience: {
		value: 'new',
		section: 'experience',
		missing: 'You haven’t said your experience in {subject}.',
		assumed: 'you are new to {subject}',
		rationale:
			'Starting as new keeps week 1 simple and safe; the weeks after it adjust to what you log.'
	},
	running_volume: {
		value: 'time_based',
		section: 'specifics',
		missing: 'You haven’t said how much you run now.',
		assumed: 'runs set by time, not distance',
		rationale:
			'Running by time and effort is safe at any fitness, where a guessed distance may not be.'
	},
	muay_thai_sessions: {
		value: 'technical',
		section: 'specifics',
		missing: 'You haven’t said how you train Muay Thai, and no class is on your schedule.',
		assumed: 'technical Muay Thai sessions',
		rationale: 'Technical work builds skill without the impact of sparring or hard pad rounds.'
	},
	all_goals_paused: {
		value: 'maintenance',
		section: 'goals',
		missing: 'Every goal you have is paused.',
		assumed: 'maintenance training',
		rationale:
			'The coach keeps the fitness your paused goals need rather than building toward one on hold.'
	}
} as const satisfies Record<string, DefaultRule>;

export type DefaultKey = keyof typeof DEFAULTS;

/** A commitment's minutes when the owner gave none. */
export function defaultCommitmentMinutes(discipline: Discipline): number {
	const byDiscipline: Partial<Record<Discipline, number>> =
		DEFAULTS.commitment_minutes.byDiscipline;
	return byDiscipline[discipline] ?? DEFAULTS.commitment_minutes.value;
}

/**
 * What each M2 gym type is taken to have before the owner ticks anything (GYM_TYPE_INFO's hints).
 * The input's equipment is this ∪ what is ticked ∪ the home kit, so a preset only ever adds: each
 * lists only what nearly every gym of its type has, and anything else is one the owner ticks.
 */
export const GYM_PRESETS: Readonly<Record<GymType, readonly Equipment[]>> = {
	// Racks, machines, cables and dumbbells, with the cardio machines nearly every gym has.
	commercial: [
		'barbell',
		'squat_rack',
		'bench',
		'dumbbells',
		'kettlebells',
		'cables',
		'machines',
		'pull_up_bar',
		'treadmill',
		'rower',
		'bike'
	],
	// Platforms, calibrated plates and specialty bars, with the racks and benches around them.
	strength: [
		'barbell',
		'squat_rack',
		'bench',
		'platform',
		'dumbbells',
		'pull_up_bar',
		'specialty_bars'
	],
	// The owner's own rack and bar, with a bench.
	home: ['barbell', 'squat_rack', 'bench'],
	// Dumbbells, bands and a bench: a hotel gym or a travel kit.
	minimal: ['bench', 'dumbbells', 'bands'],
	// Bodyweight, outdoors or a Muay Thai gym: nothing is assumed.
	none: []
};

/**
 * The facts a default_assumed decision about `assumption` is given: the row's words with the
 * commitment or discipline named, the Profile section, and the field and value as evidence.
 */
export function assumptionFacts(assumption: Assumption, input: ProgrammingInput) {
	const rule: DefaultRule = DEFAULTS[assumption.ruleKey.slice('defaults.'.length) as DefaultKey];
	const [list, at = ''] = assumption.field.split('.');
	const subject =
		list === 'commitments'
			? (input.commitments[Number(at)]?.label ?? '')
			: list === 'experience'
				? (DISCIPLINE_INFO[at as Discipline]?.label ?? '')
				: '';
	const words = (text: string) =>
		text.replaceAll('{subject}', subject).replaceAll('{value}', String(assumption.value));
	return {
		field: assumption.field,
		value: assumption.value,
		missing: words(rule.missing),
		assumed: words(rule.assumed),
		rationale: rule.rationale,
		section: STEP_INFO[rule.section].title
	};
}
