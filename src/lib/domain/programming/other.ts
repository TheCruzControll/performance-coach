/**
 * The other sessions (PRD §5), by the numbers in rules/running.ts, each within the session
 * length and the week's RPE cap, its load minutes × target RPE through M1's sessionLoad:
 * - the Muay Thai sessions a week still needs after its classes: technical at RPE 6 by default
 *   (DEFAULTS.muay_thai_sessions, which blocks.ts explains); with the Muay Thai profile told,
 *   technique and pad work by turns, and one sparring session in a building week for an owner
 *   who spars
 * - a custom-discipline goal's sessions with no commitment for them, titled with its name, at RPE
 *   6 for the session length, with a default_assumed decision saying their content is the owner's
 * - a mobility session on each free day no goal asks for
 * - in a fight-camp week (one whose targets carry combat, generator-combat), the camp's own: Muay
 *   Thai up to combat.sessions with the week's Muay Thai classes counted, hard sparring up to
 *   combat.hardSparring with each hard class counted toward it and none within
 *   LAST_HARD_SPARRING.daysOut days of the fight, CAMP_CONDITIONING sessions of 3-minute rounds
 *   when combat.conditioningRounds asks for them, and a fight week of technique and light pads
 *   (FIGHT_WEEK). Commitments stay as they are. With too little room for all of it, the camp
 *   takes strength sessions of goals held at maintenance down to their dose
 *   (CAMP_TAKES_FROM, one session_dropped decision a block), then fills by CAMP_ORDER. A Muay Thai
 *   goal that does not lead keeps technique and pads, with no sparring beyond its classes.
 * They go on days naively, one a day and off days holding one of their type where another is
 * free, until placement (m3/23) places every session.
 *
 * Pure: no clock, no randomness, no I/O.
 */
import { addDays } from '../calendar.ts';
import type { IsoDate } from '../calendar.ts';
import { STEP_INFO } from '../profile/onboarding.ts';
import { sessionLoadOf } from '../training/metrics.ts';
import type {
	BlockPlan,
	CustomMetric,
	OtherSessionPlan,
	SessionPlan,
	WeekPlan,
	WeekTargets
} from '../training/types.ts';
import type { OtherSessionKind, SessionIntensity } from '../training/vocabulary.ts';
import { nextOrder, sessionPath } from './commitments.ts';
import type { DecisionLog } from './decisions.ts';
import { clip, generatedFor } from './demand.ts';
import type { WeekDemand } from './demand.ts';
import type { ProgrammingInput } from './input.ts';
import { demandOf } from './interference.ts';
import type { GoalDose } from './priority/doses.ts';
import { eventKindOf } from './priority/weights.ts';
import { SESSIONS_WANTED } from './rules/days.ts';
import type { Stream } from './rules/days.ts';
import {
	CONDITIONING,
	FIGHT_WEEK,
	LAST_HARD_SPARRING,
	MUAY_THAI_SESSIONS
} from './rules/fight-camp.ts';
import { CUSTOM_SESSION_RPE, MOBILITY, MUAY_THAI } from './rules/running.ts';
import { naiveDates, openDates } from './running.ts';
import type { GenerateOptions, Periodisation } from './stage.ts';

type Fields = Pick<OtherSessionPlan, 'type' | 'title' | 'discipline' | 'customDiscipline'> & {
	kind: OtherSessionKind;
	minutes: number;
	rpe: number;
	intensity: SessionIntensity;
	metrics: CustomMetric[];
};

function otherSession(f: Fields, date: IsoDate, orderInDay: number, rpeCap: number) {
	const targetRpe = Math.min(f.rpe, rpeCap);
	return {
		kind: 'other',
		date,
		timeOfDay: null,
		orderInDay,
		type: f.type,
		title: f.title,
		discipline: f.discipline,
		customDiscipline: f.customDiscipline,
		intensity: f.intensity,
		estMinutes: f.minutes,
		estLoad: sessionLoadOf({ estMinutes: f.minutes, targetRpe }),
		targetRpe,
		source: 'generator',
		commitmentRef: null,
		instructions: null,
		notes: null,
		details: {
			kind: f.kind,
			durationMinutes: f.minutes,
			targetRpe,
			metrics: f.metrics,
			notes: null
		}
	} satisfies OtherSessionPlan;
}

/**
 * A fight camp's conditioning session (generator-combat): combat.conditioningRounds rounds of
 * CONDITIONING.roundMinutes after a short warm-up, within the session length. It trains the fight,
 * so it is Muay Thai's, and hard: the rounds are as long as a fight's.
 */
export const CAMP_CONDITIONING = {
	title: 'Fight conditioning',
	rpe: 7,
	intensity: 'hard',
	warmUpMinutes: 10,
	why: 'Conditioning in 3-minute rounds builds the fitness to last a fight’s rounds, and a short warm-up keeps it to a session you can add to a camp week.'
} as const satisfies {
	title: string;
	rpe: number;
	intensity: SessionIntensity;
	warmUpMinutes: number;
	why: string;
};

/**
 * The order a fight-camp week's sessions take its room in, when it has too little for all: hard
 * sparring and conditioning by turns, then technique and pads, so a short week keeps some of each
 * of the camp's two hard kinds before its lighter Muay Thai.
 */
export const CAMP_ORDER = (sparring: number, conditioning: number) =>
	Array.from({ length: Math.max(sparring, conditioning) }, (_, i) => [
		...(i < sparring ? ['sparring' as const] : []),
		...(i < conditioning ? ['conditioning' as const] : [])
	]).flat();

type MuayThaiFormat = Extract<OtherSessionKind, 'technical' | 'pad_work' | 'sparring'>;

/**
 * Whether the Muay Thai goal leads, or no season gave it a mode (M3's plan). With every goal paused
 * (input.maintenance) it counts as leading, so the all-paused plan keeps M3's sparring: parity with
 * M3 wins over generator.muay_thai_dose's no-sparring-at-maintenance (an owner decision).
 */
function muayThaiLeads(input: ProgrammingInput) {
	const goal = input.goals.findIndex((g) => g.disciplines.includes('muay_thai'));
	const ref = input.refs.goals[goal];
	const mode = input.maintenance || ref === undefined ? undefined : input.modes?.[ref];
	return mode === undefined || mode === 'primary';
}

/**
 * The formats of a week's `count` generated Muay Thai sessions outside a camp: M3's, with no
 * sparring for a Muay Thai goal that does not lead.
 */
function muayThaiKinds(input: ProgrammingInput, week: WeekPlan, count: number): MuayThaiFormat[] {
	const told = input.muayThai !== null;
	const spars =
		(input.muayThai?.sparringPerWeek ?? 0) > 0 &&
		MUAY_THAI.sparringWeeks.includes(week.kind) &&
		muayThaiLeads(input);
	return Array.from({ length: count }, (_, i) =>
		spars && count > 1 && i === count - 1 ? 'sparring' : told && i % 2 ? 'pad_work' : 'technical'
	);
}

/** The first fight on or after `from` among the goals' events; null with none. */
export function fightFrom(input: ProgrammingInput, from: IsoDate): IsoDate | null {
	const dates = input.goals.flatMap((g) =>
		eventKindOf(g) === 'fight' && g.eventDate !== null && g.eventDate >= from ? [g.eventDate] : []
	);
	return dates.sort()[0] ?? null;
}

const roundsOf = (rounds: number, roundMinutes: number): CustomMetric[] => [
	{ key: 'rounds', label: 'Rounds', unit: null, value: rounds },
	{ key: 'round_length', label: 'Round length', unit: 'min', value: roundMinutes }
];

/** One generated Muay Thai session of `kind`, its rounds and length as given. */
const muayThaiFields = (
	kind: MuayThaiFormat,
	minutes: number,
	rounds: number,
	over: Partial<Pick<Fields, 'rpe' | 'intensity'>> = {}
): Fields => ({
	...MUAY_THAI[kind],
	...over,
	kind,
	type: 'muay_thai',
	discipline: 'muay_thai',
	customDiscipline: null,
	minutes,
	metrics: roundsOf(rounds, MUAY_THAI.roundMinutes)
});

/**
 * A fight-camp week's generated sessions, from its combat targets and the sessions already in it:
 * hard sparring (by `sparringBy`, the last day it may fall on), then Muay Thai up to
 * combat.sessions alternating pads and technique, then conditioning. The week's Muay Thai classes
 * count toward combat.sessions, and its hard classes toward combat.hardSparring. A fight week is
 * FIGHT_WEEK's technique and light pads only.
 */
function campSessions(
	input: ProgrammingInput,
	week: WeekPlan,
	combat: NonNullable<WeekTargets['combat']>,
	sessions: readonly SessionPlan[]
) {
	const classes = sessions.filter((s) => s.source === 'commitment' && s.discipline === 'muay_thai');
	const hardClasses = classes.filter((s) => demandOf(s).hardCombat).length;
	const count = Math.max(0, combat.sessions - classes.length);
	const minutes = (extra: number) =>
		Math.min(MUAY_THAI_SESSIONS.minutes + extra, input.sessionMinutes);
	if (week.kind === 'event') {
		const length = Math.min(FIGHT_WEEK.minutes, input.sessionMinutes);
		const formats: readonly MuayThaiFormat[] = FIGHT_WEEK.formats;
		return {
			sparring: [],
			muayThai: Array.from({ length: count }, (_, i) => {
				const kind = formats[i % formats.length]!;
				return muayThaiFields(kind, length, MUAY_THAI[kind].rounds, {
					rpe: FIGHT_WEEK.rpe,
					intensity: 'moderate'
				});
			}),
			conditioning: [],
			sparringBy: null
		};
	}
	const fight = fightFrom(input, week.startsOn);
	const sparringBy = fight ? addDays(fight, -LAST_HARD_SPARRING.daysOut) : null;
	const spars = input.muayThai?.sparringPerWeek !== 0;
	const sparCount = spars ? Math.min(count, Math.max(0, combat.hardSparring - hardClasses)) : 0;
	const rounds = combat.sparringRounds;
	const conditioningMinutes = Math.min(
		CAMP_CONDITIONING.warmUpMinutes + combat.conditioningRounds * CONDITIONING.roundMinutes,
		input.sessionMinutes
	);
	return {
		sparring: Array.from({ length: sparCount }, () =>
			muayThaiFields('sparring', minutes(rounds * MUAY_THAI.roundMinutes), rounds)
		),
		muayThai: Array.from({ length: count - sparCount }, (_, i) => {
			const kind = i % 2 ? 'technical' : 'pad_work';
			return muayThaiFields(kind, minutes(0), MUAY_THAI[kind].rounds);
		}),
		conditioning: Array.from(
			{ length: combat.conditioningRounds > 0 ? CONDITIONING.sessions : 0 },
			(): Fields => ({
				kind: 'conditioning',
				type: 'conditioning',
				title: CAMP_CONDITIONING.title,
				discipline: 'muay_thai',
				customDiscipline: null,
				minutes: conditioningMinutes,
				rpe: CAMP_CONDITIONING.rpe,
				intensity: CAMP_CONDITIONING.intensity,
				metrics: roundsOf(combat.conditioningRounds, CONDITIONING.roundMinutes)
			})
		),
		sparringBy
	};
}

/**
 * The generated sessions a week has room for beyond those already in it, as placement counts room
 * (one on each free day, and the allocation's doubles beside a commitment), less `reserved`.
 */
function roomLeft(
	sessions: readonly SessionPlan[],
	open: readonly IsoDate[],
	{ budget, allocation }: WeekDemand,
	reserved: number
) {
	const fixedOn = (date: IsoDate) =>
		sessions.filter((s) => s.source === 'commitment' && s.date === date).length;
	const room =
		Math.min(budget.freeDays, open.filter((d) => fixedOn(d) === 0).length) +
		(budget.doublesAllowed
			? Math.min(allocation.doubles, open.filter((d) => fixedOn(d) === 1).length)
			: 0);
	return Math.max(0, room - reserved - sessions.filter((s) => s.source !== 'commitment').length);
}

/**
 * The streams a fight-camp week may take sessions from, and which of their generated sessions are
 * theirs: strength only. Not the custom discipline: its sessions come later in the same pass, and
 * roomLeft already holds their days. Never runs: a held running goal's hard runs are its
 * dose's long and quality runs, and its easy runs are the recovery between the camp's hard days,
 * so a camp session in their place would only add a hard day.
 */
export const CAMP_TAKES_FROM = {
	strength: (s: SessionPlan) => s.kind === 'strength'
} as const satisfies Partial<Record<Stream, (s: SessionPlan) => boolean>>;

/**
 * Up to `need` generated sessions a fight-camp week takes from the streams only goals held at
 * maintenance train (CAMP_TAKES_FROM), the lowest-priority stream first, each down to the fewest
 * sessions of its goals' doses: their indexes in `sessions`, and the goal each served.
 */
function campTakes(
	need: number,
	sessions: readonly SessionPlan[],
	input: ProgrammingInput,
	{ allocation }: WeekDemand,
	doses: readonly GoalDose[]
) {
	const taken: { index: number; goal: string }[] = [];
	for (const share of [...allocation.streams].reverse()) {
		const stream = share.stream;
		if (!(stream in CAMP_TAKES_FROM) || taken.length >= need) continue;
		const theirs = CAMP_TAKES_FROM[stream as keyof typeof CAMP_TAKES_FROM];
		const own = doses.filter(
			(d) => (d.stream === 'hypertrophy' ? 'strength' : d.stream) === stream
		);
		const trains = input.goals.flatMap((g, i) =>
			g.disciplines.some((d) => SESSIONS_WANTED[d].stream === stream) ? [input.refs.goals[i]] : []
		);
		if (!own.length || trains.some((ref) => !own.some((d) => d.goal.id === ref))) continue;
		const fewest = Math.max(...own.map((d) => d.dose.sessions.min));
		const mine = sessions.flatMap((s, i) => (s.source === 'generator' && theirs(s) ? [i] : []));
		const spare = Math.min(need - taken.length, mine.length - fewest);
		for (const index of mine.reverse().slice(0, Math.max(0, spare))) {
			taken.push({ index, goal: share.goal.title });
		}
	}
	return taken;
}

/** The planned weeks' Muay Thai, custom-discipline and mobility sessions, around those placed. */
export function planOther(
	blocks: readonly BlockPlan[],
	demand: WeekDemand,
	input: ProgrammingInput,
	{ firstPlannedDay }: GenerateOptions,
	log: DecisionLog,
	dosesByWeek: Periodisation['dosesByWeek'] = []
): BlockPlan[] {
	const { allocation, budget } = demand;
	const minutes = input.sessionMinutes;
	const custom = allocation.streams.find((s) => s.stream === 'custom');
	const name = custom ? (custom.goal.customDiscipline ?? custom.goal.title) : '';
	const customPaths: string[] = [];
	/** Where each session a camp week kept now sits, by its old path: null for one it took. */
	const moved = new Map<string, string | null>();
	/** One session_dropped decision per block and taken session, citing each week. */
	const dropped = new Map<string, { refs: string[]; session: string; goal: string }>();

	const planned = blocks.map((block, b) => ({
		...block,
		weeks: block.weeks.map((week, w) => {
			let sessions = [...week.sessions];
			const open = openDates(week, budget.days, firstPlannedDay);
			const add = (all: Fields[], paths?: string[], by: IsoDate | null = null) => {
				if (!all.length) return;
				const days = by === null ? open : open.filter((d) => d <= by);
				const dates = naiveDates(sessions, days, all.length, (on) =>
					on.some((s) => s.type === all[0]!.type)
				);
				dates.forEach((date, i) => {
					paths?.push(sessionPath(b, w, sessions.length));
					sessions.push(
						otherSession(all[i]!, date, nextOrder(sessions, date), week.targets.rpeCap)
					);
				});
			};
			const combat = week.targets.combat;
			let mobilityCount = allocation.mobility;
			if (combat) {
				const camp = campSessions(input, week, combat, sessions);
				const wanted = camp.sparring.length + camp.conditioning.length + camp.muayThai.length;
				const left = roomLeft(sessions, open, demand, generatedFor(allocation, 'custom'));
				const doses = dosesByWeek.find((d) => d.startsOn === week.startsOn)?.doses ?? [];
				const taken = campTakes(wanted - left, sessions, input, demand, doses);
				const gone = new Set(taken.map((t) => t.index));
				for (const { index, goal } of taken) {
					const title = sessions[index]!.title;
					const note = dropped.get(`${b}:${title}`) ?? { refs: [], session: title, goal };
					note.refs.push(`blocks.${b}.weeks.${w}`);
					dropped.set(`${b}:${title}`, note);
				}
				sessions.forEach((_, i) => {
					const kept = i - [...gone].filter((g) => g < i).length;
					moved.set(sessionPath(b, w, i), gone.has(i) ? null : sessionPath(b, w, kept));
				});
				sessions = sessions.filter((_, i) => !gone.has(i));
				// The room, by CAMP_ORDER: sparring and conditioning by turns, then technique and pads.
				const room = left + taken.length;
				const order = CAMP_ORDER(camp.sparring.length, camp.conditioning.length).slice(0, room);
				const count = (part: 'sparring' | 'conditioning') => order.filter((o) => o === part).length;
				const sparring = camp.sparring.slice(0, count('sparring'));
				const conditioning = camp.conditioning.slice(0, count('conditioning'));
				const muayThai = camp.muayThai.slice(0, room - sparring.length - conditioning.length);
				mobilityCount = Math.min(
					mobilityCount,
					room - sparring.length - conditioning.length - muayThai.length
				);
				add(sparring, undefined, camp.sparringBy);
				add(muayThai);
				add(conditioning);
			} else {
				const mt = muayThaiKinds(input, week, generatedFor(allocation, 'muay_thai'));
				add(mt.map((kind) => muayThaiFields(kind, minutes, MUAY_THAI[kind].rounds)));
			}
			const own: Fields = {
				kind: 'custom',
				type: 'custom',
				title: clip(name, 60),
				discipline: 'custom',
				customDiscipline: clip(name, 40),
				minutes,
				rpe: CUSTOM_SESSION_RPE,
				intensity: 'moderate',
				metrics: []
			};
			add(
				Array.from({ length: generatedFor(allocation, 'custom') }, () => own),
				customPaths
			);
			const mobility: Fields = {
				kind: 'mobility',
				type: 'mobility',
				title: 'Mobility',
				// Mobility serves every goal: it counts as general athletic work.
				discipline: 'athletic',
				customDiscipline: null,
				minutes: Math.min(MOBILITY.minutes, minutes),
				rpe: MOBILITY.rpe,
				intensity: 'easy',
				metrics: []
			};
			add(Array.from({ length: mobilityCount }, () => mobility));
			return { ...week, sessions };
		})
	}));

	if (moved.size) {
		log.retarget((ref) => {
			const [, session, rest] = /^(blocks\.\d+\.weeks\.\d+\.sessions\.\d+)(.*)$/.exec(ref) ?? [];
			const to = session === undefined ? undefined : moved.get(session);
			return to === undefined ? ref : to === null ? null : to + rest;
		});
	}
	for (const { refs, session, goal } of dropped.values()) {
		log.add('session_dropped', 'generator.camp_room', refs, {
			session: clip(session, 80),
			reason: clip(
				`the fight camp takes the days ${goal} can spare while it is held at its dose`,
				200
			)
		});
	}
	if (custom && generatedFor(allocation, 'custom')) {
		const count = generatedFor(allocation, 'custom');
		log.add('default_assumed', 'other.custom_sessions', customPaths, {
			missing: clip(`You haven’t told the coach what your ${name} sessions hold.`, 200),
			assumed: clip(
				`${count} ${name} session${count > 1 ? 's' : ''} a week of ${minutes} min at RPE ${CUSTOM_SESSION_RPE}`,
				200
			),
			rationale:
				'Their content is your own: the coach plans their time and effort around the rest of your week, and you decide what goes in them.',
			section: STEP_INFO.schedule.title
		});
	}
	return planned;
}
