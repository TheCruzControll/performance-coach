import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineLifecycle, IllegalTransitionError } from '../../domain/lifecycle';
import { LIFECYCLES } from '../../domain/lifecycles';
import { PROPOSAL } from '../../domain/training/lifecycles';
import { WORKOUT } from '../../domain/workout/lifecycles';
import { WORKOUT_STATUSES } from '../db/schema/training-log';
import { logger } from '../observability/logger';
import { ENFORCE, transition } from './lifecycle-guard';

type GateState = 'shut' | 'ajar' | 'gone';
type GateEvent = 'nudge' | 'remove';

/** Observed (no ENFORCE entry), with one legacy edge. */
const GATE = defineLifecycle<GateState, GateEvent>({
	id: 'gate',
	storedIn: 'test',
	writeSites: [],
	tests: [],
	states: ['shut', 'ajar', 'gone'],
	initial: ['shut'],
	terminal: ['gone'],
	on: {
		nudge: { from: ['shut'], to: 'ajar', effects: [] },
		remove: { from: ['ajar'], to: 'gone', effects: [], legacy: true }
	}
});

describe('transition', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it('returns the move for a legal edge without logging', () => {
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		const t = transition(PROPOSAL, 'proposed', 'accept');
		expect(t).toMatchObject({
			machine: 'proposal',
			from: 'proposed',
			to: 'accepted',
			event: 'accept',
			legal: true
		});
		expect(warn).not.toHaveBeenCalled();
	});

	it('observes an illegal move: logs it and returns it marked not legal', () => {
		vi.stubEnv('LIFECYCLE_STRICT', '');
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		const t = transition(PROPOSAL, 'applied', 'reject');
		expect(t).toMatchObject({ from: 'applied', to: 'rejected', event: 'reject', legal: false });
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith('lifecycle.observed', {
			machine: 'proposal',
			from: 'applied',
			event: 'reject',
			legacy: false,
			legal: []
		});
	});

	it('throws on an illegal move under LIFECYCLE_STRICT', () => {
		vi.stubEnv('LIFECYCLE_STRICT', '1');
		vi.spyOn(logger, 'warn').mockImplementation(() => {});
		expect(() => transition(PROPOSAL, 'accepted', 'reject')).toThrow(IllegalTransitionError);
		expect(() => transition(PROPOSAL, 'accepted', 'reject')).toThrow(
			expect.objectContaining({
				code: 'illegal_transition',
				machine: 'proposal',
				from: 'accepted',
				event: 'reject',
				legal: ['apply', 'supersede']
			})
		);
	});

	it('throws on an illegal move of an enforced machine even without LIFECYCLE_STRICT', () => {
		vi.stubEnv('LIFECYCLE_STRICT', '');
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		expect(() => transition(WORKOUT, 'completed', 'abandon')).toThrow(
			expect.objectContaining({
				name: 'IllegalTransitionError',
				machine: 'workout',
				from: 'completed',
				event: 'abandon',
				legal: []
			})
		);
		expect(warn).not.toHaveBeenCalled();
	});

	it('logs a legacy edge and allows it', () => {
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		const t = transition(GATE, 'ajar', 'remove');
		expect(t).toMatchObject({ machine: 'gate', from: 'ajar', to: 'gone', legal: true });
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith('lifecycle.observed', {
			machine: 'gate',
			from: 'ajar',
			event: 'remove',
			legacy: true
		});
	});

	it('every registered lifecycle has an ENFORCE entry', () => {
		expect(Object.keys(ENFORCE).sort()).toEqual(LIFECYCLES.map((l) => l.id).sort());
	});

	it('the workout lifecycle names the same states as the workouts table', () => {
		expect([...WORKOUT.states].sort()).toEqual([...WORKOUT_STATUSES].sort());
	});
});
