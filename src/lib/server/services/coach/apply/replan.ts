/**
 * Applying a replan (m7-plan replan-proposals; PRD §5, §14; the replans-as-versions ADR): inside
 * the accept transaction, previewReplan runs again on it, and the stored payload is held to what
 * it shows now. Nothing stale is ever stored:
 * - a moved base → M5's program_changed
 * - a regenerate or splice whose `from` has passed, or has something logged or skipped from it
 *   (the preview starts later) → start_passed
 * - a different fingerprint (today's profile, the directive, the base, `from`) → profile_changed
 * - a different shape (phases, week kinds and dates, sessions, never loads) → plan_changed
 * - a deload whose week has no session still ahead (the preview refuses nothing_ahead) → M6's
 *   sessions_passed
 * Otherwise the preview is stored once: storeReplan for a regenerate or a splice, reviseDeload for
 * a deload, with loads refreshed from the latest results (the preview's actuals overlay) and
 * recorded in its first decision. A weekly review's re-plan (evidence.source weekly_review) also
 * writes M6's review_applied decision naming the review on the sessions of the weeks it changed,
 * so Train's weekChanges finds it exactly as for M6's own proposals. acceptProposal adds
 * proposeAgain to every superseded replan. A replan refused at accept by today's rules because its
 * start or week has passed is superseded instead (replanEnded).
 */
import type { IsoDate } from '../../../../domain/calendar';
import { RULE_MESSAGES } from '../../../../domain/coach/proposal-rules';
import type { Proposal } from '../../../../domain/coach/proposals';
import type { SupersededReason } from '../../../../domain/coach/vocabulary';
import { render, TEMPLATES } from '../../../../domain/programming/decisions';
import { MECHANISMS } from '../../../../domain/programming/rules/replan';
import type { DecisionPlan, SessionPlan } from '../../../../domain/training/types';
import { PHASE_LABEL, type Decider } from '../../../../domain/training/vocabulary';
import type { FieldErrors } from '../../../../domain/validation';
import { createCoachProposalsRepository } from '../../../db/repositories/coach-proposals';
import { createProgramsRepository } from '../../../db/repositories/programs';
import { previewReplan, type PreviewDeps, type ReplanPreview } from '../../periodisation/preview';
import { getProgramVersion } from '../../programs/index';
import type { StoredSession } from '../../programs/mapping';
import { reviseDeload, storeReplan, type DeloadRevision } from '../../programs/replan';
import type { CopyChanges, RevisionDecision } from '../../programs/revise';
import { ProgramConflictError } from '../../training/shared';
import { REVIEW_APPLIED_RULE } from './program';
import type { ApplyInput, ApplyOutcome, Appliers } from './types';

const SESSIONS_PASSED = 'sessions_passed' satisfies SupersededReason;
const superseded = (reason: SupersededReason): ApplyOutcome => ({ status: 'superseded', reason });

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '23 Nov'. */
const dayMonth = (date: IsoDate) =>
	`${Number(date.slice(8))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;
const clip = (text: string, max = 200) =>
	text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/**
 * A replan that today's rules refuse at accept because its time has gone: a deload's week is
 * over (sessions_passed), or a regenerate's or splice's Monday has passed (start_passed). Null for
 * any other refusal, which stays a refusal.
 */
export function replanEnded(proposal: Proposal, errors: FieldErrors): SupersededReason | null {
	if (proposal.kind !== 'replan') return null;
	if (errors['payload.directive.week'] === RULE_MESSAGES.past) return SESSIONS_PASSED;
	return errors['payload.from'] === RULE_MESSAGES.startPassed ? 'start_passed' : null;
}

/** The new version's summary in History. */
function summaryOf({ directive }: ReplanPreview, event: string | undefined): string {
	switch (directive.kind) {
		case 'priorities':
			return 'Re-planned for your new priorities';
		case 'block':
			return `Re-planned for a ${PHASE_LABEL[directive.phase].toLowerCase()} block`;
		case 'taper':
			return event ? `A taper before ${event}` : 'A taper before your event';
		case 'deload':
			return `A deload in the week of ${dayMonth(directive.week)}`;
	}
}

/** Where the loads came from: the latest results, or the profile when there were none yet. */
const loadsWords = ({ assumptions }: ReplanPreview) =>
	clip(
		assumptions.length
			? `Refreshed from your latest results: ${assumptions.map((a) => a.field).join(', ')}`
			: 'From your profile: no complete week of results yet'
	);

/**
 * The block-level refs of a splice's decisions, renumbered from the engine's plan (its blocks
 * whole) to the store's (a block running across the taper's weeks cut around them).
 */
function spliceRefs(preview: ReplanPreview, from: IsoDate, end: IsoDate): DecisionPlan[] {
	const { blocks } = preview.replan.plan;
	const first = blocks.findIndex((b) => b.endsOn >= from);
	const last = blocks.findLastIndex((b) => b.startsOn <= end);
	const shift = blocks[first]!.startsOn < from ? 1 : 0;
	const tail = blocks[last]!.endsOn > end ? 1 : 0;
	const at = (i: number) => (i < first ? i : i <= last ? i + shift : i + shift + tail);
	return preview.replan.decisions.map((d) => ({
		...d,
		refs: d.refs.map((r) =>
			r.replace(/^blocks\.(\d+)/, (_, i: string) => `blocks.${at(Number(i))}`)
		)
	}));
}

/** Store a regenerate or a splice as version N + 1; its id. */
async function storeChange(input: ApplyInput<'replan'>, preview: ReplanPreview, by: Decider) {
	const { replan, from } = preview;
	const mechanism = preview.mechanism === 'regenerate' ? 'regenerate' : 'splice';
	const plan = replan.plan;
	let storage: { from: IsoDate; blocks: typeof plan.blocks; outline: typeof plan.blocks };
	let decisions = replan.decisions;
	let event: string | undefined;
	if (mechanism === 'regenerate') {
		const added = plan.blocks.filter((b) => b.startsOn >= from);
		const blocks = added.filter((b) => !b.outline);
		storage = { from, blocks, outline: added.filter((b) => b.outline) };
	} else {
		const changed = replan.weeks;
		const start = changed[0]!.startsOn;
		const end = changed.at(-1)!.endsOn;
		const blocks = plan.blocks
			.filter((b) => b.endsOn >= start && b.startsOn <= end)
			.map((b) => ({
				...b,
				startsOn: b.startsOn < start ? start : b.startsOn,
				endsOn: b.endsOn > end ? end : b.endsOn,
				weeks: b.weeks.filter((w) => w.startsOn >= start && w.endsOn <= end)
			}));
		storage = { from: start, blocks, outline: [] };
		decisions = spliceRefs(preview, start, end);
		event = String(decisions.find((d) => d.kind === 'taper_planned')?.evidence.event ?? '');
	}
	const [first, ...rest] = decisions;
	const loads = { ...first!.evidence, loads: loadsWords(preview) };
	return storeReplan(
		input.ownerId,
		{
			mechanism,
			baseVersionNumber: preview.baseVersionNumber,
			today: input.today,
			...storage,
			decisions: [{ ...first!, evidence: loads }, ...rest],
			summary: summaryOf(preview, event || undefined),
			createdBy: by,
			origin: {
				fingerprint: replan.fingerprint,
				snapshot: preview.input as unknown as Record<string, unknown>
			}
		},
		{ db: input.deps.db, now: input.deps.now }
	);
}

/** How each session still ahead changes, by its stored lineage: values only. */
function deloadChanges(stored: readonly StoredSession[], made: readonly SessionPlan[]) {
	const changes: Required<Omit<CopyChanges, 'weeks' | 'exercises'>> = {
		sessions: {},
		details: {},
		segments: {},
		sets: {}
	};
	stored.forEach((was, i) => {
		const now = made[i]!;
		const { lineage } = was;
		const { type, title, estMinutes, estLoad, intensity, targetRpe } = now;
		changes.sessions[lineage] = {
			sessionType: type,
			title,
			estMinutes,
			estLoad,
			intensity,
			targetRpe
		};
		if (now.kind === 'other') changes.details[lineage] = { ...now.details };
		if (now.kind === 'run')
			changes.segments[lineage] = Object.fromEntries(now.segments.map((s, k) => [k + 1, { ...s }]));
		if (now.kind === 'strength' && was.kind === 'strength')
			now.exercises.forEach((e, x) => {
				const sets = Object.fromEntries(e.sets.map((set, k) => [k + 1, { ...set }]));
				changes.sets[was.exercises[x]!.lineage] = sets;
			});
	});
	return changes;
}

/** Deload the week in place as version N + 1; its id. */
async function storeDeload(input: ApplyInput<'replan'>, preview: ReplanPreview, by: Decider) {
	const { directive, replan, from } = preview;
	if (directive.kind !== 'deload') throw new Error('a deload directive');
	const version = await getProgramVersion(
		input.ownerId,
		input.programId!,
		preview.baseVersionNumber,
		{ db: input.deps.db }
	);
	const block = version.blocks.find((b) => b.weeks.some((w) => w.startsOn === from))!;
	const week = block.weeks.find((w) => w.startsOn === from)!;
	const ahead = new Set(preview.ahead!.map((s) => s.lineage));
	const made = replan.weeks[0]!;
	const pairs = week.sessions.flatMap((s, i) =>
		ahead.has(s.lineage) ? [[s, made.sessions[i]!] as const] : []
	);
	const facts = {
		week: String(block.weeks.indexOf(week) + 1),
		signals: directive.reasons.length
			? `${directive.reasons.join('. ')}.`
			: 'You asked for a lighter week.',
		reason: MECHANISMS.in_place.why,
		loads: loadsWords(preview)
	};
	const triggered: RevisionDecision = {
		kind: 'deload_triggered',
		ruleKey: 'replan.in_place',
		summary: render(TEMPLATES.deload_triggered.summary, facts, 'deload_triggered'),
		why: render(TEMPLATES.deload_triggered.why, facts, 'deload_triggered'),
		decidedBy: by,
		affected: [],
		evidence: facts
	};
	const eased = pairs.map(([s, now]): RevisionDecision => {
		const rpe = { session: s.title, rpe: now.targetRpe };
		return {
			kind: 'load_eased',
			ruleKey: 'replan.in_place',
			summary: render(TEMPLATES.load_eased.summary, rpe, 'load_eased'),
			why: `${s.title} is part of the deload week, so it is eased to RPE ${now.targetRpe}.`,
			decidedBy: by,
			affected: [s.lineage]
		};
	});
	const revision: DeloadRevision = {
		baseVersionNumber: preview.baseVersionNumber,
		today: input.today,
		week: from,
		targets: made.targets,
		changes: deloadChanges(
			pairs.map(([s]) => s),
			pairs.map(([, now]) => now)
		),
		decisions: [triggered, ...eased],
		summary: summaryOf(preview, undefined)
	};
	return reviseDeload(input.ownerId, revision, {
		db: input.deps.db,
		now: input.deps.now,
		source: by
	});
}

/** M6's review_applied decision on the changed weeks' sessions, naming the review. */
async function reviewApplied(
	input: ApplyInput<'replan'>,
	preview: ReplanPreview,
	stored: { programId: string; versionId: string; number: number },
	review: { reviewId: string; revision?: number; weekStartsOn: IsoDate }
) {
	const db = input.deps.db;
	const version = await getProgramVersion(input.ownerId, stored.programId, stored.number, { db });
	const changed = new Set(preview.weeks.map((w) => w.weekStart));
	const affected = version.blocks
		.flatMap((b) => b.weeks)
		.filter((w) => changed.has(w.startsOn))
		.flatMap((w) => w.sessions)
		.filter((s) => s.date >= input.today)
		.map((s) => s.lineage);
	const facts = {
		who: 'The programming rules',
		changes: preview.directive.kind === 'deload' ? 'a deload week' : 'a re-plan',
		review: `weekly review of ${dayMonth(review.weekStartsOn)}`,
		reason: preview.summaryLines[0] ?? MECHANISMS[preview.mechanism].why
	};
	await createProgramsRepository(db).insertDecisions([
		{
			programId: stored.programId,
			versionId: stored.versionId,
			kind: 'review_applied',
			ruleKey: REVIEW_APPLIED_RULE,
			summary: render(TEMPLATES.review_applied.summary, facts, 'review_applied'),
			why: render(TEMPLATES.review_applied.why, facts, 'review_applied'),
			decidedBy: 'rules',
			affected,
			evidence: { reviewId: review.reviewId, revision: review.revision ?? 1, trimmed: 0 },
			createdAt: input.deps.now()
		}
	]);
}

/**
 * Apply a replan as the header says. `periodisation` is how its preview reads the evaluation
 * context: the default reader and timeout unless given.
 */
export async function applyReplan(
	input: ApplyInput<'replan'>,
	periodisation: Omit<PreviewDeps, 'db'> = {}
): Promise<ApplyOutcome> {
	const { ownerId, proposalId, today, deps } = input;
	const { payload } = input.proposal;
	const deload = payload.directive.kind === 'deload';
	const directive = payload.directive;
	const shown = await previewReplan(
		ownerId,
		{ today, directive },
		{ ...periodisation, db: deps.db }
	);
	if ('refusal' in shown)
		return superseded(
			deload && shown.refusal === 'nothing_ahead' ? SESSIONS_PASSED : 'plan_changed'
		);
	if (shown.baseVersionNumber !== payload.baseVersionNumber) return superseded('program_changed');
	if (!deload && shown.from !== payload.from) return superseded('start_passed');
	if (shown.fingerprint !== payload.fingerprint) return superseded('profile_changed');
	if (shown.shapeDigest !== payload.shapeDigest) return superseded('plan_changed');

	const row = await createCoachProposalsRepository(deps.db).proposal(ownerId, proposalId);
	const source = (row?.source ?? null) as {
		kind?: string;
		reviewId?: string;
		revision?: number;
		weekStartsOn?: IsoDate;
	} | null;
	const by: Decider = source?.kind ? 'rules' : row?.threadId ? 'coach' : 'owner';
	try {
		const stored = deload
			? await storeDeload(input, shown, by)
			: await storeChange(input, shown, by);
		if (source?.kind === 'weekly_review' && source.reviewId && source.weekStartsOn) {
			const review = { ...source, reviewId: source.reviewId, weekStartsOn: source.weekStartsOn };
			await reviewApplied(input, shown, stored, review);
		}
		return { status: 'applied', appliedVersionId: stored.versionId };
	} catch (error) {
		if (error instanceof ProgramConflictError) return superseded('program_changed');
		throw error;
	}
}

export const REPLAN_APPLIERS: Pick<Appliers, 'replan'> = { replan: (input) => applyReplan(input) };
