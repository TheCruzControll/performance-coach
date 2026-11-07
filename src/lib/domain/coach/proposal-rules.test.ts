import { describe, expect, it } from 'vitest';
import {
	ALTERNATIVE,
	BLOCK,
	DISLIKED,
	EXERCISE,
	FIXTURES,
	GOAL,
	OTHER_SESSION,
	PAST_SESSION,
	PLANNED,
	SESSION
} from '../../../../tests/fixtures/coach-proposals';
import { checkProposal, RULE_MESSAGES as M, type ProposalContext } from './proposal-rules';
import { PROPOSAL_KINDS } from './proposals';

const UNKNOWN = 'a1b2c3d4-0000-4000-8000-0000000000ff';

const CONTEXT: ProposalContext = {
	today: '2026-11-09',
	sessions: [
		{ lineage: SESSION, date: '2026-11-09', exerciseLineages: [PLANNED] },
		{ lineage: OTHER_SESSION, date: '2026-11-11', exerciseLineages: [PLANNED] },
		{ lineage: PAST_SESSION, date: '2026-11-08', exerciseLineages: [PLANNED] }
	],
	blockLineages: [BLOCK],
	dislikedExerciseIds: [DISLIKED],
	eligibleExerciseIds: [EXERCISE, ALTERNATIVE, DISLIKED],
	goalIds: [GOAL]
};

/** The fixture of `kind` with its payload changed. */
const withPayload = (kind: keyof typeof FIXTURES, payload: object) => ({
	...FIXTURES[kind],
	payload: { ...(FIXTURES[kind].payload as object), ...payload }
});
const errorsOf = (input: unknown, context = CONTEXT) => {
	const result = checkProposal(input, context);
	return result.ok ? {} : result.errors;
};

describe('checkProposal', () => {
	it.each(PROPOSAL_KINDS)('passes the valid %s', (kind) => {
		expect(checkProposal(FIXTURES[kind], CONTEXT)).toMatchObject({ ok: true, data: { kind } });
	});

	it('refuses an op on a past session, or a move to a past day', () => {
		expect(
			errorsOf(
				withPayload('program_adjustment', {
					ops: [
						{ op: 'skip', sessionLineage: PAST_SESSION },
						{ op: 'move', sessionLineage: OTHER_SESSION, toDate: '2026-11-08' }
					]
				})
			)
		).toEqual({ 'payload.ops.0.sessionLineage': M.past, 'payload.ops.1.toDate': M.pastDay });
		expect(errorsOf(withPayload('session_substitution', { sessionLineage: PAST_SESSION }))).toEqual(
			{
				'payload.sessionLineage': M.past
			}
		);
		expect(
			errorsOf(
				withPayload('new_program', { startsOn: '2026-11-02', firstPlannedDay: '2026-11-08' })
			)
		).toEqual({ 'payload.firstPlannedDay': M.pastDay });
	});

	it('never targets a disliked or ineligible exercise', () => {
		const swap = (toExerciseId: string) => ({
			op: 'swap',
			sessionLineage: SESSION,
			plannedExerciseLineage: PLANNED,
			toExerciseId,
			scope: 'once'
		});
		expect(
			errorsOf(withPayload('program_adjustment', { ops: [swap(DISLIKED), swap(UNKNOWN)] }))
		).toEqual({
			'payload.ops.0.toExerciseId': M.disliked,
			'payload.ops.1.toExerciseId': M.ineligible
		});
		expect(errorsOf(withPayload('session_substitution', { toExerciseId: DISLIKED }))).toEqual({
			'payload.toExerciseId': M.disliked
		});
		expect(
			errorsOf(
				withPayload('next_cycle', {
					rotation: [{ fromExerciseId: EXERCISE, toExerciseId: UNKNOWN }]
				})
			)
		).toEqual({ 'payload.rotation.0.toExerciseId': M.ineligible });
	});

	it('refuses an id the owner does not have', () => {
		expect(
			errorsOf(
				withPayload('program_adjustment', {
					ops: [
						{ op: 'skip', sessionLineage: UNKNOWN },
						{
							op: 'adjust_set',
							sessionLineage: SESSION,
							plannedExerciseLineage: UNKNOWN,
							position: 1,
							sets: 3
						}
					]
				})
			)
		).toEqual({
			'payload.ops.0.sessionLineage': M.unknownSession,
			'payload.ops.1.plannedExerciseLineage': M.unknownExercise
		});
		expect(
			errorsOf(withPayload('session_substitution', { plannedExerciseLineage: UNKNOWN }))
		).toEqual({
			'payload.plannedExerciseLineage': M.unknownExercise
		});
		expect(errorsOf(withPayload('next_cycle', { fromBlockLineage: UNKNOWN }))).toEqual({
			'payload.fromBlockLineage': M.unknownBlock
		});
		expect(
			errorsOf(
				withPayload('goal_update', {
					ops: [
						{ op: 'set_status', goalId: UNKNOWN, status: 'achieved' },
						{ op: 'reorder', ids: [GOAL, UNKNOWN] }
					]
				})
			)
		).toEqual({ 'payload.ops.0.goalId': M.unknownGoal, 'payload.ops.1.ids.1': M.unknownGoal });
	});

	it('refuses an empty rationale at its path, before any rule runs', () => {
		expect(errorsOf({ ...FIXTURES.workout_update, rationale: ' ' })).toEqual({
			rationale: 'Say why'
		});
	});

	it('keeps a workout_update to one session', () => {
		expect(
			errorsOf(
				withPayload('workout_update', {
					ops: [
						{ op: 'skip', sessionLineage: SESSION },
						{ op: 'adjust_details', sessionLineage: OTHER_SESSION, durationMinutes: 45 }
					]
				})
			)
		).toEqual({ 'payload.ops.1.sessionLineage': M.oneSession });
		// The same two sessions are fine in a program_adjustment.
		expect(
			errorsOf(
				withPayload('program_adjustment', {
					ops: [
						{ op: 'skip', sessionLineage: SESSION },
						{ op: 'adjust_details', sessionLineage: OTHER_SESSION, durationMinutes: 45 }
					]
				})
			)
		).toEqual({});
	});

	it('checks against the today it is given, so accepting later can refuse', () => {
		expect(errorsOf(FIXTURES.workout_update, { ...CONTEXT, today: '2026-11-10' })).toEqual({
			'payload.ops.0.sessionLineage': M.past,
			'payload.ops.1.sessionLineage': M.past
		});
	});
});
