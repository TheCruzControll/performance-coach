/**
 * The weeks after the baseline (PRD §5): each built from its own targets (rules/blocks.ts: RPE
 * cap, load step, volume factor) by the loads rules (rules/loads.ts), which the block stores as its
 * progression, so M4 and M6 can call progressWeeks again with a block's stored copy.
 *
 * Loads, on each main lift (../loads.ts):
 * - A known 1RM: week 1's baselineShare plus each later week's load step (+2.5 % a building week,
 *   −10 % the deload), never above M1's table for the reps at that week's cap, an estimate
 *   estimateDiscount under it: percent_1rm of the same snapshot.
 * - A blank 1RM: from_e1rm at M1's table share for the reps at the week's cap, so when the session
 *   comes its load is loadForTarget(latest e1RM, reps, cap). A lift with a blank 1RM that is not in
 *   an earlier week (week 1 began mid-week) gets its baseline set in its first week instead.
 * - Back-offs at backOffShare of the top set.
 *
 * Volume, on every strength session: a week whose volume factor is above 1 gives each exercise
 * with a top set extraMainSets more back-off sets; one under 1 (a deload, taper or event week)
 * keeps that share of the session's sets (keepShare). The week's RPE cap, 6 for the deload,
 * already bounds every set. The timefit stage runs after, so every added set is checked against
 * the session length.
 */
import { percentOfOneRepMax } from '../rpe.ts';
import { sessionLoadOf } from '../training/metrics.ts';
import type {
	BaselineLift,
	PlannedExercisePlan,
	SetPrescription,
	WeekPlan,
	WeekTargets
} from '../training/types.ts';
import type { LoadBasis, WeekKind } from '../training/vocabulary.ts';
import { cleanFloat } from '../units.ts';
import type { ProgrammingInput } from './input.ts';
import { baselineShare, eachMain, loadBaseline, loadMain, roundShare, topReps } from './loads.ts';
import type { MainLift } from './loads.ts';
import { LOAD_RULES } from './rules/loads.ts';
import type { LoadRules } from './rules/loads.ts';
import { estimateMinutes } from './timefit.ts';

/**
 * The share of a known 1RM a top set of `reps` is in the last week of `weeks` (their targets, the
 * block's first week first). Null off M1's table.
 */
export function knownShare(
	reps: number,
	basis: LoadBasis,
	weeks: readonly WeekTargets[],
	rules: LoadRules = LOAD_RULES
): number | null {
	const [first, ...later] = weeks;
	let share = first ? baselineShare(reps, first.rpeCap, basis, rules) : null;
	const discount = basis === 'estimated' ? rules.estimateDiscount : 0;
	for (const { rpeCap, loadStep } of later) {
		const table = percentOfOneRepMax(reps, rpeCap);
		if (share === null || table === null) return null;
		share = roundShare(Math.min(share + loadStep, table - discount), rules);
	}
	return share;
}

/**
 * `exercises` keeping `factor` of their sets, rounded: one set at a time off the line with the
 * most, the last of equals, never off a top set or a line's last set.
 */
export function keepShare(
	exercises: readonly PlannedExercisePlan[],
	factor: number
): PlannedExercisePlan[] {
	const kept = exercises.map((e) => ({ ...e, sets: e.sets.map((line) => ({ ...line })) }));
	const lines = kept.flatMap((e) => e.sets);
	const total = lines.reduce((n, line) => n + line.sets, 0);
	for (let over = total - Math.round(total * factor); over > 0; over--) {
		let most: SetPrescription | undefined;
		for (const line of lines) {
			if (line.role !== 'top' && line.sets > 1 && line.sets >= (most?.sets ?? 2)) most = line;
		}
		if (!most) break;
		most.sets -= 1;
	}
	return kept;
}

/** `exercises` with `extra` more back-off sets on each one with a top set. */
const withExtraSets = (exercises: readonly PlannedExercisePlan[], extra: number) =>
	exercises.map((e) =>
		e.sets.some((line) => line.role === 'top')
			? {
					...e,
					sets: e.sets.map((line) =>
						line.role === 'back_off' ? { ...line, sets: line.sets + extra } : line
					)
				}
			: e
	);

/** `week`'s strength sessions with its volume factor applied. */
function withVolume(week: WeekPlan, input: ProgrammingInput, rules: LoadRules): WeekPlan {
	const factor = week.targets.volumeFactor;
	if (factor === 1) return week;
	const sessions = week.sessions.map((session) => {
		if (session.kind !== 'strength') return session;
		const exercises =
			factor > 1
				? withExtraSets(session.exercises, rules.extraMainSets)
				: keepShare(session.exercises, factor);
		const estMinutes = estimateMinutes({ exercises }, input);
		const estLoad = sessionLoadOf({ estMinutes, targetRpe: session.targetRpe });
		return { ...session, exercises, estMinutes, estLoad };
	});
	return { ...week, sessions };
}

/** The baseline lifts of `week`'s main lifts. */
function liftsIn(week: WeekPlan, input: ProgrammingInput): BaselineLift[] {
	const lifts: BaselineLift[] = [];
	eachMain(week, input, (planned, { lift }) => {
		lifts.push(lift);
		return planned;
	});
	return lifts;
}

/**
 * A main lift in the last of `weeks` (their targets, the block's first week first): knownShare of
 * a known 1RM, M1's table share of the estimate otherwise.
 */
function loadLater(
	planned: PlannedExercisePlan,
	main: MainLift,
	weeks: readonly WeekTargets[],
	rules: LoadRules
): PlannedExercisePlan {
	const reps = topReps(planned);
	const { rpeCap } = weeks.at(-1)!;
	const share =
		reps === null
			? null
			: main.oneRepMax
				? knownShare(reps, main.oneRepMax.kind, weeks, rules)
				: percentOfOneRepMax(reps, rpeCap);
	return share === null ? planned : loadMain(planned, main, share, false, rules);
}

/** `weeks`, the block's, with every week but the baseline built by its targets and `rules`. */
export function progressWeeks(
	weeks: readonly WeekPlan[],
	input: ProgrammingInput,
	rules: LoadRules = LOAD_RULES
): WeekPlan[] {
	const seen = new Set<BaselineLift>();
	return weeks.map((week, w) => {
		const targets = weeks.slice(0, w + 1).map((x) => x.targets);
		const load = (planned: PlannedExercisePlan, main: MainLift) =>
			main.oneRepMax || seen.has(main.lift)
				? loadLater(planned, main, targets, rules)
				: loadBaseline(planned, main, week.targets.rpeCap, rules);
		const built =
			week.kind === 'baseline' ? week : withVolume(eachMain(week, input, load), input, rules);
		for (const lift of liftsIn(week, input)) seen.add(lift);
		return built;
	});
}

/** Whether `weeks` load a main lift from a known 1RM, and whether one from an estimate of it. */
export function loadSources(weeks: readonly WeekPlan[], input: ProgrammingInput) {
	const sources = { known: false, estimate: false };
	for (const week of weeks) {
		eachMain(week, input, (planned, { oneRepMax }) => {
			sources[oneRepMax ? 'known' : 'estimate'] = true;
			return planned;
		});
	}
	return sources;
}

const BUILDS =
	'Each week builds on the one before, a little heavier and harder, every set held to its RPE.';

/** Why a week of each kind moves as it does; any other kind follows the block's rules. */
const BECAUSE: Partial<Record<WeekKind, string>> = {
	accumulation: BUILDS,
	build: BUILDS,
	deload:
		'The deload absorbs the block: fewer sets, none above its RPE cap, so the fatigue clears.',
	taper:
		'A taper keeps the intensity and cuts the volume, so you arrive at your event fresh and sharp.',
	event: 'It is your event’s week: little besides staying loose.'
};

const FROM_ESTIMATE =
	' Loads from your estimated 1RM follow the RPE, and your logged sets keep the estimate current.';

const percent = (n: number) => `${cleanFloat(Math.abs(n) * 100, 1)} %`;

/**
 * What a progression decision says about `week`, the block's week `number` (from 1), whose main
 * lifts load from the `sources` loadSources gives. A load step applies to known 1RMs only.
 */
export function progressionFacts(
	week: WeekPlan,
	number: number,
	sources: ReturnType<typeof loadSources>,
	rules: LoadRules = LOAD_RULES
) {
	const { rpeCap, loadStep, volumeFactor } = week.targets;
	const extra = rules.extraMainSets;
	const change = [
		`top sets at RPE ${rpeCap}`,
		loadStep && sources.known
			? `loads from a known 1RM ${loadStep > 0 ? '+' : '−'}${percent(loadStep)}`
			: null,
		volumeFactor > 1
			? `${extra === 1 ? 'a' : extra} back-off set${extra === 1 ? '' : 's'} more on each main lift`
			: null,
		volumeFactor < 1 ? `${percent(1 - volumeFactor)} fewer sets` : null
	];
	const why = BECAUSE[week.kind] ?? 'It follows the block’s progression rules.';
	return {
		week: number,
		change: change.filter((part) => part !== null).join(', '),
		reason: sources.estimate ? `${why}${FROM_ESTIMATE}` : why,
		rpeCap,
		loadStep,
		volumeFactor
	};
}
