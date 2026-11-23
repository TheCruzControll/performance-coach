/**
 * Reactive deloads (m7-plan reactive-deload; PRD §5, §11): a weekly review that finds high fatigue
 * or a real decline proposes a deload of the week after the reviewed one, in place, through M5's
 * lifecycle, instead of M6's −40 % sets on the main lifts. Imported by path, like the rest of
 * services/periodisation.
 *
 * The snapshot both take is the composed one: composeWeeklyReview's, before the review's own
 * `no_changes` is applied (services/reviews/weekly.ts). That reason is set when next week has no
 * changes, and deloadTargetWeek returns null for it, so it must not be in the snapshot here.
 *
 * - deloadTargetWeek: M6's next week when the review may still change it, or the week holding
 *   the review's day when next week ended exactly one week before (a late review); none at a
 *   block's boundary or with no program, where M6's path stands. It returns null for a noProposal
 *   of `no_changes` and for any next.state other than `planned`.
 * - assessDeload runs the domain's deloadNeed over what the review already holds: the snapshot's
 *   fatigue, its lifts' e1RM verdicts and its easy-run paces, the load model's days from the
 *   review's evaluation context (built on its own facts loader; read only with OVERLOAD_TRIGGER)
 *   and its plan's weeks. So it adds no query at all. Its guards keep M6's path when a light week
 *   is planned in or just after the target week, or a deload ended within 14 days.
 * - proposeDeload asks proposeReplan for a deload directive of that week, with the reasons, on
 *   deps.db: in a review's transaction, under the owner lock it already holds, never on a second
 *   connection.
 */
import { addDays, mondayOf, type IsoDate } from '../../../domain/calendar';
import { TREND_METHOD, type TrendResult } from '../../../domain/analytics/trend';
import {
	deloadNeed,
	type CalendarWeek,
	type DeloadNeed,
	type LiftTrend
} from '../../../domain/programming/periodisation/deload';
import type { WeeklyReviewSnapshot } from '../../../domain/programming/review/snapshot';
import { TRENDING_DOWN } from '../../../domain/programming/review/weekly';
import { REPLAN_REASONS } from '../../../domain/training/replan';
import type { EvaluationContext } from './context';
import {
	proposeReplan,
	type ProposeDeps,
	type ProposedReplan,
	type ReplanRequest
} from './propose';

/**
 * Owner decision (m7-plan open question 'reactive deload'): a weekly review that finds high
 * fatigue or a real decline proposes a deload of the week after it instead of M6's −40 % sets on
 * the main lifts. false: every review keeps M6's next-week changes.
 */
export const REACTIVE_DELOAD = true;

/**
 * Owner decision (m7-plan open question 'reactive deload'; the plan's third trigger): whether a
 * system overloaded on 5 of the last 7 days triggers a deload on its own. false: the load model,
 * as calibrated, reads a normal hybrid week (two lifting days, two runs, a class and sparring at
 * RPE 7 to 8) as lower body overloaded on 7 of 7 days, so every review would deload. Until its
 * calibration is confirmed, a review deloads on M6's signals only: high fatigue, or watch with a
 * real decline. true: the overload trigger as the plan states it.
 */
export const OVERLOAD_TRIGGER = false;

/**
 * The week a review's deload would change, or null when M6's path stands. A late review targets
 * the week holding `today` only when that is the week exactly one week after next week ended;
 * a review two or more weeks late is stale, and its signals are not acted on.
 */
export function deloadTargetWeek(snapshot: WeeklyReviewSnapshot, today: IsoDate): IsoDate | null {
	if (snapshot.noProposal === 'late') {
		const week = mondayOf(today);
		return week === addDays(snapshot.next.weekStartsOn, 7) ? week : null;
	}
	if (snapshot.next.state !== 'planned' || snapshot.noProposal !== null) return null;
	return snapshot.next.weekStartsOn;
}

/** A real decline, as the review's verdict found it (trendCall's words for a lift going down). */
const declining = (change: number | null): TrendResult => ({
	...{ verdict: 'real_trend', direction: 'down', good: false, method: TREND_METHOD },
	...{ n: 0, spanDays: 0, slopePerWeek: null, change, changePct: null, noise: null },
	...{ minChange: null, p: null, outliers: [] }
});

/**
 * The main lifts' e1RM verdicts the review stored ('verdicts:e1rm:<lift>'): a lift whose verdict
 * is 'Trending down, declining' reads as a real decline; any other verdict as none.
 */
export function liftTrendsOf(snapshot: WeeklyReviewSnapshot): LiftTrend[] {
	return snapshot.brief.findings
		.filter((f) => f.id.startsWith('verdicts:e1rm:'))
		.map((f) => ({
			name: f.label.replace(/ estimated 1RM$/, ''),
			trend:
				f.verdict.level === 'watch' && f.verdict.words.startsWith(TRENDING_DOWN)
					? declining(f.figures[0]?.value ?? null)
					: null
		}));
}

/** The easy runs' pace this week and the week before, in seconds per km; null without both. */
export function easyPaceOf(snapshot: WeeklyReviewSnapshot) {
	const pace = snapshot.brief.findings.find((f) => f.id === 'running:pace:easy_run');
	const [recent, before] = [pace?.figures[0]?.value ?? null, pace?.figures[1]?.value ?? null];
	return recent === null || before === null ? null : { before, recent };
}

export interface AssessDeload {
	/** The owner's local today. */
	today: IsoDate;
	snapshot: WeeklyReviewSnapshot;
	/** The Monday of the week a deload would change (deloadTargetWeek). */
	targetWeek: IsoDate;
}

export interface AssessDeps {
	/** The review's evaluation context: the load model's days through the reviewed week. */
	context: Pick<EvaluationContext, 'load'>;
	/** The current version's weeks, for the guards. */
	calendar: readonly CalendarWeek[];
}

/** Whether the reviewed week calls for a deload of `targetWeek`, and why, as the header says. */
export function assessDeload(
	{ today, snapshot, targetWeek }: AssessDeload,
	{ context, calendar }: AssessDeps
): DeloadNeed {
	const sunday = addDays(snapshot.weekStartsOn, 6);
	return deloadNeed({
		fatigue: snapshot.fatigue,
		trends: { lifts: liftTrendsOf(snapshot), easyPace: easyPaceOf(snapshot) },
		overload: OVERLOAD_TRIGGER
			? { days: context.load.days, today: today < sunday ? today : sunday }
			: null,
		calendar,
		targetWeek
	});
}

/**
 * `reasons` as a deload directive holds them: trimmed, non-empty, at most 5 of 160 characters.
 * Past 5, the first 4 and the last are kept. deloadNeed lists a fatigue's reasons first and the
 * trend reasons (declining lifts, slower easy runs) after them, so the last one is a trigger on
 * its own: a watch-with-decline deload is met by either trend reason.
 */
export function deloadReasons(reasons: readonly string[]): string[] {
	const { max, length } = REPLAN_REASONS;
	const kept = reasons.map((r) => r.trim()).filter((r) => r.length > 0);
	const chosen = kept.length > max ? [...kept.slice(0, max - 1), kept.at(-1)!] : kept;
	return chosen.map((r) => (r.length <= length ? r : `${r.slice(0, length - 1).trimEnd()}…`));
}

/** Who asks for a deload, as ReplanRequest has it: a weekly review names its review. */
type DeloadOrigin = ReplanRequest extends infer R
	? R extends unknown
		? Omit<R, 'today' | 'directive'>
		: never
	: never;

/** A deload's request: the week to deload (its Monday), the reasons, and who asks. */
export type ProposeDeload = DeloadOrigin & {
	today: IsoDate;
	week: IsoDate;
	reasons: readonly string[];
};

/** Propose a deload of `week` with its reasons, through proposeReplan on deps.db. */
export function proposeDeload(
	ownerId: string,
	{ week, reasons, ...request }: ProposeDeload,
	deps: ProposeDeps = {}
): Promise<ProposedReplan> {
	const trigger =
		request.source === 'coach' || request.source === 'owner' ? request.source : 'reactive';
	return proposeReplan(
		ownerId,
		{ ...request, directive: { kind: 'deload', week, trigger, reasons: deloadReasons(reasons) } },
		deps
	);
}
