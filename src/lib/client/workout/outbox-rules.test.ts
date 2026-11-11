import { describe, expect, it } from 'vitest';
import { createMutation, SYNC_CODE_LABEL, SYNC_LIMITS } from '#lib/domain/workout/index.ts';
import type {
	Mutation,
	MutationOf,
	MutationPayloads,
	MutationType,
	SyncResult
} from '#lib/domain/workout/index.ts';
import {
	applyResults,
	backOnline,
	BACKOFF,
	BATCH_CAPS,
	countFailure,
	dependantsOf,
	discard,
	nextBatch,
	nextDelay,
	queued,
	replaceInPlace,
	STUCK_AFTER,
	syncStatus,
	tryAgain
} from './outbox-rules';
import type { OutboxEntry, OutboxStatus, StatusContext, SyncSession } from './outbox-rules';

const AT = '2026-11-06T18:00:00.000Z';
const T0 = Date.parse(AT);
const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;
const W = '00000000-0000-4000-8000-00000000000a';
const W2 = '00000000-0000-4000-8000-00000000000b';
const SQUAT = '00000000-0000-4000-8000-0000000000e1';
const LEG_PRESS = '00000000-0000-4000-8000-0000000000e2';

let n = 0;
const fresh = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

const done = {
	reps: 5,
	seconds: null,
	metres: null,
	weight: 100,
	assistance: null,
	unit: 'kg',
	rpe: 8,
	missedReps: 0,
	isWarmup: false,
	isExtra: false
} as const;

function make<T extends MutationType>(
	type: T,
	payload: MutationPayloads[T],
	{ workoutId = W, entityId }: { workoutId?: string; entityId?: string } = {}
): MutationOf<T> {
	return createMutation(type, { workoutId, entityId, at: AT, payload }, fresh);
}

const start = (workoutId = W) =>
	make(
		'workout.start',
		{
			kind: 'strength',
			title: 'Lower body & pull',
			sessionType: 'strength',
			discipline: 'strength',
			plannedSessionId: null,
			plannedLineage: null,
			programId: null
		},
		{ workoutId }
	);
const log = (workoutId = W, exerciseId = SQUAT) =>
	make(
		'set.log',
		{ position: 1, setIndex: 1, exerciseId, plannedLineage: null, ...done },
		{ workoutId }
	);
const edit = (set: Mutation) =>
	make('set.edit', { ...done, reps: 4 }, { workoutId: set.workoutId, entityId: set.entityId });
const remove = (set: Mutation) =>
	make('set.delete', {}, { workoutId: set.workoutId, entityId: set.entityId });
const update = (notes: string, workoutId = W) => make('workout.update', { notes }, { workoutId });
const finish = (workoutId = W) => make('workout.finish', { sessionRpe: 8 }, { workoutId });
const custom = () =>
	make('exercise.create', {
		name: 'Sandbag shouldering',
		aliases: [],
		pattern: 'carry',
		primaryMuscles: ['glutes'],
		secondaryMuscles: [],
		equipment: [],
		substitutionGroup: null,
		skillLevel: 'beginner',
		repMin: 3,
		repMax: 8,
		defaultSeconds: null,
		unilateral: false,
		measure: 'reps',
		loadType: 'external',
		tags: [],
		disciplines: []
	});

/** An outbox of these mutations, numbered 1, 2, 3… in order. */
const outbox = (...mutations: Mutation[]) => mutations.map((m, i) => queued(i + 1, m));
const seqs = (entries: readonly OutboxEntry[]) => entries.map((e) => e.seq);
const sendable = (entries: OutboxEntry[], now = T0) =>
	seqs(nextBatch(entries, now, BATCH_CAPS.flush).entries);
const bodyBytes = (entries: readonly OutboxEntry[]) =>
	new TextEncoder().encode(JSON.stringify({ v: 1, mutations: entries.map((e) => e.envelope) }))
		.length;
const refused = (entry: OutboxEntry): OutboxEntry => ({
	...entry,
	parked: { reason: 'refused', errors: { 'payload.weight': 'Too heavy' }, message: 'Refused' }
});
const stuck = (entry: OutboxEntry): OutboxEntry => ({
	...entry,
	attempts: STUCK_AFTER.failures,
	failingSince: T0,
	parked: { reason: 'stuck', errors: {}, message: 'The server answered 500' }
});
const waiting = (entry: OutboxEntry, nextAt = T0 + 5 * SECOND): OutboxEntry => ({
	...entry,
	attempts: 1,
	failingSince: T0,
	nextAt
});
const answer = (entry: OutboxEntry, status: SyncResult['status'], extra = {}): SyncResult => ({
	id: entry.envelope.id,
	status,
	...extra
});
const half = () => 0.5;

describe('nextBatch', () => {
	it('sends in outbox order across workouts, whatever order it is given', () => {
		const [a, b, c, d] = outbox(log(W), log(W2), log(W), log(W2));
		expect(sendable([d!, a!, c!, b!])).toEqual([1, 2, 3, 4]);
	});

	it('takes at most 25 mutations', () => {
		const entries = outbox(...Array.from({ length: 30 }, () => log()));
		expect(BATCH_CAPS.flush.maxCount).toBe(25);
		expect(sendable(entries)).toEqual(seqs(entries.slice(0, 25)));
	});

	it.each([
		['a flush', BATCH_CAPS.flush, 64 * 1024],
		['the pagehide keepalive send', BATCH_CAPS.keepalive, 48 * 1024]
	])('keeps %s within its byte cap, counted in UTF-8', (_, caps, bytes) => {
		expect(caps.maxBytes).toBe(bytes);
		// 'é' is two bytes in UTF-8: counting characters would overfill the batch.
		const entries = outbox(...Array.from({ length: 12 }, () => update('é'.repeat(4000))));
		const batch = nextBatch(entries, T0, caps).entries;
		expect(batch.length).toBeGreaterThan(1);
		expect(bodyBytes(batch)).toBeLessThanOrEqual(bytes);
		expect(bodyBytes(entries.slice(0, batch.length + 1))).toBeGreaterThan(bytes);
		expect(seqs(batch)).toEqual(seqs(entries.slice(0, batch.length)));
	});

	it('stops at the first change that does not fit: a smaller later one never overtakes it', () => {
		const entries = outbox(
			log(W2),
			update('x'.repeat(40 * 1024)),
			update('y'.repeat(40 * 1024)),
			log(W2)
		);
		expect(sendable(entries)).toEqual([1, 2]);
	});

	it('leaves room in its byte cap for the largest discarded and held lists', () => {
		const ids = Array.from({ length: SYNC_LIMITS.maxMutations }, () => crypto.randomUUID());
		const fill = BATCH_CAPS.flush.maxBytes - bodyBytes(outbox(update(''))) - 10;
		const batch = nextBatch(outbox(update('x'.repeat(fill)), log(W2)), T0, BATCH_CAPS.flush);
		const mutations = batch.entries.map((e) => e.envelope);
		const body = JSON.stringify({ v: 1, mutations, discarded: ids, held: ids });
		expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(BATCH_CAPS.flush.maxBytes);
	});

	it('leaves 16 KB of the 64 KB keepalive quota for RUM', () => {
		expect(SYNC_LIMITS.maxBytes - BATCH_CAPS.keepalive.maxBytes).toBe(16 * 1024);
	});

	it('reports a change too large for any batch, holds its dependants and sends the rest', () => {
		const entries = outbox(log(W2), update('x'.repeat(70 * 1024)), finish(W), log(W2));
		const batch = nextBatch(entries, T0, BATCH_CAPS.flush);
		expect(seqs(batch.entries)).toEqual([1, 4]);
		expect(seqs(batch.tooLarge)).toEqual([2]);
	});

	it('sends with a flush what is too large only for the keepalive send', () => {
		const entries = outbox(update('x'.repeat(50 * 1024)), log(W2));
		const keepalive = nextBatch(entries, T0, BATCH_CAPS.keepalive);
		expect(seqs(keepalive.entries)).toEqual([2]);
		expect(seqs(keepalive.tooLarge)).toEqual([1]);
		expect(sendable(entries)).toEqual([1, 2]);
	});

	it('does not send an entry waiting for its retry, and nothing of its row overtakes it', () => {
		const a = log();
		const b = log();
		const [la, ea, lb, da] = outbox(a, edit(a), b, remove(a));
		const entries = [waiting(la!), ea!, lb!, da!];
		expect(sendable(entries, T0)).toEqual([3]);
		expect(sendable(entries, T0 + 5 * SECOND - 1)).toEqual([3]);
		expect(sendable(entries, T0 + 5 * SECOND)).toEqual([1, 2, 3, 4]);
	});

	it('holds the edit of a refused set.log, but not another set', () => {
		const a = log();
		const b = log();
		const [la, ea, lb, eb] = outbox(a, edit(a), b, edit(b));
		expect(sendable([refused(la!), ea!, lb!, eb!])).toEqual([3, 4]);
		expect(sendable([stuck(la!), ea!, lb!, eb!])).toEqual([3, 4]);
	});

	it('holds a whole workout behind its parked workout.start, but not another workout', () => {
		const [s, l, u, s2, l2] = outbox(start(W), log(W), update('Felt quick'), start(W2), log(W2));
		expect(sendable([refused(s!), l!, u!, s2!, l2!])).toEqual([4, 5]);
	});

	it('holds the sets that name a parked custom exercise, and what depends on them', () => {
		const exercise = custom();
		const named = log(W, exercise.entityId);
		const [c, l, e, other] = outbox(exercise, named, edit(named), log(W, LEG_PRESS));
		expect(sendable([refused(c!), l!, e!, other!])).toEqual([4]);
	});
});

describe('dependantsOf and discard', () => {
	it("discarding a create also removes its row's later edits and deletes, and nothing else", () => {
		const a = log();
		const b = log();
		const entries = outbox(a, b, edit(a), edit(b), remove(a));
		expect(seqs(dependantsOf(entries, 1))).toEqual([3, 5]);
		expect(seqs(discard(entries, 1))).toEqual([2, 4]);
	});

	it('discarding a workout.start removes its whole workout', () => {
		const entries = outbox(start(W), log(W), start(W2), log(W2), finish(W));
		expect(seqs(discard(entries, 1))).toEqual([3, 4]);
	});

	it('discarding a custom exercise removes the sets that name it and their edits', () => {
		const exercise = custom();
		const named = log(W, exercise.entityId);
		const entries = outbox(exercise, named, log(W, LEG_PRESS), edit(named));
		expect(seqs(dependantsOf(entries, 1))).toEqual([2, 4]);
		expect(seqs(discard(entries, 1))).toEqual([3]);
	});

	it('an unknown entry has no dependants and discards nothing', () => {
		const entries = outbox(log(), log());
		expect(dependantsOf(entries, 9)).toEqual([]);
		expect(discard(entries, 9)).toEqual(entries);
	});
});

describe('applyResults', () => {
	it('removes applied and duplicate, parks rejected with its errors, backs off deferred and retry', () => {
		const entries = outbox(log(), log(), log(), log(), log(), log());
		const [applied, duplicate, rejected, deferred, retry, unanswered] = entries;
		const errors = { 'payload.weight': 'Weight must be 500 kg or less' };
		const after = applyResults(
			entries,
			[
				answer(applied!, 'applied'),
				answer(duplicate!, 'duplicate'),
				answer(rejected!, 'rejected', { errors, code: 'invalid' }),
				answer(deferred!, 'deferred', { code: 'missing' }),
				answer(retry!, 'retry', { code: 'unavailable' })
			],
			T0,
			half
		);
		const backedOff = { attempts: 1, failingSince: T0, nextAt: T0 + 0.5 * SECOND };
		expect(after).toEqual([
			{ ...rejected, parked: { reason: 'refused', errors, message: SYNC_CODE_LABEL.invalid } },
			{ ...deferred, ...backedOff },
			{ ...retry, ...backedOff },
			unanswered
		]);
	});

	it("words a refusal by its code: 'Deleted on another device'", () => {
		const entries = outbox(edit(log()));
		const [parked] = applyResults(
			entries,
			[answer(entries[0]!, 'rejected', { code: 'deleted' })],
			T0,
			half
		);
		expect(parked?.parked).toEqual({
			reason: 'refused',
			errors: {},
			message: 'Deleted on another device'
		});
	});

	it('backs off further with each counted failure, never past 60 s', () => {
		let entries = outbox(log());
		const delays: number[] = [];
		for (let i = 0; i < 8; i++) {
			const now = T0 + i * HOUR;
			entries = applyResults(entries, [answer(entries[0]!, 'retry')], now, () => 1);
			delays.push(entries[0]!.nextAt! - now);
		}
		expect(delays).toEqual([1, 2, 4, 8, 16, 32, 60, 60].map((s) => s * SECOND));
	});

	it('keeps an entry answered retry 49 times, and parks it as stuck on the 50th, with its last error', () => {
		let entries = outbox(log(), log());
		const retryFirst = () => [answer(entries[0]!, 'retry', { code: 'unavailable' })];
		for (let i = 0; i < STUCK_AFTER.failures - 1; i++) {
			entries = applyResults(entries, retryFirst(), T0 + i * SECOND, half);
		}
		expect(STUCK_AFTER.failures).toBe(50);
		expect(entries[0]).toMatchObject({ seq: 1, attempts: 49, failingSince: T0 });
		expect(entries[0]?.parked).toBeUndefined();

		entries = applyResults(entries, retryFirst(), T0 + 49 * SECOND, half);
		expect(entries[0]).toMatchObject({ seq: 1, attempts: 50, nextAt: null });
		expect(entries[0]?.parked).toEqual({
			reason: 'stuck',
			errors: {},
			message: SYNC_CODE_LABEL.unavailable
		});
		expect(seqs(entries)).toEqual([1, 2]);
	});

	it('parks an entry deferred for 24 hours since its first counted failure', () => {
		const deferAt = (entries: OutboxEntry[], now: number) =>
			applyResults(entries, [answer(entries[0]!, 'deferred', { code: 'missing' })], now, half);
		let entries = deferAt(outbox(log()), T0);
		entries = deferAt(entries, T0 + 24 * HOUR - 1);
		expect(STUCK_AFTER.ms).toBe(24 * HOUR);
		expect(entries[0]).toMatchObject({ attempts: 2, failingSince: T0 });
		expect(entries[0]?.parked).toBeUndefined();
		entries = deferAt(entries, T0 + 24 * HOUR);
		expect(entries[0]?.parked).toEqual({
			reason: 'stuck',
			errors: {},
			message: 'Waiting for an earlier change'
		});
	});

	it('counts no time spent offline: not before the first failure, nor between failures', () => {
		const deferAt = (entries: OutboxEntry[], now: number) =>
			applyResults(entries, [answer(entries[0]!, 'deferred')], now, half);
		// Queued, then two days offline: its 24 hours start at its first counted failure.
		let entries = deferAt(outbox(log()), T0 + 48 * HOUR);
		expect(entries[0]).toMatchObject({ attempts: 1, failingSince: T0 + 48 * HOUR });
		// Offline for 30 hours an hour later: those hours do not count either.
		entries = backOnline(entries, T0 + 49 * HOUR, T0 + 79 * HOUR);
		expect(entries[0]).toMatchObject({ failingSince: T0 + 78 * HOUR, nextAt: null });
		entries = deferAt(entries, T0 + 79 * HOUR);
		expect(entries[0]?.parked).toBeUndefined();
		entries = deferAt(entries, T0 + 102 * HOUR);
		expect(entries[0]?.parked?.reason).toBe('stuck');
	});
});

describe('countFailure: a 5xx or a timeout of a batch the entry heads', () => {
	it('counts only that entry, parks it at the cap with its last error, and leaves its wait to the engine', () => {
		let entries = outbox(log(), log());
		for (let i = 0; i < STUCK_AFTER.failures - 1; i++) {
			entries = countFailure(entries, 1, 'The server answered 500', T0 + i * SECOND);
		}
		expect(entries[0]).toMatchObject({ attempts: 49, failingSince: T0, nextAt: null });
		expect(entries[0]?.parked).toBeUndefined();
		expect(entries[1]).toEqual(queued(2, entries[1]!.envelope));

		entries = countFailure(entries, 1, 'No answer in 15 s', T0 + HOUR);
		expect(entries[0]?.parked).toEqual({
			reason: 'stuck',
			errors: {},
			message: 'No answer in 15 s'
		});
	});

	it('changes nothing for a parked entry', () => {
		const entries = [refused(queued(1, log()))];
		expect(countFailure(entries, 1, 'The server answered 500', T0)).toEqual(entries);
	});
});

describe('backOnline', () => {
	it('ends every wait at once, so the next flush sends', () => {
		const [a, b] = outbox(log(), log());
		const entries = [waiting(a!, T0 + 30 * SECOND), refused(b!)];
		expect(sendable(entries)).toEqual([]);
		const online = backOnline(entries, T0 - SECOND, T0);
		expect(sendable(online)).toEqual([1]);
		expect(online[1]).toEqual(entries[1]);
	});
});

describe('tryAgain and replaceInPlace', () => {
	it('tryAgain clears the count of a stuck entry and keeps its place', () => {
		const [a, b, c] = outbox(log(), log(), log());
		const entries = [a!, stuck(b!), c!];
		const again = tryAgain(entries, 2);
		expect(again[1]).toEqual(queued(2, b!.envelope));
		expect(sendable(again)).toEqual([1, 2, 3]);
	});

	it('tryAgain leaves a refused entry for Fix or Discard', () => {
		const entries = [refused(queued(1, log()))];
		expect(tryAgain(entries, 1)).toEqual(entries);
	});

	it('replaceInPlace re-queues a fixed change under its seq and id, its type included', () => {
		const slot = {
			position: 2,
			plannedLineage: null,
			fromExerciseId: LEG_PRESS,
			toExerciseId: SQUAT
		};
		const dislike = make('exercise.dislike', { ...slot, note: null });
		const [a, d, c] = outbox(log(), dislike, log());
		const swap = make(
			'exercise.substitute',
			{ ...slot, reason: 'dislike' },
			{ entityId: dislike.entityId }
		);
		expect(swap.id).toBe(dislike.id);

		const fixed = replaceInPlace([a!, refused(d!), c!], 2, swap);
		expect(fixed[1]).toEqual(queued(2, swap));
		expect(fixed[1]?.envelope.type).toBe('exercise.substitute');
		expect(sendable(fixed)).toEqual([1, 2, 3]);
	});

	it('replaceInPlace refuses another id, which the ledger would take for a new change', () => {
		const entries = outbox(log());
		expect(() => replaceInPlace(entries, 1, log())).toThrow(RangeError);
	});
});

describe('nextDelay: full jitter', () => {
	it.each(Array.from({ length: 11 }, (_, attempt) => attempt))(
		'attempt %i waits between 0 and min(60 s, 1 s × 2^attempt)',
		(attempt) => {
			const ceiling = Math.min(60 * SECOND, SECOND * 2 ** attempt);
			expect(nextDelay(attempt, () => 0)).toBe(0);
			expect(nextDelay(attempt, () => 1)).toBe(ceiling);
			expect(nextDelay(attempt, () => 0.25)).toBe(ceiling / 4);
		}
	);

	it('never waits more than 60 s, however many attempts', () => {
		expect(BACKOFF).toEqual({ baseMs: SECOND, maxMs: 60 * SECOND });
		expect(nextDelay(50, () => 1)).toBe(60 * SECOND);
		expect(nextDelay(5000, () => 1)).toBe(60 * SECOND);
	});
});

describe('syncStatus', () => {
	const SESSIONS: SyncSession[] = ['active', 'signed-out', 'passkey-required'];
	const BOOLS = [true, false];
	const RETRY_AT = [null, T0 + 10 * SECOND];
	const [x, y] = outbox(log(), log());
	/** Every outbox the status tells apart: empty, ready, waiting, held behind a wait, parked. */
	const OUTBOXES: Record<string, OutboxEntry[]> = {
		empty: [],
		ready: [x!, y!],
		waiting: [waiting(x!, T0 + 1500), y!],
		held: [waiting(x!, T0 + 1500), queued(2, edit(x!.envelope))],
		parked: [refused(x!), y!]
	};

	/** Every context, with these fields fixed. */
	function contexts(fixed: Partial<StatusContext>): StatusContext[] {
		return SESSIONS.flatMap((session) =>
			BOOLS.flatMap((online) =>
				BOOLS.flatMap((inFlight) =>
					RETRY_AT.map((retryAt) => ({ session, online, inFlight, retryAt, now: T0, ...fixed }))
				)
			)
		);
	}
	const each = (
		names: string[],
		fixed: Partial<StatusContext>,
		expected: (entries: OutboxEntry[]) => OutboxStatus
	) => {
		for (const name of names) {
			const entries = OUTBOXES[name]!;
			for (const context of contexts(fixed)) {
				expect(syncStatus(entries, context), `${name} ${JSON.stringify(context)}`).toEqual(
					expected(entries)
				);
			}
		}
	};
	const ALL = Object.keys(OUTBOXES);

	it('signed out (a 401): sign in to sync, with what is waiting, whatever else holds', () => {
		each(ALL, { session: 'signed-out' }, (e) => ({ state: 'signed-out', waiting: e.length }));
	});

	it('a recovery session: finish adding your passkey, whatever else holds', () => {
		each(ALL, { session: 'passkey-required' }, (e) => ({ state: 'passkey', waiting: e.length }));
	});

	it('a parked entry needs attention, online or not', () => {
		each(['parked'], { session: 'active' }, () => ({ state: 'attention', count: 1 }));
	});

	it('offline, with what is pending', () => {
		each(['empty', 'ready', 'waiting', 'held'], { session: 'active', online: false }, (e) => ({
			state: 'offline',
			pending: e.length
		}));
	});

	it('online with nothing pending: synced', () => {
		each(['empty'], { session: 'active', online: true }, () => ({ state: 'synced' }));
	});

	it('online with a request on its way: saving', () => {
		each(['ready', 'waiting', 'held'], { session: 'active', online: true, inFlight: true }, () => ({
			state: 'saving',
			pending: 2
		}));
	});

	it('while the engine waits after a failed batch: retrying in its seconds', () => {
		each(
			['ready', 'waiting', 'held'],
			{ session: 'active', online: true, inFlight: false, retryAt: T0 + 10 * SECOND },
			() => ({ state: 'retrying', seconds: 10, pending: 2 })
		);
	});

	it('something ready to send: saving', () => {
		each(
			['ready', 'waiting'],
			{ session: 'active', online: true, inFlight: false, retryAt: null },
			() => ({
				state: 'saving',
				pending: 2
			})
		);
	});

	it('everything waiting, or held behind a wait: retrying in its seconds, rounded up', () => {
		each(['held'], { session: 'active', online: true, inFlight: false, retryAt: null }, () => ({
			state: 'retrying',
			seconds: 2,
			pending: 2
		}));
	});
});

describe('purity', () => {
	it('never changes what it is given', () => {
		const a = log();
		const entries = outbox(a, edit(a), log(), log());
		entries[2] = stuck(entries[2]!);
		const results = [answer(entries[0]!, 'retry'), answer(entries[1]!, 'deferred')];
		const before = structuredClone(entries);
		const frozen = Object.freeze(entries.map((e) => Object.freeze(e)));
		nextBatch(frozen, T0, BATCH_CAPS.flush);
		applyResults(frozen, Object.freeze(results), T0, half);
		countFailure(frozen, 1, 'The server answered 500', T0);
		backOnline(frozen, T0 - HOUR, T0);
		dependantsOf(frozen, 1);
		discard(frozen, 1);
		tryAgain(frozen, 3);
		replaceInPlace(frozen, 4, entries[3]!.envelope);
		syncStatus(frozen, {
			session: 'active',
			online: true,
			inFlight: false,
			retryAt: null,
			now: T0
		});
		expect(entries).toEqual(before);
	});
});
