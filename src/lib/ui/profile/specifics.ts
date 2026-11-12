/**
 * Editing state for Profile → Running & Muay Thai, built from what the services return and the
 * disciplines in play (the edit route's context). Each part is there while its discipline is in
 * play or something about it is saved, and the owner can add either one.
 *
 * Times are typed as text. The iPhone's decimal keypad has no ':', so '.', ',', a space or ':'
 * each separate hours, minutes and seconds ("1.45.30", "5,45"); parseDuration reads only ':'.
 */
import {
	RACE_DISTANCE_INFO,
	RUNNING_DISCIPLINES,
	type Discipline,
	type RaceDistance
} from '#lib/domain/profile/catalog.ts';
import type {
	HeartRate,
	MuayThaiProfile,
	RaceResult,
	RunningProfile
} from '#lib/domain/profile/types.ts';
import { formatDuration, parseDuration } from '#lib/domain/units.ts';

type Unit = RunningProfile['unit'];

export interface RaceDraft {
	/** Keeps each race's card, and anything half-typed in it, with its race. Never posted. */
	key: string;
	/** None until the owner picks one: the schema then asks for it. */
	distance: RaceDistance | null;
	/** How far an "Other" race was, in the running unit. */
	customDistance: number | null;
	/** As typed ("1.45.30") or as saved ("1:45:30"). */
	time: string;
	racedOn: string | null;
	/** Not edited on this screen, but kept, so a save never drops it. */
	eventName: string | null;
}

export interface RunningDraft {
	unit: Unit;
	weeklyDistance: number | null;
	runsPerWeek: number | null;
	longestRun: number | null;
	/** Per unit, as typed ("5.45") or as saved ("5:45"). */
	easyPace: string;
	/** Max, resting and threshold heart rate in whole bpm, each null while blank. */
	heartRate: HeartRate;
	/** Whether a heart rate was saved when editing began: blanking all three then clears them. */
	heartRateSaved: boolean;
	races: RaceDraft[];
	/** Not edited on this screen, but kept. */
	notes: string | null;
}

export interface MuayThaiDraft {
	sessionsPerWeek: number | null;
	sparringPerWeek: number | null;
	fights: number | null;
	/** Not edited on this screen, but kept. */
	notes: string | null;
}

export interface SpecificsDraft {
	/** None while running is not in play and nothing is saved: a save leaves it as it is. */
	running: RunningDraft | null;
	muayThai: MuayThaiDraft | null;
}

/** "1.45.30", "1,45,30" or "1 45 30" → "1:45:30", the one form parseDuration reads. */
export function normaliseTime(text: string): string {
	return text.trim().replace(/\s*[.,:\s]\s*/g, ':');
}

/**
 * A typed time in seconds; blank is none. Text that is not a time stays as typed, so the schema
 * refuses it in the browser and again on the server: NaN would turn into null in the JSON that
 * is posted, and the time would silently go.
 */
export function timeSeconds(text: string): number | string | null {
	const typed = text.trim();
	if (!typed) return null;
	return parseDuration(normaliseTime(typed)) ?? typed;
}

/** A time field's error: how to type a time while the text is not one, else the schema's. */
export function timeError(text: string, error: string | undefined, format: string) {
	return error && typeof timeSeconds(text) !== 'number' ? format : error;
}

let added = 0;

/** A race the owner just added: no distance picked yet, and a key of its own. */
export function newRace(): RaceDraft {
	added += 1;
	return {
		key: `new-${added}`,
		distance: null,
		customDistance: null,
		time: '',
		racedOn: null,
		eventName: null
	};
}

function raceDraft(race: RaceResult): RaceDraft {
	return {
		key: race.id,
		distance: race.distance,
		customDistance: race.customDistance,
		time: formatDuration(race.timeSeconds),
		racedOn: race.racedOn,
		eventName: race.eventName
	};
}

/** Running as saved, in its own unit, or blank in `unit` (the owner's distance unit). */
export function runningDraft(saved: RunningProfile | null, unit: Unit): RunningDraft {
	return {
		unit: saved?.unit ?? unit,
		weeklyDistance: saved?.weeklyDistance ?? null,
		runsPerWeek: saved?.runsPerWeek ?? null,
		longestRun: saved?.longestRun ?? null,
		easyPace: saved?.easyPaceSeconds == null ? '' : formatDuration(saved.easyPaceSeconds),
		heartRate: { ...(saved?.heartRate ?? { max: null, resting: null, threshold: null }) },
		heartRateSaved: !!saved?.heartRate,
		races: (saved?.races ?? []).map(raceDraft),
		notes: saved?.notes ?? null
	};
}

export function muayThaiDraft(saved: MuayThaiProfile | null): MuayThaiDraft {
	return {
		sessionsPerWeek: saved?.sessionsPerWeek ?? null,
		sparringPerWeek: saved?.sparringPerWeek ?? null,
		fights: saved?.fights ?? null,
		notes: saved?.notes ?? null
	};
}

export function specificsDraft(
	saved: { running: RunningProfile | null; muayThai: MuayThaiProfile | null },
	context: { disciplines: readonly Discipline[]; units: { distance: Unit } }
): SpecificsDraft {
	const running = saved.running || context.disciplines.some((d) => RUNNING_DISCIPLINES.includes(d));
	const muayThai = saved.muayThai || context.disciplines.includes('muay_thai');
	return {
		running: running ? runningDraft(saved.running, context.units.distance) : null,
		muayThai: muayThai ? muayThaiDraft(saved.muayThai) : null
	};
}

/**
 * Running as the schema takes it: times in seconds, a distance of its own only for an "Other"
 * race, no keys. Races keep their places, so an error the schema reports
 * (`running.races.2.timeSeconds`) is about the race in that place when it came back. Heart rate
 * goes when one is told; all blank leaves it out of the JSON (undefined), which keeps what is
 * stored, or posts null to clear the rates saved when editing began.
 */
export function runningPayload(running: RunningDraft) {
	return {
		unit: running.unit,
		weeklyDistance: running.weeklyDistance,
		runsPerWeek: running.runsPerWeek,
		longestRun: running.longestRun,
		easyPaceSeconds: timeSeconds(running.easyPace),
		heartRate: Object.values(running.heartRate).some((bpm) => bpm !== null)
			? running.heartRate
			: running.heartRateSaved
				? null
				: undefined,
		races: running.races.map((race) => ({
			distance: race.distance,
			customDistance: race.distance === 'other' ? race.customDistance : null,
			timeSeconds: timeSeconds(race.time),
			racedOn: race.racedOn,
			eventName: race.eventName
		})),
		notes: running.notes
	};
}

/** What Save posts. A part that is not shown goes as none, which keeps what is saved. */
export function specificsPayload({ running, muayThai }: SpecificsDraft) {
	return { running: running && runningPayload(running), muayThai };
}

/** A race's name on its card: its distance, or how far an "Other" one was. */
export function raceName(race: RaceDraft, unit: Unit): string {
	if (race.distance === 'other' && race.customDistance != null) {
		return `${race.customDistance} ${unit}`;
	}
	return race.distance ? RACE_DISTANCE_INFO[race.distance].label : 'New race';
}
