/**
 * Muay Thai fight camps as week plans (m7-plan fight-camp; PRD §5), from rules/fight-camp.ts:
 * - fightCampWeeks(input): the camp's weeks, phase fight_camp, each a skeleton with its kind
 *   (kinds.ts BLOCK_WEEK_KINDS.fight_camp), its dates and its targets: camp weeks are build, the
 *   sparring peak (the week before the fight week) is peak and the fight week is event. Their
 *   combat targets carry the Muay Thai sessions, hard sparring, rounds and conditioning; strength
 *   is held at its maintenance dose, biased to power
 * - combatLoadOf(week): the week's planned combat load through the load model (load/systems.ts),
 *   as the generator projects it from the plan alone
 * The fight week is the Monday-to-Sunday week holding the day TAPER_LEAD_DAYS (M3's) before the
 * fight, as TAPERS.fight places it, so a Saturday fight is in its own fight week and a Monday
 * fight's fight week is the week before. The generator fills in sessions. Pure and deterministic.
 * Weight cutting is out of scope (WEIGHT_CUT).
 */
import { addDays, daysBetween, mondayOf } from '../../calendar.ts';
import type { IsoDate } from '../../calendar.ts';
import type { ExperienceLevel } from '../../profile/catalog.ts';
import type { WeekTargets } from '../../training/types.ts';
import type { OtherSessionKind } from '../../training/vocabulary.ts';
import { systemLoads } from '../load/systems.ts';
import type { LoadSession } from '../load/systems.ts';
import { TAPER_LEAD_DAYS, weekTargets } from '../rules/blocks.ts';
import {
	CAMP_WEEKS,
	CONDITIONING,
	FIGHT_WEEK,
	HARD_SPARRING,
	LAST_HARD_SPARRING,
	MUAY_THAI_SESSIONS,
	STRENGTH
} from '../rules/fight-camp.ts';
import type { Ramp } from '../rules/fight-camp.ts';
import { MUAY_THAI } from '../rules/running.ts';
import { BLOCK_WEEK_KINDS } from './kinds.ts';

export interface FightCampInput {
	fightOn: IsoDate;
	/** The earliest day the camp may start; it starts on the first Monday from here. */
	startsOn: IsoDate;
	level: ExperienceLevel;
	/** Whether the owner spars; without it the camp plans no hard sparring. */
	spars: boolean;
	/** The training sessions the owner has room for in a week. */
	sessionsAvailable: number;
}

type CampRole = Exclude<keyof typeof BLOCK_WEEK_KINDS.fight_camp, 'deload'>;

/** One week of a fight camp, before it has sessions. */
export interface FightCampWeek {
	role: CampRole;
	kind: (typeof BLOCK_WEEK_KINDS.fight_camp)[CampRole];
	phase: 'fight_camp';
	startsOn: IsoDate;
	endsOn: IsoDate;
	targets: WeekTargets & {
		combat: NonNullable<WeekTargets['combat']>;
		setsPerGroup: NonNullable<WeekTargets['setsPerGroup']>;
		maintenance: ['strength'];
	};
	/** The last day this week's hard sparring may fall on; null with none. */
	hardSparringBy: IsoDate | null;
	/** Conditioning sessions this week, each of combat.conditioningRounds rounds. */
	conditioningSessions: number;
	/** Strength at its maintenance dose: sessions, their bias and the last day one may fall on. */
	strength: { sessions: number; bias: typeof STRENGTH.bias; lastOn: IsoDate | null };
}

/** Step `i` of `steps` along `ramp`, rounded; a one-step stretch sits at the ramp's top. */
const along = ({ from, to }: Ramp, i: number, steps: number) =>
	steps <= 1 ? to : Math.round(from + ((to - from) * i) / (steps - 1));

/**
 * At most `planned` sessions in the week from `startsOn` that must fall on or before `lastOn`,
 * with a day between any two: how many fit, and the last day they may use.
 */
function before(planned: number, startsOn: IsoDate, lastOn: IsoDate) {
	const days = Math.min(7, Math.max(0, daysBetween(startsOn, lastOn) + 1));
	const count = Math.min(planned, Math.ceil(days / 2));
	return { count, lastOn: count ? addDays(startsOn, days - 1) : null };
}

/** The camp's first Monday and its length in weeks, the fight week included. */
function campSpan({ fightOn, startsOn, level }: FightCampInput) {
	const fightWeek = mondayOf(addDays(fightOn, -TAPER_LEAD_DAYS));
	const monday = mondayOf(startsOn);
	const first = monday === startsOn ? monday : addDays(monday, 7);
	const room = daysBetween(first, fightWeek) / 7 + 1;
	if (room < CAMP_WEEKS.min) {
		throw new RangeError(`A fight camp needs at least ${CAMP_WEEKS.min} weeks before the fight`);
	}
	const weeks = Math.min(room, CAMP_WEEKS.byLevel[level]);
	return { first: addDays(fightWeek, -7 * (weeks - 1)), weeks };
}

/**
 * The camp for a fight on `fightOn`: as long as the owner's level asks (CAMP_WEEKS.byLevel) when
 * the fight is far enough from `startsOn`, else a short camp down to CAMP_WEEKS.min weeks. Muay
 * Thai and hard sparring rise across the building weeks (every week but the fight week), within
 * the owner's sessions; the last hard sparring is LAST_HARD_SPARRING.daysOut days out and the last
 * strength session STRENGTH.noneInLastDays + 1. Throws a RangeError when fewer than CAMP_WEEKS.min
 * weeks remain, or for a session count that is not a whole number from 1.
 */
export function fightCampWeeks(input: FightCampInput): FightCampWeek[] {
	const { fightOn, spars, sessionsAvailable } = input;
	if (!Number.isInteger(sessionsAvailable) || sessionsAvailable < 1) {
		throw new RangeError('sessionsAvailable must be a whole number of sessions from 1');
	}
	const { first, weeks } = campSpan(input);
	const building = weeks - 1;
	const sparringBy = addDays(fightOn, -LAST_HARD_SPARRING.daysOut);
	const strengthBy = addDays(fightOn, -(STRENGTH.noneInLastDays + 1));
	const conditioningWeeks = weeks - CONDITIONING.fromWeek;
	const [low, high] = STRENGTH.dose.hardSets;
	const camp = { rpeCap: STRENGTH.dose.topSetRpeCap, volumeFactor: 1, loadStep: 0 };

	return Array.from({ length: weeks }, (_, i): FightCampWeek => {
		const startsOn = addDays(first, 7 * i);
		const role: CampRole = i === building ? 'fight' : i === building - 1 ? 'sparring_peak' : 'camp';
		const fight = role === 'fight';
		const sessions = Math.min(
			fight ? FIGHT_WEEK.sessions : along(MUAY_THAI_SESSIONS.ramp, i, building),
			sessionsAvailable
		);
		const sparring =
			spars && !fight
				? before(Math.min(along(HARD_SPARRING.ramp, i, building), sessions), startsOn, sparringBy)
				: { count: 0, lastOn: null };
		const conditioning =
			!fight && i + 1 >= CONDITIONING.fromWeek
				? along(CONDITIONING.rounds, i + 1 - CONDITIONING.fromWeek, conditioningWeeks)
				: 0;
		const strength = before(STRENGTH.sessions, startsOn, strengthBy);
		return {
			role,
			kind: BLOCK_WEEK_KINDS.fight_camp[role],
			phase: 'fight_camp',
			startsOn,
			endsOn: addDays(startsOn, 6),
			targets: {
				...(fight ? weekTargets('event', 0) : { ...camp, runVolumeFactor: 1 }),
				combat: {
					sessions,
					hardSparring: sparring.count,
					sparringRounds: sparring.count ? along(HARD_SPARRING.rounds, i, building) : 0,
					conditioningRounds: conditioning
				},
				setsPerGroup: { min: low, max: high, step: 0 },
				maintenance: ['strength']
			},
			hardSparringBy: sparring.lastOn,
			conditioningSessions: conditioning ? CONDITIONING.sessions : 0,
			strength: { sessions: strength.count, bias: STRENGTH.bias, lastOn: strength.lastOn }
		};
	});
}

type CampFormat = Extract<OtherSessionKind, 'sparring' | 'pad_work' | 'technical'>;

/** One planned Muay Thai session as the load model reads it. */
function muayThai(week: FightCampWeek, n: number, format: CampFormat): LoadSession {
	const fightWeek = week.role === 'fight';
	return {
		date: week.startsOn,
		timeOfDay: null,
		orderInDay: n + 1,
		type: 'muay_thai',
		title: `Muay Thai ${format}`,
		discipline: 'muay_thai',
		intensity: null,
		minutes: fightWeek
			? FIGHT_WEEK.minutes
			: MUAY_THAI_SESSIONS.minutes +
				(format === 'sparring' ? week.targets.combat.sparringRounds * MUAY_THAI.roundMinutes : 0),
		rpe: fightWeek ? FIGHT_WEEK.rpe : MUAY_THAI[format].rpe,
		source: 'planned',
		kind: 'other',
		format,
		rounds: null
	};
}

/**
 * The week's planned combat load (sRPE through the load model's shares): its hard sparring at
 * sparring's RPE, each session longer by its rounds (the load model puts sparring's extra cost in
 * the CNS, so its rounds are what raise the combat load), its other camp sessions alternating pads
 * and technique, and a fight week's at
 * FIGHT_WEEK's RPE and length.
 */
export function combatLoadOf(week: FightCampWeek): number {
	const { sessions, hardSparring } = week.targets.combat;
	const formats: readonly CampFormat[] =
		week.role === 'fight' ? FIGHT_WEEK.formats : ['pad_work', 'technical'];
	let total = 0;
	for (let n = 0; n < sessions; n++) {
		const format = n < hardSparring ? 'sparring' : formats[(n - hardSparring) % formats.length]!;
		total += systemLoads(muayThai(week, n, format)).loads?.combat ?? 0;
	}
	return total;
}
