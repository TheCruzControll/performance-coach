/**
 * The lines the onboarding review (ProfileSummary.svelte) shows for each part of the training
 * profile, built from what the services return. Each says only what is known: a part with
 * nothing known gives '' (or null), and the review says "Not told yet" in its place.
 */
import {
	EQUIPMENT_LABEL,
	EXPERIENCE_LEVEL_INFO,
	GYM_TYPE_INFO,
	NUTRITION_PHASE_INFO,
	RACE_DISTANCE_INFO,
	SEVERITY_INFO
} from '#lib/domain/profile/catalog.ts';
import type {
	AthleteProfile,
	BodyWeightEntry,
	EquipmentProfile,
	ExperienceEntry,
	Goal,
	Injury,
	MuayThaiProfile,
	RaceResult,
	RunningProfile,
	StrengthBaseline
} from '#lib/domain/profile/types.ts';
import { formatDuration } from '#lib/domain/units.ts';
import { shortIsoDate } from './goals';
import { trim } from './strength';

const join = (parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' · ');
const by = (date: string | null) => (date ? ` by ${shortIsoDate(date)}` : '');
const times = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The open goals, top priority first (achieved and dropped goals have no rank). */
export function rankedGoals(goals: readonly Goal[]): Goal[] {
	return goals.filter((g) => g.priority !== null).sort((a, b) => a.priority! - b.priority!);
}

/** "Novice · 3 years · 2 a week". */
export function experienceLine(e: Pick<ExperienceEntry, 'level' | 'years' | 'sessionsPerWeek'>) {
	return join([
		EXPERIENCE_LEVEL_INFO[e.level].label,
		e.years != null && times(e.years, 'year', 'years'),
		e.sessionsPerWeek != null && `${e.sessionsPerWeek} a week`
	]);
}

/** A 1RM as a number: "140 kg" when lifted, "≈ 123.3 kg" when estimated. */
export function baselineValue(b: Pick<StrengthBaseline, 'kind' | 'value' | 'unit'>): string {
	return `${b.kind === 'estimated' ? '≈ ' : ''}${trim(b.value)} ${b.unit}`;
}

/** "40 km a week · 4 runs · longest 21 km · easy 5:45/km". */
export function runningLine(r: RunningProfile): string {
	return join([
		r.weeklyDistance != null && `${trim(r.weeklyDistance)} ${r.unit} a week`,
		r.runsPerWeek != null && times(r.runsPerWeek, 'run', 'runs'),
		r.longestRun != null && `longest ${trim(r.longestRun)} ${r.unit}`,
		r.easyPaceSeconds != null && `easy ${formatDuration(r.easyPaceSeconds)}/${r.unit}`
	]);
}

/** "Half marathon in 1:45:30", or "15 km in 1:10:00" for a distance of the owner's own. */
export function raceLine(race: RaceResult, unit: RunningProfile['unit']): string {
	const name =
		race.distance === 'other'
			? `${trim(race.customDistance ?? 0)} ${unit}`
			: RACE_DISTANCE_INFO[race.distance].label;
	return `${name} in ${formatDuration(race.timeSeconds)}`;
}

/** "3 sessions a week · 1 sparring · 2 fights". */
export function muayThaiLine(m: MuayThaiProfile): string {
	return join([
		m.sessionsPerWeek != null && `${times(m.sessionsPerWeek, 'session', 'sessions')} a week`,
		m.sparringPerWeek != null && `${m.sparringPerWeek} sparring`,
		m.fights != null && times(m.fights, 'fight', 'fights')
	]);
}

/** Where the owner trains, what is there, and what they have at home; null when untold. */
export function equipmentLines(e: EquipmentProfile | null) {
	if (!e || (!e.gymType && !e.equipment.length && !e.homeEquipment.length)) return null;
	const kit = (list: EquipmentProfile['equipment']) =>
		list.map((k) => EQUIPMENT_LABEL[k]).join(', ');
	return {
		place: e.gymType ? GYM_TYPE_INFO[e.gymType].label : 'Gym',
		kit: kit(e.equipment),
		home: kit(e.homeEquipment)
	};
}

/** "Moderate · avoid Box jumps, Jumping lunges": the movements in the owner's own words. */
export function injuryLine(i: Pick<Injury, 'severity' | 'avoid'>): string {
	return join([
		SEVERITY_INFO[i.severity].label,
		i.avoid.length > 0 && `avoid ${i.avoid.join(', ')}`
	]);
}

/** The latest weigh-in and the nutrition plan: "Cut · target 78 kg by 14 Mar 2027"; null when untold. */
export function bodyLines(
	profile: Pick<AthleteProfile, 'nutritionPhase' | 'targetWeight' | 'targetDate' | 'weightUnit'>,
	latest: Pick<BodyWeightEntry, 'value' | 'unit'> | undefined
) {
	const plan = join([
		profile.nutritionPhase && NUTRITION_PHASE_INFO[profile.nutritionPhase].label,
		profile.targetWeight != null &&
			`target ${trim(profile.targetWeight)} ${profile.weightUnit}${by(profile.targetDate)}`
	]);
	if (!latest && !plan) return null;
	return { weight: latest ? `${trim(latest.value)} ${latest.unit}` : null, plan };
}
