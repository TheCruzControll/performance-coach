/**
 * A session added to the active program (PRD §5): one session of the kind, intent, day and length
 * asked for, built by the generator's own builders from the owner's profile. The coach never
 * writes its content. Its RPEs are capped at the week's RPE cap, and its length is the one asked
 * for, or the kind's own, trimmed to fit where it can be:
 * - run: one easy run; or a moderate run of tempo, or a hard one of intervals (QUALITY's repeats),
 *   each with a warm-up and cool-down, which needs QUALITY's minimum main set (else a refusal)
 * - muay_thai: the Muay Thai format of its intent (other.ts), pad work for a hard one when the
 *   owner does no sparring
 * - conditioning: a conditioning session at its intent's RPE (rules/added.ts)
 * - strength, hypertrophy: one day of a split of its own (splits.ts) with exercises from the
 *   selection (selection.ts), fitted to its length (timefit.ts)
 *
 * It is placed at order 1 and at the owner's time of day, or left open. The result passes
 * sessionPlanSchema. A request the builders cannot meet throws AddRefusal, naming its field.
 *
 * Pure: no clock, no randomness, no I/O.
 */
import type { AddIntent, AddSessionInput } from '../training/edits.ts';
import { sessionLoadOf } from '../training/metrics.ts';
import { sessionPlanSchema } from '../training/schemas.ts';
import type { RunSegment, SessionPlan, WeekPlan } from '../training/types.ts';
import { SESSION_TYPE_LABEL } from '../training/vocabulary.ts';
import type { Discipline } from '../profile/catalog.ts';
import { validate } from '../validation.ts';
import { DecisionLog } from './decisions.ts';
import { muayThaiFields, otherSession } from './other.ts';
import type { ProgrammingInput } from './input.ts';
import {
	CONDITIONING,
	DEFAULT_INTENT,
	MUAY_THAI_KIND,
	RUN_TYPE,
	STRENGTH_RPE
} from './rules/added.ts';
import * as R from './rules/running.ts';
import { pacesOf, segment } from './running.ts';
import type { Paces } from './running.ts';
import { selectWeek } from './selection.ts';
import { addedSplit, strengthDiscipline } from './splits.ts';
import { sessionOn } from './stages/strength.ts';
import { fitSession } from './timefit.ts';

/** A request the builder refuses, naming the field of the request it is about. */
export class AddRefusal extends Error {
	readonly field: string;

	constructor(field: string, message: string) {
		super(message);
		this.name = 'AddRefusal';
		this.field = field;
	}
}

/** The shortest moderate or hard run: a warm-up, a cool-down and QUALITY's minimum main set. */
const RUN_MIN_MINUTES =
	R.QUALITY.warmUpMinutes + R.QUALITY.coolDownMinutes + R.QUALITY.minMainMinutes;

/** The session on the owner's time of day (open when none is given), first on its day. */
const placed = (session: SessionPlan, req: AddSessionInput): SessionPlan => ({
	...session,
	date: req.date,
	timeOfDay: req.timeOfDay ?? null,
	orderInDay: 1
});

/** A run's minutes and segments: one easy segment, or warm-up, the main set and cool-down. */
function runSegments(
	intent: AddIntent,
	length: number,
	paces: Paces
): { minutes: number; segments: RunSegment[] } {
	if (intent === 'easy') {
		return { minutes: length, segments: [segment('easy', paces.easy, { minutes: length })] };
	}
	if (length < RUN_MIN_MINUTES) {
		throw new AddRefusal(
			'durationMinutes',
			`A moderate or hard run needs at least ${RUN_MIN_MINUTES} minutes`
		);
	}
	const { warmUpMinutes: warm, coolDownMinutes: cool, intervals } = R.QUALITY;
	const ends = (middle: RunSegment[]) => [
		segment('warm_up', paces.easy, { minutes: warm }),
		...middle,
		segment('cool_down', paces.easy, { minutes: cool })
	];
	const main = length - warm - cool;
	if (intent === 'moderate') {
		return {
			minutes: length,
			segments: ends([segment('tempo', paces.quality, { minutes: main })])
		};
	}
	const { workMinutes: work, recoveryMinutes: jog } = intervals;
	const reps = Math.min(intervals.reps, Math.max(2, Math.floor(main / (work + jog))));
	return {
		minutes: warm + reps * (work + jog) + cool,
		segments: ends([
			segment('interval', paces.quality, { minutes: work }, reps),
			segment('recovery', null, { minutes: jog }, reps)
		])
	};
}

function runOf(
	req: AddSessionInput,
	intent: AddIntent,
	cap: number,
	input: ProgrammingInput
): SessionPlan {
	const type = RUN_TYPE[intent];
	const length =
		intent === 'easy'
			? (req.durationMinutes ?? R.TIME_BASED_WEEK.easyMinutes)
			: (req.durationMinutes ?? input.sessionMinutes);
	const { minutes, segments } = runSegments(intent, length, pacesOf(input.running));
	const targetRpe = Math.min(R.RUNS[type].sessionRpe, cap);
	return placed(
		{
			kind: 'run',
			date: req.date,
			timeOfDay: null,
			orderInDay: 1,
			type,
			title: SESSION_TYPE_LABEL[type],
			discipline: input.disciplines.includes('distance_running') ? 'distance_running' : 'running',
			customDiscipline: null,
			intensity: R.RUNS[type].intensity,
			estMinutes: minutes,
			estLoad: sessionLoadOf({ estMinutes: minutes, targetRpe }),
			targetRpe,
			source: 'generator',
			commitmentRef: null,
			instructions: null,
			notes: null,
			segments: segments.map((s) => ({ ...s, targetRpe: Math.min(s.targetRpe!, cap) }))
		},
		req
	);
}

function muayThaiOf(
	req: AddSessionInput,
	intent: AddIntent,
	cap: number,
	input: ProgrammingInput
): SessionPlan {
	const sparring = (input.muayThai?.sparringPerWeek ?? 0) > 0;
	const kind = intent === 'hard' && !sparring ? 'pad_work' : MUAY_THAI_KIND[intent];
	const minutes = req.durationMinutes ?? input.sessionMinutes;
	return placed(otherSession(muayThaiFields(kind, minutes), req.date, 1, cap), req);
}

function conditioningOf(req: AddSessionInput, intent: AddIntent, cap: number): SessionPlan {
	return placed(
		otherSession(
			{
				kind: 'conditioning',
				type: 'conditioning',
				title: CONDITIONING.title,
				discipline: 'athletic',
				customDiscipline: null,
				intensity: intent,
				minutes: req.durationMinutes ?? CONDITIONING.minutes,
				rpe: CONDITIONING.rpe[intent],
				metrics: []
			},
			req.date,
			1,
			cap
		),
		req
	);
}

function strengthOf(
	req: AddSessionInput,
	intent: AddIntent,
	week: WeekPlan,
	input: ProgrammingInput
): SessionPlan {
	const top = strengthDiscipline(input);
	const discipline: Discipline =
		req.kind === 'hypertrophy' ? 'hypertrophy' : top && top !== 'hypertrophy' ? top : 'strength';
	const split = addedSplit(discipline, week.sessions.filter((s) => s.kind === 'strength').length);
	const selection = selectWeek(split, input, new DecisionLog())[0]!;
	if (selection.exercises.length === 0) {
		throw new AddRefusal('kind', 'No exercises fit your equipment and injuries');
	}
	const rpeCap = Math.min(STRENGTH_RPE[intent], week.targets.rpeCap);
	const session = sessionOn(
		req.date,
		selection,
		split,
		{ ...week, targets: { ...week.targets, rpeCap } },
		[],
		input
	);
	const limit = req.durationMinutes ?? input.sessionMinutes;
	const fitted = session.estMinutes > limit ? fitSession(session, input, limit).session : session;
	return placed(fitted, req);
}

/**
 * The session an added request asks for, in `week`, built from the owner's profile in `input`.
 * An omitted intent takes its kind's default (rules/added.ts). Throws AddRefusal when the request
 * cannot be built, and throws an Error when a builder breaks the session contract (a bug).
 */
export function buildAddedSession(
	req: AddSessionInput,
	week: WeekPlan,
	input: ProgrammingInput
): SessionPlan {
	const intent = req.intent ?? DEFAULT_INTENT[req.kind];
	const cap = week.targets.rpeCap;
	const session =
		req.kind === 'run'
			? runOf(req, intent, cap, input)
			: req.kind === 'muay_thai'
				? muayThaiOf(req, intent, cap, input)
				: req.kind === 'conditioning'
					? conditioningOf(req, intent, cap)
					: strengthOf(req, intent, week, input);
	const checked = validate(sessionPlanSchema, session);
	if (!checked.ok) {
		const [path, why] = Object.entries(checked.errors)[0] ?? ['', 'Invalid'];
		throw new Error(`The added session breaks the contract at ${path || 'its root'}: ${why}`);
	}
	return checked.data;
}
