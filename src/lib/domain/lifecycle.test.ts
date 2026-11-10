import { describe, expect, it } from 'vitest';
import {
	checkLifecycle,
	defineLifecycle,
	IllegalTransitionError,
	legalEvents,
	lifecycleRows,
	step,
	unchecked
} from './lifecycle';

type DoorState = 'closed' | 'open' | 'locked';
type DoorEvent = 'open' | 'close' | 'lock';

const DOOR = defineLifecycle<DoorState, DoorEvent>({
	id: 'door',
	storedIn: 'the test',
	writeSites: [],
	tests: [],
	states: ['closed', 'open', 'locked'],
	initial: ['closed'],
	terminal: ['locked'],
	on: {
		open: { from: ['closed'], to: 'open', effects: [] },
		close: { from: ['open'], to: 'closed', effects: [] },
		lock: { from: ['closed', 'open'], to: 'locked', effects: ['turns the key'] }
	}
});

describe('lifecycle', () => {
	it('step allows an edge and brands the move', () => {
		const moved = step(DOOR, 'closed', 'open');
		expect(moved).toMatchObject({
			ok: true,
			legacy: false,
			t: { machine: 'door', from: 'closed', to: 'open', event: 'open', legal: true }
		});
		expect(moved.ok && Object.isFrozen(moved.t)).toBe(true);
	});

	it('step refuses a move with the legal events from that state', () => {
		expect(step(DOOR, 'open', 'open')).toEqual({
			ok: false,
			machine: 'door',
			from: 'open',
			event: 'open',
			legal: ['close', 'lock']
		});
	});

	it('step reports a legacy edge', () => {
		const door = defineLifecycle<DoorState, DoorEvent>({
			...DOOR,
			on: { ...DOOR.on, close: { from: ['open'], to: 'closed', effects: [], legacy: true } }
		});
		expect(step(door, 'open', 'close')).toMatchObject({ ok: true, legacy: true });
		expect(step(door, 'closed', 'open')).toMatchObject({ ok: true, legacy: false });
	});

	it('legalEvents lists events in table order', () => {
		expect(legalEvents(DOOR, 'closed')).toEqual(['open', 'lock']);
		expect(legalEvents(DOOR, 'locked')).toEqual([]);
	});

	it('unchecked brands an illegal move as not legal', () => {
		expect(unchecked(DOOR, 'locked', 'open')).toMatchObject({
			machine: 'door',
			from: 'locked',
			to: 'open',
			event: 'open',
			legal: false
		});
		expect(unchecked(DOOR, 'closed', 'open')).toMatchObject({ legal: true });
	});

	it('lifecycleRows has one row per from and event', () => {
		const rows = lifecycleRows(DOOR);
		expect(rows).toHaveLength(4);
		expect(rows[0]).toEqual({
			from: 'closed',
			event: 'open',
			to: 'open',
			effects: '',
			certainty: 'known',
			legacy: false,
			why: ''
		});
		expect(rows.map((r) => `${r.event}:${r.from}`)).toEqual([
			'open:closed',
			'close:open',
			'lock:closed',
			'lock:open'
		]);
		expect(rows[2]?.effects).toBe('turns the key');
	});

	it('checkLifecycle accepts a sound table and names each problem', () => {
		expect(checkLifecycle(DOOR)).toEqual([]);

		const broken = defineLifecycle<DoorState | 'jammed' | 'smashed', DoorEvent | 'unlock'>({
			...DOOR,
			states: ['closed', 'open', 'locked', 'jammed'],
			on: {
				open: { from: ['closed'], to: 'open', effects: [] },
				close: { from: ['open'], to: 'smashed', effects: [] },
				lock: { from: ['closed', 'open'], to: 'locked', effects: [] },
				unlock: { from: ['locked'], to: 'closed', effects: [] }
			}
		});
		const problems = checkLifecycle(broken);
		expect(problems).toHaveLength(3);
		expect(problems).toEqual([
			expect.stringContaining('smashed'),
			expect.stringContaining('locked'),
			expect.stringContaining('jammed')
		]);
		for (const problem of problems) expect(problem).toMatch(/^door: /);
	});

	it('checkLifecycle does not count a legacy exit from a terminal state', () => {
		const door = defineLifecycle<DoorState, DoorEvent | 'unlock'>({
			...DOOR,
			on: { ...DOOR.on, unlock: { from: ['locked'], to: 'closed', effects: [], legacy: true } }
		});
		expect(checkLifecycle(door)).toEqual([]);
	});

	it('checkLifecycle names an initial or terminal value that is not a state', () => {
		const door = defineLifecycle<DoorState | 'ajar' | 'gone', DoorEvent>({
			...DOOR,
			initial: ['closed', 'ajar'],
			terminal: ['locked', 'gone']
		});
		expect(checkLifecycle(door)).toEqual([
			expect.stringContaining('ajar'),
			expect.stringContaining('gone')
		]);
	});

	it('IllegalTransitionError carries the refusal', () => {
		const refusal = step(DOOR, 'open', 'open');
		if (refusal.ok) throw new Error('expected a refusal');
		const error = new IllegalTransitionError(refusal);
		expect(error).toBeInstanceOf(Error);
		expect(error).toMatchObject({
			name: 'IllegalTransitionError',
			code: 'illegal_transition',
			machine: 'door',
			from: 'open',
			event: 'open',
			legal: ['close', 'lock'],
			message: 'door: open does not allow open'
		});
	});

	it('a table without an edge for every event fails the type check', () => {
		const table = defineLifecycle<DoorState, DoorEvent>({
			...DOOR,
			// @ts-expect-error: the table has no `lock` edge
			on: {
				open: { from: ['closed'], to: 'open', effects: [] },
				close: { from: ['open'], to: 'closed', effects: [] }
			}
		});
		expect(legalEvents(table, 'closed')).toEqual(['open']);
		expect(checkLifecycle(DOOR)).toEqual([]);
	});
});
