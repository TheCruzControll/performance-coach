/**
 * The registered lifecycles are sound, PROPOSAL is exactly the coach_proposals transition guard
 * (drizzle/0026_coach_proposals_guards.sql), and WORKOUT ends as owner decision D1 says, with
 * canEnd (the part the device reducer loads) agreeing with the table.
 */
import { describe, expect, it } from 'vitest';
import { checkLifecycle, step } from './lifecycle.ts';
import { LIFECYCLES } from './lifecycles.ts';
import { PROPOSAL } from './training/lifecycles.ts';
import { PROGRAM } from './training/program-lifecycle.ts';
import type { ProposalEvent } from './training/lifecycles.ts';
import type { ProposalStatus } from './training/vocabulary.ts';
import { canEnd } from './workout/ends.ts';
import type { WorkoutEvent } from './workout/ends.ts';
import { WORKOUT, WORKOUT_STATES } from './workout/lifecycles.ts';

describe('the lifecycle registry', () => {
	it('every registered lifecycle is sound', () => {
		expect(LIFECYCLES.length).toBeGreaterThan(0);
		for (const l of LIFECYCLES) expect(checkLifecycle(l), l.id).toEqual([]);
	});

	it('ids are unique', () => {
		const ids = LIFECYCLES.map((l) => l.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toEqual(['workout', 'proposal', 'program']);
	});
});

describe('PROPOSAL', () => {
	it('PROPOSAL matches the coach_proposals transition guard', () => {
		// coach_proposals_transition_guard: proposed → accepted, rejected, applied or superseded;
		// accepted → applied or superseded; nothing else.
		const guard: Record<ProposalStatus, Record<ProposalEvent, boolean>> = {
			proposed: { accept: true, reject: true, apply: true, supersede: true },
			accepted: { accept: false, reject: false, apply: true, supersede: true },
			rejected: { accept: false, reject: false, apply: false, supersede: false },
			applied: { accept: false, reject: false, apply: false, supersede: false },
			superseded: { accept: false, reject: false, apply: false, supersede: false }
		};
		const events: ProposalEvent[] = ['accept', 'reject', 'apply', 'supersede'];
		const table = Object.fromEntries(
			PROPOSAL.states.map((from) => [
				from,
				Object.fromEntries(events.map((event) => [event, step(PROPOSAL, from, event).ok]))
			])
		);
		expect(table).toEqual(guard);
	});
});

describe('PROGRAM', () => {
	it('an active program ends once, and an archived one stays archived', () => {
		expect(step(PROGRAM, 'active', 'end')).toMatchObject({ ok: true, t: { to: 'archived' } });
		expect(step(PROGRAM, 'archived', 'end').ok).toBe(false);
	});
});

describe('WORKOUT', () => {
	it('WORKOUT ends as D1 says', () => {
		expect(step(WORKOUT, 'in_progress', 'finish')).toMatchObject({
			ok: true,
			t: { to: 'completed' }
		});
		expect(step(WORKOUT, 'abandoned', 'finish')).toMatchObject({
			ok: true,
			t: { to: 'completed' }
		});
		expect(step(WORKOUT, 'completed', 'finish').ok).toBe(false);
		expect(step(WORKOUT, 'in_progress', 'abandon')).toMatchObject({
			ok: true,
			t: { to: 'abandoned' }
		});
		expect(step(WORKOUT, 'completed', 'abandon').ok).toBe(false);
		expect(step(WORKOUT, 'abandoned', 'abandon').ok).toBe(false);
	});

	it('canEnd agrees with WORKOUT', () => {
		const events: WorkoutEvent[] = ['finish', 'abandon'];
		for (const status of WORKOUT_STATES) {
			for (const event of events) {
				expect(canEnd(status, event), `${status} × ${event}`).toBe(step(WORKOUT, status, event).ok);
			}
		}
	});
});
