/**
 * Zone 2 on the bike instead of some easy runs (rules/running.ts ZONE2_BIKE), right after the
 * runs are planned, so placement, the doubles, progression and the time fit see the bike
 * session as it is:
 * - Only with a bike in the owner's kit, and only for runs that serve a goal training more than
 *   running. A goal about running itself, or one with a race ahead, keeps its easy runs: there
 *   only recovery runs may move to the bike.
 * - In each planned week, ZONE2_BIKE.share of the generated easy runs, rounded up, become bike
 *   sessions, the latest first, so the week's first easy run stays a run. The week always keeps
 *   ZONE2_BIKE.keepRuns actual runs, a running commitment or a long or quality run counting.
 * - A bike session is an 'other' session of type 'conditioning': its minutes, RPE, load and day
 *   are the run's, but it carries no run segments, so it never counts toward running volume,
 *   run progression or running analytics. It still fills the run's place in the week.
 * One exercise_substituted decision cites every converted session.
 *
 * Pure: no clock, no randomness, no I/O.
 */
import { RUNNING_DISCIPLINES } from '../profile/catalog.ts';
import type {
	BlockPlan,
	OtherSessionPlan,
	RunSessionPlan,
	SessionPlan
} from '../training/types.ts';
import { SESSION_TYPE_LABEL } from '../training/vocabulary.ts';
import { sessionPath } from './commitments.ts';
import type { DecisionLog } from './decisions.ts';
import type { WeekDemand } from './demand.ts';
import { weeksToEvent } from './input.ts';
import type { ProgrammingInput } from './input.ts';
import { ZONE2_BIKE } from './rules/running.ts';
import type { GenerateOptions } from './stage.ts';

/** A decision names at most this many plan paths (programPlanSchema). */
const MAX_REFS = 50;
const percent = (share: number) => Math.round(share * 100);
const ZONE = `${percent(ZONE2_BIKE.hrMaxShare[0])}–${percent(ZONE2_BIKE.hrMaxShare[1])}%`;

/** The words a bike session carries: what zone 2 is, so the owner can hold it. */
export const ZONE2_WORDS = {
	instructions: (minutes: number) =>
		`Stationary bike for ${minutes} min at a steady, easy effort. A spin or air bike works too.`,
	notes: `Zone 2: a pace you could hold a conversation at, about ${ZONE} of your max heart rate. If you can't talk in full sentences, ease off.`
} as const;

/** Whether this owner's easy runs may move to the bike, and which run types may. */
function convertible(input: ProgrammingInput, demand: WeekDemand, startsOn: string) {
	if (!input.equipment.includes(ZONE2_BIKE.equipment)) return null;
	const share = demand.allocation.streams.find((s) => s.stream === 'runs');
	if (!share) return null;
	const runningOnly = share.goal.disciplines.every((d) => RUNNING_DISCIPLINES.includes(d));
	const goals = input.maintenance ? input.paused : input.goals;
	const race = goals.some(
		(g) =>
			g.disciplines.some((d) => RUNNING_DISCIPLINES.includes(d)) &&
			(weeksToEvent(g, startsOn) ?? -1) >= 0
	);
	return new Set<string>(runningOnly || race ? ZONE2_BIKE.convertWithRace : ZONE2_BIKE.convert);
}

function bikeSession(run: RunSessionPlan): OtherSessionPlan {
	const { segments: _segments, kind: _kind, ...base } = run;
	return {
		...base,
		kind: 'other',
		type: 'conditioning',
		title: ZONE2_BIKE.title,
		intensity: 'easy',
		instructions: ZONE2_WORDS.instructions(run.estMinutes),
		notes: ZONE2_WORDS.notes,
		details: {
			kind: 'conditioning',
			durationMinutes: run.estMinutes,
			targetRpe: run.targetRpe,
			metrics: [],
			notes: ZONE2_WORDS.notes
		}
	};
}

const byDay = (a: SessionPlan, b: SessionPlan) =>
	a.date < b.date ? -1 : a.date > b.date ? 1 : a.orderInDay - b.orderInDay;

/** The planned weeks with ZONE2_BIKE's share of their easy runs on the bike. */
export function planZone2Bike(
	blocks: readonly BlockPlan[],
	demand: WeekDemand,
	input: ProgrammingInput,
	{ startsOn }: GenerateOptions,
	log: DecisionLog
): BlockPlan[] {
	const types = convertible(input, demand, startsOn);
	if (!types) return [...blocks];
	const paths: string[] = [];
	const planned = blocks.map((block, b) => ({
		...block,
		weeks: block.weeks.map((week, w) => {
			const runs = week.sessions.filter((s): s is RunSessionPlan => s.kind === 'run');
			const candidates = runs
				.filter((r) => r.source === 'generator' && types.has(r.type))
				.sort(byDay);
			const kept = runs.length - candidates.length;
			const n = Math.min(
				Math.ceil(candidates.length * ZONE2_BIKE.share),
				Math.max(0, kept + candidates.length - ZONE2_BIKE.keepRuns)
			);
			if (n === 0) return week;
			const moving = new Set<SessionPlan>(candidates.slice(candidates.length - n));
			return {
				...week,
				sessions: week.sessions.map((s, i) => {
					if (!moving.has(s)) return s;
					paths.push(sessionPath(b, w, i));
					return bikeSession(s as RunSessionPlan);
				})
			};
		})
	}));
	if (paths.length) {
		const original = SESSION_TYPE_LABEL.easy_run;
		log.add('exercise_substituted', 'running.zone2_bike', paths.slice(0, MAX_REFS), {
			exercise: ZONE2_BIKE.title,
			original,
			reason: `you have a bike, and riding gives the same easy aerobic work without the pounding, so your legs stay fresher for the rest of your week; ${paths.length === 1 ? 'one easy run moves' : 'some easy runs move'} to it, and every week keeps at least one run`,
			intent: `easy aerobic minutes in zone 2, about ${ZONE} of your max heart rate, at a pace you could talk at.`
		});
	}
	return planned;
}
