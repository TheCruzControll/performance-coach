/**
 * Tapers (m7-plan deload-taper; PRD §5), from rules/taper.ts:
 * - taperWeeks(eventKind, priorityMode, raceOn): how an event is tapered, by its kind and the
 *   goal's priority: a full taper's weeks and factors, a secondary event's mini-taper, or none
 * - taperSessions(weeks, taper): the weeks with the taper applied, on the same days and with the
 *   same exercises, volume cut by the taper's factors and intensity kept. An endurance taper keeps
 *   one short strength session a week at least TAPER_SESSIONS.strength.daysOut days out and
 *   removes the rest; the last week's Muay Thai is technical.
 * The weeks' kinds and targets are the generator's. Pure and deterministic.
 */
import { addDays, daysBetween, mondayOf } from '../../calendar.ts';
import type { IsoDate } from '../../calendar.ts';
import type { OtherSessionPlan, SessionPlan, WeekPlan } from '../../training/types.ts';
import type { GoalMode } from '../evaluate/types.ts';
import type { EventKind } from '../rules/priority.ts';
import { BY_PRIORITY, MEET_TAPER, TAPER_SESSIONS, TAPERS } from '../rules/taper.ts';
import { asMuayThai, fewerSets, retimed, shorterSegment } from './deload.ts';

/** One full-taper week: its Monday and its volume factor. */
export interface TaperWeek {
	startsOn: IsoDate;
	factor: number;
}

export interface TaperPlan {
	event: EventKind;
	mode: GoalMode;
	raceOn: IsoDate;
	/** A full taper, a secondary event's mini-taper, or trained through. */
	form: 'full' | 'mini' | 'none';
	/** A full taper's weeks, first first; none otherwise. */
	weeks: TaperWeek[];
	/** A mini-taper's days, before the event; null otherwise. */
	days: { from: IsoDate; to: IsoDate; factor: number } | null;
	/** An endurance taper's strength: one short session a week, at least `daysOut` days out. */
	strength: { perWeek: number; daysOut: number } | null;
	/** A meet's openers and its last heavy lower-body day; the generator places them. */
	meet: typeof MEET_TAPER | null;
	ruleKey: string;
}

/** How an event of `eventKind` on `raceOn` is tapered when its goal is at `priorityMode`. */
export function taperWeeks(
	eventKind: EventKind,
	priorityMode: GoalMode,
	raceOn: IsoDate
): TaperPlan {
	const plan = { event: eventKind, mode: priorityMode, raceOn, strength: null, meet: null };
	if (priorityMode === 'maintenance')
		return { ...plan, form: 'none', weeks: [], days: null, ruleKey: 'taper.priority' };
	if (priorityMode === 'secondary') {
		const { days, factor } = BY_PRIORITY.secondary;
		const window = { from: addDays(raceOn, -days), to: addDays(raceOn, -1), factor };
		return { ...plan, form: 'mini', weeks: [], days: window, ruleKey: 'taper.priority' };
	}
	const taper = TAPERS[eventKind];
	const last = mondayOf(addDays(raceOn, -TAPER_SESSIONS.leadDays));
	const n = taper.factors.length;
	return {
		...plan,
		form: 'full',
		weeks: taper.factors.map((factor, i) => ({
			startsOn: addDays(last, -7 * (n - 1 - i)),
			factor
		})),
		days: null,
		strength: taper.endurance ? { ...TAPER_SESSIONS.strength } : null,
		meet: eventKind === 'meet' ? MEET_TAPER : null,
		ruleKey: `taper.${eventKind}`
	};
}

/** The taper's factor on `date`, or null when the taper does not reach it. */
function factorOn(taper: TaperPlan, date: IsoDate): number | null {
	if (date >= taper.raceOn) return null;
	if (taper.days)
		return date >= taper.days.from && date <= taper.days.to ? taper.days.factor : null;
	const week = taper.weeks.find((w) => date >= w.startsOn && date <= addDays(w.startsOn, 6));
	return week?.factor ?? null;
}

/** `session` with its volume × `factor`, its intensity kept. */
function lessOf(session: SessionPlan, factor: number, technical: boolean): SessionPlan {
	// A commitment keeps its slot and length: the club sets it.
	if (session.source === 'commitment') return session;
	if (session.kind === 'strength') {
		const exercises = session.exercises.map((e) => ({
			...e,
			sets: e.sets.map((line) => fewerSets(line, factor))
		}));
		return retimed({ ...session, exercises }, session.estMinutes * factor, session.targetRpe);
	}
	if (session.kind === 'run') {
		const segments = session.segments.map((s) => shorterSegment(s, factor));
		return retimed({ ...session, segments }, session.estMinutes * factor, session.targetRpe);
	}
	const durationMinutes = Math.max(10, Math.round(session.details.durationMinutes * factor));
	const made =
		technical && session.discipline === 'muay_thai'
			? asMuayThai(session, TAPER_SESSIONS.lastWeekMuayThai)
			: session;
	const details: OtherSessionPlan['details'] = { ...made.details, durationMinutes };
	return retimed({ ...made, details }, session.estMinutes * factor, session.targetRpe);
}

/**
 * The strength sessions an endurance taper keeps in one week: the shortest one at least
 * `daysOut` days before the race (the earliest of equals), or none.
 */
function keptStrength(sessions: readonly SessionPlan[], taper: TaperPlan): SessionPlan | null {
	const { daysOut } = taper.strength!;
	const fits = sessions
		.filter((s) => s.kind === 'strength' && daysBetween(s.date, taper.raceOn) >= daysOut)
		.sort((a, b) => a.estMinutes - b.estMinutes || a.date.localeCompare(b.date));
	return fits[0] ?? null;
}

/** Each day's sessions numbered from 1 again, in their order, after a removal. */
function renumbered(sessions: readonly SessionPlan[]): SessionPlan[] {
	const seen = new Map<IsoDate, number>();
	return sessions.map((s) => {
		const order = (seen.get(s.date) ?? 0) + 1;
		seen.set(s.date, order);
		return s.orderInDay === order ? s : { ...s, orderInDay: order };
	});
}

/** `weeks` with `taper` applied to every session it reaches; every other session as it was. */
export function taperSessions(weeks: readonly WeekPlan[], taper: TaperPlan): WeekPlan[] {
	if (taper.form === 'none') return [...weeks];
	const lastWeek = taper.weeks.at(-1)?.startsOn;
	return weeks.map((week) => {
		if (!week.sessions.some((s) => factorOn(taper, s.date) !== null)) return week;
		const keep = taper.strength
			? keptStrength(
					week.sessions.filter((s) => factorOn(taper, s.date) !== null),
					taper
				)
			: null;
		const sessions = week.sessions.flatMap((s) => {
			const factor = factorOn(taper, s.date);
			if (factor === null) return [s];
			if (taper.strength && s.kind === 'strength' && s !== keep) return [];
			return [lessOf(s, factor, week.startsOn === lastWeek)];
		});
		return { ...week, sessions: renumbered(sessions) };
	});
}
