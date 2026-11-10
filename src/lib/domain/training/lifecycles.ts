/**
 * The coach proposal lifecycle: exactly the moves Postgres allows in
 * coach_proposals_transition_guard (drizzle/0026_coach_proposals_guards.sql). A proposal is
 * inserted as `proposed` and only moves forward; rejected, applied and superseded rows are
 * frozen. A trigger migration that changes those moves changes this table in the same PR.
 * docs/lifecycles.md is generated from it.
 */
import { defineLifecycle } from '../lifecycle.ts';
import { PROPOSAL_STATUSES } from './vocabulary.ts';
import type { ProposalStatus } from './vocabulary.ts';

export type ProposalEvent = 'accept' | 'reject' | 'apply' | 'supersede';

const NOT_YET =
	'accepted → … is allowed by the trigger; no code performs it yet (it awaits the cycle review).';

export const PROPOSAL = /* @__PURE__ */ defineLifecycle<ProposalStatus, ProposalEvent>({
	id: 'proposal',
	storedIn: 'coach_proposals.status (Postgres), guarded by drizzle/0026',
	writeSites: ['src/lib/server/db/repositories/coach-proposals.ts decide'],
	tests: [],
	states: PROPOSAL_STATUSES,
	initial: ['proposed'],
	terminal: ['rejected', 'applied', 'superseded'],
	on: {
		accept: {
			from: ['proposed'],
			to: 'accepted',
			effects: ['coach_proposals: status, closed_at (the trigger stamps it if unset)']
		},
		reject: {
			from: ['proposed'],
			to: 'rejected',
			effects: ['coach_proposals: status, decision_note, closed_at']
		},
		apply: {
			from: ['proposed', 'accepted'],
			to: 'applied',
			effects: [
				'the applier writes in the same transaction',
				'coach_proposals: status, applied_version_id or applied_ref, program_id, closed_at'
			],
			why: NOT_YET
		},
		supersede: {
			from: ['proposed', 'accepted'],
			to: 'superseded',
			effects: ['coach_proposals: status, superseded_reason, closed_at'],
			why: NOT_YET
		}
	}
});
