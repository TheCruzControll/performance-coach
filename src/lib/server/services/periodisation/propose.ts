/**
 * Proposing a re-plan (m7-plan replan-proposals; PRD §5, §14; the replans-as-versions ADR): every
 * re-plan reaches the plan only through M5's confirmation lifecycle, proposed and then accepted.
 * proposeReplan previews the directive and stores what it shows as a replan proposal: the request
 * and the preview's hashes, re-derived at accept (services/coach/apply/replan.ts).
 *
 * - It runs in one transaction on deps.db under the owner's proposals lock (pg_advisory_xact_lock,
 *   M5's createProposal's own). Given a caller's transaction that already holds it (a weekly
 *   review's), Postgres grants it again on the same session, and every read and write stays on
 *   that one connection, awaited in turn: it never opens a second.
 * - Refused by the preview: its reason and sentence, nothing written.
 * - Nothing would change (no week differs): unchanged, nothing written.
 * - The owner's open replan is returned as it is when it is the same proposal: the same directive,
 *   so the same kind, and the same shape, fingerprint, start and base (M5's duplicate). Any other
 *   open replan is superseded as revised by the new one (M5's 'revised'), so the one left open
 *   always matches today's profile and plan. Decision: the plan's 'same directive kind and shape
 *   is returned' is narrowed to the same proposal, so accepting what is open never meets
 *   profile_changed for a change the owner already made.
 * - Who made it: a goal change (goal_priority) or the training load (fatigue) as an engine's
 *   provenance, a weekly review as M6's rules provenance naming the review, the coach with its
 *   conversation, or the owner with neither.
 * - proposeAgain asks for a stale re-plan (a superseded one isStaleReplan names) again: its stored
 *   directive from today, a deload whose week has passed moved to the week holding today, and the
 *   same source and provenance. It runs proposeReplan, so the engine's guards apply again.
 * Owner-scoped: another owner's plan is never read (the preview refuses no_program), and another
 * owner's proposal is CoachNotFoundError, like a missing one.
 * Imported by path, like the rest of services/periodisation.
 */
import { mondayOf, type IsoDate } from '../../../domain/calendar';
import { isStaleReplan } from '../../../domain/coach/cards';
import { RATIONALE_MAX, TITLE_MAX } from '../../../domain/coach/proposals';
import { localDay } from '../../../domain/dates';
import {
	replanPayloadSchema,
	type ReplanDirective,
	type ReplanPayload
} from '../../../domain/training/replan';
import { PHASE_LABEL } from '../../../domain/training/vocabulary';
import { validate } from '../../../domain/validation';
import {
	createCoachProposalsRepository,
	type ProposalRow
} from '../../db/repositories/coach-proposals';
import { isUuid } from '../ids';
import {
	createProposal,
	listProposals,
	PROPOSAL_PAGE,
	type NewProposal,
	type ProposalView,
	type RulesProvenance
} from '../coach/proposals';
import { CoachNotFoundError, inTransaction, resolveDeps, type CoachDeps } from '../coach/shared';
import { getAthleteProfile } from '../profile/index';
import { previewReplan, type PreviewDeps, type PreviewRefusalReason } from './preview';

/** The review a weekly review's re-plan names, as M6 stores its provenance. */
export type ReplanReview = Omit<RulesProvenance, 'kind' | 'weekStartsOn'> & {
	weekStartsOn: IsoDate;
};
/** The conversation, run and tool call a coach's re-plan names. */
export type ReplanCoach = NonNullable<NewProposal['origin']>;

/**
 * Who asked, and what that source must name: a weekly review's re-plan carries its review, the
 * coach's carries its conversation, and no other source carries either, so the attribution is
 * never dropped silently.
 */
export type ReplanRequest = {
	/** The owner's local today. */
	today: IsoDate;
	directive: ReplanDirective;
} & (
	| { source: 'goal_priority' | 'fatigue' | 'owner'; review?: never; coach?: never }
	| { source: 'weekly_review'; review: ReplanReview; coach?: never }
	| { source: 'coach'; coach: ReplanCoach; review?: never }
);

export type ProposedReplan =
	| { status: 'proposed'; proposal: ProposalView; duplicate: boolean; from: IsoDate }
	| { status: 'unchanged' }
	| { status: 'refused'; refusal: PreviewRefusalReason; why: string };

export type ProposeDeps = CoachDeps &
	Pick<PreviewDeps, 'errorsDb' | 'origin' | 'reader' | 'statementTimeoutMs'>;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayMonth = (date: IsoDate) =>
	`${Number(date.slice(8))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;
const clip = (text: string, max: number) =>
	text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** The proposal's title, from its directive. */
function titleOf(directive: ReplanDirective): string {
	switch (directive.kind) {
		case 'priorities':
			return 'Re-plan for your new priorities';
		case 'block':
			return `A ${PHASE_LABEL[directive.phase].toLowerCase()} block of ${directive.weeks} weeks`;
		case 'taper':
			return directive.form === 'full' ? 'Taper for your event' : 'A mini-taper for your event';
		case 'deload':
			return `Deload the week of ${dayMonth(directive.week)}`;
	}
}

/** The owner's newest open replan proposal, through M5's listProposals; null with none. */
export async function getOpenReplan(
	ownerId: string,
	deps: CoachDeps = {}
): Promise<ProposalView | null> {
	const { proposals } = await listProposals(
		ownerId,
		{ status: 'proposed', limit: PROPOSAL_PAGE.max },
		deps
	);
	return proposals.find((p) => p.kind === 'replan') ?? null;
}

/** Preview `request`'s directive and propose it, as the header says. */
export async function proposeReplan(
	ownerId: string,
	request: ReplanRequest,
	deps: ProposeDeps = {}
): Promise<ProposedReplan> {
	const { now } = resolveDeps(deps);
	return inTransaction(deps, async ({ db }) => {
		const repo = createCoachProposalsRepository(db);
		await repo.lockCreates(ownerId);
		const { today, directive } = request;
		const { errorsDb, origin, reader, statementTimeoutMs } = deps;
		const shown = await previewReplan(
			ownerId,
			{ today, directive },
			{ db, errorsDb, origin, reader, statementTimeoutMs }
		);
		if ('refusal' in shown) return { status: 'refused', ...shown };
		if (!shown.weeks.length) return { status: 'unchanged' };

		const payload: ReplanPayload = {
			directive,
			from: shown.from,
			baseVersionNumber: shown.baseVersionNumber,
			fingerprint: shown.fingerprint,
			shapeDigest: shown.shapeDigest
		};
		// The open replan, revised by a different one; an identical one comes back as it is
		// (M5's duplicate: the same request and hashes on the same base).
		const open = await getOpenReplan(ownerId, { db, now });
		const provenance =
			request.source === 'goal_priority' || request.source === 'fatigue'
				? { kind: request.source }
				: request.source === 'weekly_review'
					? { kind: 'weekly_review' as const, ...request.review }
					: null;
		const created = await createProposal(
			ownerId,
			{
				proposal: {
					kind: 'replan',
					title: clip(titleOf(directive), TITLE_MAX),
					rationale: clip(shown.replan.decisions[0]!.why, RATIONALE_MAX),
					payload
				},
				revises: open?.id ?? null,
				origin: request.source === 'coach' ? request.coach : null,
				provenance,
				preview: shown
			},
			{ db, now }
		);
		// `from` is the first day the new version may differ on: the payload's, which a view lacks.
		return { status: 'proposed', ...created, from: shown.from };
	});
}

/**
 * What proposeAgain answers: a fresh proposal as proposeReplan does, not a stale re-plan, or a stale
 * re-plan whose source cannot be read again (a conversation with no run, or a provenance this app
 * does not write). Neither writes anything; the second is not a failure, so no Try again is offered.
 */
export type ProposedAgain =
	ProposedReplan | { status: 'not_stale' } | { status: 'not_reproposable' };

/** A deload whose week has passed moves to the week holding today; any other directive is as it was. */
export function movedToThisWeek(directive: ReplanDirective, today: IsoDate): ReplanDirective {
	const thisWeek = mondayOf(today);
	return directive.kind === 'deload' && directive.week < thisWeek
		? { ...directive, week: thisWeek }
		: directive;
}

/**
 * The request a stale replan was made with, read from its stored source (evidence.source, or its
 * conversation): the same source and provenance, so the new proposal names what the old one did.
 * Null when that source cannot be read again (a conversation with no run, or a provenance this app
 * does not write): the caller answers not_reproposable, which is not a failure.
 */
function requestOf(
	row: ProposalRow,
	today: IsoDate,
	directive: ReplanDirective
): ReplanRequest | null {
	const source = (row.evidence as { source?: Record<string, unknown> } | null)?.source;
	if (source === undefined) {
		if (row.threadId === null) return { today, directive, source: 'owner' };
		if (row.runId === null || row.toolUseId === null) return null;
		const coach = { threadId: row.threadId, runId: row.runId, toolUseId: row.toolUseId };
		return { today, directive, source: 'coach', coach };
	}
	if (source.kind === 'goal_priority' || source.kind === 'fatigue') {
		return { today, directive, source: source.kind };
	}
	if (
		source.kind === 'weekly_review' &&
		typeof source.reviewId === 'string' &&
		typeof source.revision === 'number' &&
		typeof source.weekStartsOn === 'string'
	) {
		// The stored provenance is M6's rules provenance: the review's own fields, as written.
		return { today, directive, source: 'weekly_review', review: source as ReplanReview };
	}
	return null;
}

/**
 * Propose again a stale re-plan (the header's proposeAgain): the owner's proposal `proposalId`,
 * read in one transaction under the owner's proposals lock, asked for again from today through
 * proposeReplan. Not a stale re-plan (any other kind, status or reason): not_stale, nothing
 * written. A stale re-plan whose source cannot be read again: not_reproposable, nothing written.
 * A proposal that is not the owner's, or not there, is CoachNotFoundError.
 */
export async function proposeAgain(
	ownerId: string,
	proposalId: string,
	deps: ProposeDeps = {}
): Promise<ProposedAgain> {
	const { now } = resolveDeps(deps);
	return inTransaction<ProposedAgain>(deps, async ({ db }) => {
		const row = isUuid(proposalId)
			? await createCoachProposalsRepository(db).lockProposal(ownerId, proposalId)
			: null;
		if (!row) throw new CoachNotFoundError('proposal');
		if (!isStaleReplan(row.kind, row.status, row.supersededReason)) return { status: 'not_stale' };
		const stored = validate(replanPayloadSchema, row.payload);
		if (!stored.ok) throw new Error(`Replan ${row.id} has a payload that cannot be read`);
		const { timeZone } = await getAthleteProfile(ownerId, { db });
		const today = localDay(now(), timeZone);
		const directive = movedToThisWeek(stored.data.directive, today);
		const request = requestOf(row, today, directive);
		if (!request) return { status: 'not_reproposable' };
		return proposeReplan(ownerId, request, { ...deps, db, now });
	});
}
