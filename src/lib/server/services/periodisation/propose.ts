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
 * Owner-scoped: another owner's plan is never read (the preview refuses no_program).
 * Imported by path, like the rest of services/periodisation.
 */
import type { IsoDate } from '../../../domain/calendar';
import { RATIONALE_MAX, TITLE_MAX } from '../../../domain/coach/proposals';
import type { ReplanDirective, ReplanPayload } from '../../../domain/training/replan';
import { PHASE_LABEL } from '../../../domain/training/vocabulary';
import { createCoachProposalsRepository } from '../../db/repositories/coach-proposals';
import {
	createProposal,
	listProposals,
	PROPOSAL_PAGE,
	type NewProposal,
	type ProposalView,
	type RulesProvenance
} from '../coach/proposals';
import { inTransaction, resolveDeps, type CoachDeps } from '../coach/shared';
import { previewReplan, type PreviewDeps, type PreviewRefusalReason } from './preview';

/** Who asks for a re-plan. */
export type ReplanSource = 'goal_priority' | 'fatigue' | 'weekly_review' | 'coach' | 'owner';

export interface ReplanRequest {
	/** The owner's local today. */
	today: IsoDate;
	directive: ReplanDirective;
	source: ReplanSource;
	/** weekly_review: the review that made it, as M6 stores its provenance. */
	review?: Omit<RulesProvenance, 'kind' | 'weekStartsOn'> & { weekStartsOn: IsoDate };
	/** coach: the conversation, run and tool call. */
	coach?: NonNullable<NewProposal['origin']>;
}

export type ProposedReplan =
	| { status: 'proposed'; proposal: ProposalView; duplicate: boolean }
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
		const { today, directive, source } = request;
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
			source === 'goal_priority' || source === 'fatigue'
				? { kind: source }
				: source === 'weekly_review' && request.review
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
				origin: source === 'coach' ? (request.coach ?? null) : null,
				provenance,
				preview: shown
			},
			{ db, now }
		);
		return { status: 'proposed', ...created };
	});
}
