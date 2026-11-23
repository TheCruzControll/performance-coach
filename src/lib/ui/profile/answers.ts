/**
 * Each Profile row's answer, the words at its end (Paper, 9 · Profile: "One list, and each row
 * shows its answer"): the number of open goals, the units, the latest weigh-in, an injury, days a
 * week, the gym, a lift, the level. Pure: Profile's layout load works them out on the server
 * (src/routes/(app)/profile/+layout.server.ts) and streams them to the list. Running and Muay
 * Thai, and Exercises, have none.
 */
import {
	BODY_AREA_LABEL,
	EXPERIENCE_LEVEL_INFO,
	GYM_TYPE_INFO,
	LIFT_LABEL,
	NUTRITION_PHASE_INFO,
	type Lift
} from '#lib/domain/profile/catalog.ts';
import type { Injury, TrainingProfile } from '#lib/domain/profile/types.ts';
import type { SectionKey } from './sections';
import { oneRepMax, trim } from './strength';

export type SectionAnswers = Partial<Record<SectionKey, string>>;

/** What Profile's list shows at each row's end: the sections' answers and the passkeys'. */
export interface ProfileAnswers {
	sections: SectionAnswers;
	passkeys: string;
}

/** The lift Strength names: the first of these the owner has, else the first they gave. */
const FIRST_LIFTS: readonly Lift[] = ['back_squat', 'bench_press', 'deadlift'];

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Left knee", "Lower back": the side only when it is one side. */
function injuryName(i: Pick<Injury, 'bodyArea' | 'side'>): string {
	const area = BODY_AREA_LABEL[i.bodyArea];
	if (i.side !== 'left' && i.side !== 'right') return area;
	return `${i.side === 'left' ? 'Left' : 'Right'} ${area.toLowerCase()}`;
}

/** The sections' answers; a section with nothing to say has none, and its row shows its title. */
export function sectionAnswers(t: TrainingProfile): SectionAnswers {
	const answers: SectionAnswers = {};

	const open = t.goals.filter((g) => g.priority !== null).length;
	answers.goals = open ? String(open) : 'None';

	answers.basics = `${t.profile.weightUnit}, ${t.profile.distanceUnit}`;

	const latest = t.bodyWeight.reduce<(typeof t.bodyWeight)[number] | undefined>(
		(last, entry) => (!last || entry.measuredOn > last.measuredOn ? entry : last),
		undefined
	);
	if (latest) answers.body = `${trim(latest.value)} ${latest.unit}`;
	else if (t.profile.nutritionPhase)
		answers.body = NUTRITION_PHASE_INFO[t.profile.nutritionPhase].label;

	const injuries = t.injuries.filter((i) => i.active);
	answers.injuries =
		injuries.length === 0
			? 'None'
			: injuries.length === 1
				? injuryName(injuries[0]!)
				: count(injuries.length, 'injury', 'injuries');

	const days = t.schedule.daysPerWeek ?? (t.schedule.availableDays.length || null);
	if (days) answers.schedule = count(days, 'day', 'days');

	if (t.equipment?.gymType) answers.equipment = GYM_TYPE_INFO[t.equipment.gymType].label;

	const lift =
		FIRST_LIFTS.map((l) => t.baselines.find((b) => b.lift === l)).find(Boolean) ?? t.baselines[0];
	if (lift) {
		const name =
			lift.lift === 'custom' ? (lift.customLabel ?? LIFT_LABEL.custom) : LIFT_LABEL[lift.lift];
		answers.strength = `${name} ${oneRepMax(lift)}`;
	}

	const levels = new Set(t.experience.map((e) => e.level));
	if (levels.size === 1) answers.experience = EXPERIENCE_LEVEL_INFO[[...levels][0]!].label;
	else if (levels.size > 1)
		answers.experience = count(t.experience.length, 'discipline', 'disciplines');

	return answers;
}

/** Security's row: "1 passkey", "2 passkeys". */
export const passkeysAnswer = (n: number) => count(n, 'passkey', 'passkeys');
