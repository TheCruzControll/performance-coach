/**
 * What an applier is (services/coach/apply/index.ts): acceptProposal hands it a proposal it has
 * just re-parsed and re-checked against today, inside the accept transaction, and writes the
 * outcome it returns. An applier changes the owner's data only through the services the screens
 * use, with source 'coach', on `deps.db` (the accept transaction), so a throw undoes it all.
 */
import type { IsoDate } from '../../../../domain/calendar';
import type { NEXT_CYCLE_AWAITS, Proposal, ProposalKind } from '../../../../domain/coach/proposals';
import type { SupersededReason } from '../../../../domain/coach/vocabulary';
import type { AppliedRef } from '../../../db/schema/coaching';
import type { ResolvedCoachDeps } from '../shared';

export interface ApplyInput<K extends ProposalKind = ProposalKind> {
	ownerId: string;
	proposalId: string;
	/** The stored proposal, parsed again: never what a caller sent with the accept. */
	proposal: Extract<Proposal, { kind: K }>;
	/** The program and version it was proposed against, which are still current. */
	programId: string | null;
	baseVersionId: string | null;
	/** The owner's local today. */
	today: IsoDate;
	/** `db` is the accept transaction. */
	deps: ResolvedCoachDeps;
}

export type ApplyOutcome =
	/** It changed the owner's data: a version, or another record (a goal, a preference). */
	| {
			status: 'applied';
			appliedVersionId?: string;
			appliedRef?: AppliedRef;
			/** A new_program's program, which exists only once it is applied. */
			programId?: string;
	  }
	/** Accepted, and applied later by something else (next_cycle, by M6's cycle review). */
	| { status: 'accepted'; awaits: typeof NEXT_CYCLE_AWAITS }
	/** It can no longer apply as proposed. */
	| {
			status: 'superseded';
			reason: SupersededReason;
			/** The page that holds it now: a next_cycle folded into its cycle review. */
			href?: string;
	  };

export type Applier<K extends ProposalKind> = (input: ApplyInput<K>) => Promise<ApplyOutcome>;
export type Appliers = { [K in ProposalKind]: Applier<K> };

/**
 * The applier for this kind has not landed yet (the M5 plan's apply-* slices replace each stub):
 * nothing was written and the proposal stays proposed.
 */
export class ApplierUnavailableError extends Error {
	readonly kind: ProposalKind;

	constructor(kind: ProposalKind) {
		super(`a ${kind} proposal cannot be applied yet`);
		this.name = 'ApplierUnavailableError';
		this.kind = kind;
	}
}

/** A stub applier: refuses, so the accept transaction writes nothing. */
export const unavailable =
	<K extends ProposalKind>(kind: K): Applier<K> =>
	async () => {
		throw new ApplierUnavailableError(kind);
	};
