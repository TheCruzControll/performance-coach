/**
 * Editing state for the training-profile editors (built from what the services return) and the
 * short summaries the review step, Profile and Today show. No Intl on purpose: formatter
 * construction is measurable hydration cost on phones (docs/performance.md).
 */
import { formatDuration, parseDuration } from '#lib/domain/units.ts';
import {
	BASELINE_SOURCE_LABEL,
	BODY_AREA_LABEL,
	DISCIPLINE_INFO,
	LIFTS_FOR_DISCIPLINE,
	LIFT_LABEL,
	NUTRITION_PHASE_INFO,
	TIME_OF_DAY_LABEL,
	WEEKDAY_INFO,
	type Discipline,
	type Lift,
	type NutritionPhase
} from '#lib/domain/profile/catalog.ts';
import type {
	BaselineEntryInput,
	BodyInput,
	CommitmentInput,
	EquipmentInput,
	ExperienceInput,
	GoalInput,
	InjuryInput,
	MuayThaiInput
} from '#lib/domain/profile/schemas.ts';
import type {
	AthleteProfile,
	BodyWeightEntry,
	Commitment,
	EquipmentProfile,
	ExercisePreference,
	ExperienceEntry,
	Goal,
	Injury,
	MuayThaiProfile,
	RaceResult,
	RunningProfile,
	Schedule,
	StrengthBaseline
} from '#lib/domain/profile/types.ts';

// ---- dates -------------------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2027-03-14` → `14 Mar 2027`. */
export function shortIsoDate(iso: string | null | undefined): string {
	if (!iso) return '';
	const [y, m, d] = iso.split('-').map(Number);
	return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}

/** Whole weeks (rounded down) from `today` to `iso`, or null when it has passed. */
export function weeksUntil(iso: string | null, today: Date): number | null {
	if (!iso) return null;
	const [y, m, d] = iso.split('-').map(Number);
	const target = Date.UTC(y!, m! - 1, d!);
	const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
	const days = Math.round((target - now) / 86_400_000);
	return days < 0 ? null : Math.floor(days / 7);
}

// ---- goals -------------------------------------------------------------------------------------

/**
 * A goal being edited: both kinds' fields side by side, so switching kind keeps what was typed
 * until save (the shared schema keeps only the fields of the chosen kind).
 */
export interface GoalDraft {
	id?: string;
	kind: GoalInput['kind'];
	title: string;
	disciplines: Discipline[];
	customDiscipline: string | null;
	status?: Goal['status'];
	notes?: string | null;
	eventType: string;
	eventDate: string;
	weightClass: string | null;
	targetPerformance: string | null;
	requirements: string | null;
	focus: string;
	measure: string;
	targetDate: string | null;
}

export function newGoal(kind: 'event' | 'general', disciplines: Discipline[] = []): GoalDraft {
	return {
		kind,
		title: '',
		disciplines,
		customDiscipline: null,
		eventType: '',
		eventDate: '',
		weightClass: null,
		targetPerformance: null,
		requirements: null,
		focus: '',
		measure: '',
		targetDate: null
	};
}

export function goalDraft(goal: Goal): GoalDraft {
	return {
		id: goal.id,
		kind: goal.kind,
		title: goal.title,
		disciplines: goal.disciplines,
		customDiscipline: goal.customDiscipline,
		status: goal.status,
		notes: goal.notes,
		eventType: goal.eventType ?? '',
		eventDate: goal.eventDate ?? '',
		weightClass: goal.weightClass,
		targetPerformance: goal.targetPerformance,
		requirements: goal.requirements,
		focus: goal.focus ?? '',
		measure: goal.measure ?? '',
		targetDate: goal.targetDate
	};
}

export function disciplineNames(goal: Pick<Goal, 'disciplines' | 'customDiscipline'>): string[] {
	return goal.disciplines.map((d) =>
		d === 'custom' && goal.customDiscipline ? goal.customDiscipline : DISCIPLINE_INFO[d].short
	);
}

/** One line under a goal's title. */
export function goalSummary(goal: Goal): string {
	if (goal.kind === 'event') {
		return [goal.eventType, shortIsoDate(goal.eventDate), goal.weightClass]
			.filter(Boolean)
			.join(' · ');
	}
	return goal.measure ? `${goal.focus} · ${goal.measure}` : (goal.focus ?? '');
}

// ---- experience --------------------------------------------------------------------------------

export type ExperienceDraft = ExperienceInput['entries'][number];

/** Saved entries, plus an empty one for each discipline in play that has none yet. */
export function experienceDraft(
	saved: ExperienceEntry[],
	disciplines: Discipline[]
): { entries: ExperienceDraft[] } {
	const entries: ExperienceDraft[] = saved.map((e) => ({
		discipline: e.discipline,
		customLabel: e.customLabel,
		level: e.level,
		years: e.years,
		sessionsPerWeek: e.sessionsPerWeek,
		notes: e.notes
	}));
	for (const d of disciplines) {
		if (d !== 'custom' && !entries.some((e) => e.discipline === d)) {
			entries.push(blankExperience(d));
		}
	}
	return { entries };
}

export function blankExperience(discipline: Discipline): ExperienceDraft {
	return {
		discipline,
		customLabel: null,
		level: null as unknown as ExperienceDraft['level'],
		years: null,
		sessionsPerWeek: null,
		notes: null
	};
}

// ---- strength baselines ------------------------------------------------------------------------

export type LiftDraft = BaselineEntryInput;

export function liftDraft(b: StrengthBaseline): LiftDraft {
	return {
		lift: b.lift,
		customLabel: b.customLabel,
		source: b.source,
		value: b.source === 'set' ? null : b.value,
		unit: b.unit,
		achievedOn: b.achievedOn,
		setWeight: b.setWeight,
		setReps: b.setReps,
		setRpe: b.setRpe,
		notes: b.notes
	};
}

/** Lifts worth offering for these disciplines, in a sensible order. */
export function suggestedLifts(disciplines: Discipline[]): Lift[] {
	const set = new Set<Lift>();
	for (const d of disciplines) LIFTS_FOR_DISCIPLINE[d]?.forEach((l) => set.add(l));
	if (set.size === 0) ['back_squat', 'bench_press', 'deadlift'].forEach((l) => set.add(l as Lift));
	return [...set];
}

export function liftName(lift: Pick<LiftDraft, 'lift' | 'customLabel'>): string {
	return lift.lift === 'custom' && lift.customLabel ? lift.customLabel : LIFT_LABEL[lift.lift];
}

export function baselineSummary(b: StrengthBaseline): string {
	const value = `${b.kind === 'estimated' ? '≈ ' : ''}${trim(b.value)} ${b.unit}`;
	const how =
		b.source === 'set' && b.setWeight && b.setReps
			? `from ${trim(b.setWeight)} × ${b.setReps}${b.setRpe ? ` @ RPE ${b.setRpe}` : ''}`
			: BASELINE_SOURCE_LABEL[b.source].toLowerCase();
	return `${value} · ${b.kind === 'measured' ? 'Measured' : 'Estimated'}, ${how}`;
}

// ---- running & Muay Thai -----------------------------------------------------------------------

export interface RaceDraft {
	distance: RaceResult['distance'];
	customDistance: number | null;
	time: string;
	racedOn: string | null;
	eventName: string | null;
}

export interface RunningDraft {
	unit: 'km' | 'mi';
	weeklyDistance: number | null;
	runsPerWeek: number | null;
	longestRun: number | null;
	easyPace: string;
	races: RaceDraft[];
	notes: string | null;
}

export function runningDraft(r: RunningProfile | null, unit: 'km' | 'mi'): RunningDraft {
	return {
		unit: r?.unit ?? unit,
		weeklyDistance: r?.weeklyDistance ?? null,
		runsPerWeek: r?.runsPerWeek ?? null,
		longestRun: r?.longestRun ?? null,
		easyPace: r?.easyPaceSeconds ? formatDuration(r.easyPaceSeconds) : '',
		races: (r?.races ?? []).map((race) => ({
			distance: race.distance,
			customDistance: race.customDistance,
			time: formatDuration(race.timeSeconds),
			racedOn: race.racedOn,
			eventName: race.eventName
		})),
		notes: r?.notes ?? null
	};
}

/** Running editing state → the schema's input (times as seconds; unparseable → NaN → error). */
export function runningPayload(r: RunningDraft) {
	const seconds = (text: string) => (text.trim() ? (parseDuration(text) ?? Number.NaN) : null);
	return {
		unit: r.unit,
		weeklyDistance: r.weeklyDistance,
		runsPerWeek: r.runsPerWeek,
		longestRun: r.longestRun,
		easyPaceSeconds: seconds(r.easyPace),
		races: r.races.map((race) => ({
			distance: race.distance,
			customDistance: race.distance === 'other' ? race.customDistance : null,
			timeSeconds: seconds(race.time) ?? Number.NaN,
			racedOn: race.racedOn,
			eventName: race.eventName
		})),
		notes: r.notes
	};
}

export function muayThaiDraft(m: MuayThaiProfile | null): MuayThaiInput {
	return {
		sessionsPerWeek: m?.sessionsPerWeek ?? null,
		sparringPerWeek: m?.sparringPerWeek ?? null,
		fights: m?.fights ?? null,
		notes: m?.notes ?? null
	};
}

// ---- injuries, schedule ------------------------------------------------------------------------

export function injuryDraft(i: Injury): InjuryInput {
	return {
		id: i.id,
		bodyArea: i.bodyArea,
		side: i.side,
		severity: i.severity,
		notes: i.notes,
		avoid: i.avoid,
		active: i.active,
		since: i.since
	};
}

export function injuryTitle(i: Pick<Injury, 'bodyArea' | 'side'>): string {
	const area = BODY_AREA_LABEL[i.bodyArea] ?? 'Injury';
	return i.side && i.side !== 'both'
		? `${i.side === 'left' ? 'Left' : 'Right'} ${area.toLowerCase()}`
		: area;
}

export function commitmentDraft(c: Commitment): CommitmentInput {
	return {
		id: c.id,
		discipline: c.discipline,
		label: c.label,
		days: c.days,
		timeOfDay: c.timeOfDay,
		durationMinutes: c.durationMinutes,
		intensity: c.intensity,
		notes: c.notes
	};
}

export function daysText(days: readonly (keyof typeof WEEKDAY_INFO)[]): string {
	return days.map((d) => WEEKDAY_INFO[d].short).join(', ');
}

export function commitmentSummary(c: Commitment): string {
	return [
		daysText(c.days),
		c.timeOfDay ? TIME_OF_DAY_LABEL[c.timeOfDay].toLowerCase() : null,
		c.durationMinutes ? `${c.durationMinutes} min` : null
	]
		.filter(Boolean)
		.join(' · ');
}

export function scheduleSummary(s: Schedule): string {
	if (!s.daysPerWeek) return 'Not set yet';
	return [
		`${s.daysPerWeek} ${s.daysPerWeek === 1 ? 'day' : 'days'} a week`,
		s.sessionMinutes ? `${s.sessionMinutes} min sessions` : null,
		s.preferredTimes.length ? TIME_OF_DAY_LABEL[s.preferredTimes[0]!].toLowerCase() : null
	]
		.filter(Boolean)
		.join(' · ');
}

export function phaseLabel(phase: NutritionPhase | null): string | null {
	return phase ? NUTRITION_PHASE_INFO[phase].label : null;
}

/** 82.50 → "82.5". */
export function trim(n: number): string {
	return String(Math.round(n * 100) / 100);
}

// ---- whole sections: editing state ↔ the schema's input --------------------------------------

export function baselinesDraft(b: { unknown: boolean; lifts: StrengthBaseline[] }) {
	return { unknown: b.unknown, lifts: b.lifts.map(liftDraft) };
}

/** "I don't know" sends no lifts (they stay in the editor until saved, in case of a mis-tap). */
export function baselinesPayload(v: { unknown: boolean; lifts: LiftDraft[] }) {
	return v.unknown ? { unknown: true, lifts: [] } : v;
}

export function specificsDraft(
	s: { running: RunningProfile | null; muayThai: MuayThaiProfile | null },
	disciplines: Discipline[],
	unit: 'km' | 'mi'
) {
	const running = disciplines.some((d) => d === 'running' || d === 'distance_running');
	return {
		running: running || s.running ? runningDraft(s.running, unit) : null,
		muayThai: disciplines.includes('muay_thai') || s.muayThai ? muayThaiDraft(s.muayThai) : null
	};
}

export function specificsPayload(v: {
	running: RunningDraft | null;
	muayThai: MuayThaiInput | null;
}) {
	return { running: v.running ? runningPayload(v.running) : null, muayThai: v.muayThai };
}

export function equipmentDraft(e: EquipmentProfile | null): EquipmentInput {
	return {
		gymType: e?.gymType ?? null,
		equipment: e?.equipment ?? [],
		homeEquipment: e?.homeEquipment ?? [],
		notes: e?.notes ?? null
	};
}

export function exercisesDraft(list: ExercisePreference[]) {
	return {
		likes: list.filter((p) => p.sentiment === 'like').map((p) => p.exercise),
		dislikes: list.filter((p) => p.sentiment === 'dislike').map((p) => p.exercise)
	};
}

export function exercisesPayload(v: { likes: string[]; dislikes: string[] }) {
	return {
		items: [
			...v.likes.map((exercise) => ({ exercise, sentiment: 'like' as const })),
			...v.dislikes.map((exercise) => ({ exercise, sentiment: 'dislike' as const }))
		]
	};
}

export function scheduleDraft(s: Schedule) {
	return {
		daysPerWeek: s.daysPerWeek ?? 4,
		availableDays: s.availableDays,
		preferredTimes: s.preferredTimes,
		sessionMinutes: s.sessionMinutes ?? 60,
		constraints: s.constraints,
		commitments: s.commitments.map(commitmentDraft)
	};
}

export type BodyDraft = Omit<BodyInput, 'nutritionPhase'> & {
	nutritionPhase: NutritionPhase | 'none' | null;
};

export function bodyDraft(
	profile: Pick<
		AthleteProfile,
		'weightUnit' | 'birthYear' | 'nutritionPhase' | 'targetWeight' | 'targetDate'
	>,
	history: BodyWeightEntry[]
): BodyDraft {
	const latest = history[0];
	return {
		birthYear: profile.birthYear,
		weightUnit: profile.weightUnit,
		bodyWeight: latest && latest.unit === profile.weightUnit ? latest.value : null,
		nutritionPhase: profile.nutritionPhase ?? null,
		targetWeight: profile.targetWeight,
		targetDate: profile.targetDate
	};
}

export function bodyPayload(v: BodyDraft): BodyInput {
	return { ...v, nutritionPhase: v.nutritionPhase === 'none' ? null : v.nutritionPhase };
}
