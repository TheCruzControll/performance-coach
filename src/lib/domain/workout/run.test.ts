import { describe, expect, it } from 'vitest';
import { workoutDayKits } from '../../../../tests/fixtures/workout-day';
import { serverSplit } from '../../../../tests/fixtures/workout-sequences';
import { describeSegments } from '../training/describe';
import type { RunSegment } from '../training/types';
import type { RunSegmentKind } from '../training/vocabulary';
import { convertPace, paceSecondsPer } from '../units';
import { createMutation } from './mutations';
import type {
	Mutation,
	MutationInput,
	MutationOf,
	MutationType,
	RunSegmentFields
} from './mutations';
import { project, replay } from './project';
import type { WorkoutInputs } from './project';
import type { CanonicalWorkout } from './protocol';
import { runTable } from './reducers/tables';
import { expandSegments, runTotals, segmentPace } from './run';
import type { SegmentAmounts } from './run';
import type { RunKit, WorkoutView } from './types';

const KIT = workoutDayKits({ date: '2026-11-06' }).run;
const W = '00000000-0000-4000-8000-0000000000b1';

let ids = 0;
const fresh = () => `fresh-${++ids}`;
const at = (second: number) => new Date(Date.UTC(2026, 10, 6, 7, 0, second)).toISOString();

function make<T extends MutationType>(
	type: T,
	input: Omit<MutationInput<T>, 'workoutId' | 'at'> & { workoutId?: string; second?: number }
): MutationOf<T> {
	const { workoutId = W, second = 0, ...rest } = input;
	return createMutation(type, { workoutId, at: at(second), ...rest }, fresh);
}

const start = (kit: RunKit = KIT, workoutId = W) =>
	make('workout.start', {
		workoutId,
		entityId: workoutId,
		payload: {
			kind: 'run',
			title: kit.title,
			sessionType: kit.sessionType,
			discipline: kit.discipline,
			plannedSessionId: kit.plannedSessionId,
			plannedLineage: kit.plannedLineage,
			programId: kit.programId
		}
	});

const fields = (
	position: number,
	values: Partial<RunSegmentFields> = {},
	kind: RunSegmentKind = 'interval'
): RunSegmentFields => ({
	position,
	kind,
	distanceMetres: 400,
	durationSeconds: 90,
	avgHr: null,
	rpe: null,
	...values
});

/** A segment's first run.segment: it creates the segment under the id it is given. */
const addSegment = (id: string, values: RunSegmentFields, second = values.position) =>
	createMutation('run.segment', { workoutId: W, at: at(second), payload: values }, () => id);

/** A later run.segment of segment `id`: a fresh mutation id, all its values again. */
const editSegment = (id: string, values: RunSegmentFields, second = 60) =>
	make('run.segment', { entityId: id, second, payload: values });

const logRun = (payload: MutationOf<'run.log'>['payload'], second = 90) =>
	make('run.log', { second, payload });

function inputs(
	pending: readonly Mutation[],
	canonical: CanonicalWorkout | null = null,
	kit: RunKit = KIT
): WorkoutInputs {
	return { workoutId: W, kit, canonical, pending };
}

const view = (...args: Parameters<typeof inputs>) => project(runTable, inputs(...args));

/** The server's rows after it applied `mutations`: the same reducers on the canonical shape. */
const serverModel = (mutations: readonly Mutation[], kit: RunKit = KIT) =>
	replay(runTable, inputs(mutations, null, kit)).rows;

/** The view with every pending flag cleared: what the rows say, whatever is still unsent. */
function settled(v: WorkoutView | null): WorkoutView | null {
	const done = <R extends { pending: boolean }>(row: R): R => ({ ...row, pending: false });
	return (
		v && {
			...v,
			workout: done(v.workout),
			run: v.run && { ...done(v.run), segments: v.run.segments.map(done) }
		}
	);
}

/** A segment as run, as runTotals reads it. */
const ran = (
	distanceMetres: number | null,
	durationSeconds: number | null,
	avgHr: number | null = null
) => ({ distanceMetres, durationSeconds, avgHr }) satisfies SegmentAmounts;

/**
 * A small seeded generator (mulberry32), so a seed always gives the same run. The programming
 * domain's seededRandom is server-only, and this file is not.
 */
function seeded(seed: number) {
	let state = seed >>> 0;
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = Math.imul(state ^ (state >>> 15), state | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
	};
	return { next, int: (n: number) => Math.floor(next() * n) };
}

describe('expandSegments', () => {
	it('turns a warm-up, 6 × (400 m + 90 s) and a cool-down into the 14 segments run, in order', () => {
		const planned = expandSegments(KIT.run.segments);
		expect(planned).toHaveLength(14);
		expect(planned.map((s) => s.position)).toEqual([...Array(14).keys()].map((k) => k + 1));
		expect(planned.map((s) => [s.kind, s.repeat, s.repeats])).toEqual([
			['warm_up', null, null],
			...[1, 2, 3, 4, 5, 6].flatMap((round) => [
				['interval', round, 6],
				['recovery', round, 6]
			]),
			['cool_down', null, null]
		]);
	});

	it("gives every segment its plan's targets, and nothing of the repeat group's bookkeeping", () => {
		const [warmUp, interval, recovery] = expandSegments(KIT.run.segments);
		expect(warmUp!.target).toStrictEqual({
			distanceMetres: null,
			durationSeconds: 600,
			paceMinSecondsPerKm: null,
			paceMaxSecondsPerKm: null,
			hrZone: 2,
			targetRpe: null
		});
		expect(interval!.target).toMatchObject({
			distanceMetres: 400,
			durationSeconds: null,
			paceMinSecondsPerKm: 225,
			paceMaxSecondsPerKm: 240
		});
		expect(recovery!.target).toMatchObject({ distanceMetres: null, durationSeconds: 90 });
		expect(Object.keys(interval!.target)).not.toContain('repeatGroup');
		const last = expandSegments(KIT.run.segments)[12]!;
		expect([last.kind, last.repeat, last.target]).toEqual(['recovery', 6, recovery!.target]);
	});

	it("numbers each group's rounds from 1, and repeats exactly the steps M3's describe shows", () => {
		const s = (kind: RunSegmentKind, group: number | null, repeats: number | null) =>
			({
				...KIT.run.segments[0]!,
				kind,
				repeatGroup: group,
				repeats,
				durationSeconds: 60
			}) satisfies RunSegment;
		const plan = [
			s('easy', null, null),
			s('tempo', 1, 3),
			s('steady', null, null),
			s('interval', 2, 2),
			s('recovery', 2, 2),
			s('cool_down', null, null)
		];
		const planned = expandSegments(plan);
		expect(planned.map((p) => `${p.kind}${p.repeat ?? ''}`)).toEqual([
			'easy',
			'tempo1',
			'tempo2',
			'tempo3',
			'steady',
			'interval1',
			'recovery1',
			'interval2',
			'recovery2',
			'cool_down'
		]);
		const steps = describeSegments(plan, { distanceUnit: 'km' });
		expect(planned).toHaveLength(
			steps.reduce((n, step) => n + step.repeats * step.segments.length, 0)
		);
		expect(expandSegments(KIT.run.segments)).toHaveLength(
			describeSegments(KIT.run.segments, { distanceUnit: 'km' }).reduce(
				(n, step) => n + step.repeats * step.segments.length,
				0
			)
		);
	});

	it('gives an ad-hoc run, which has no plan, no segments', () => {
		expect(expandSegments([])).toEqual([]);
	});
});

describe('segmentPace', () => {
	it("is M1's paceSecondsPer per km, shown in the owner's unit through convertPace", () => {
		expect(segmentPace(ran(400, 90), 'km')).toBe(paceSecondsPer(90, 400, 'km'));
		expect(segmentPace(ran(400, 90), 'km')).toBeCloseTo(225, 9);
		expect(segmentPace(ran(400, 90), 'mi')).toBe(convertPace(225, 'km', 'mi'));
		expect(segmentPace(ran(400, 90), 'mi')).toBeCloseTo(362.1024, 9);
		// 5 mi (8046.72 m, through M1's toMetres) in 40:00 is 8:00 /mi.
		expect(segmentPace(ran(8046.72, 2400), 'mi')).toBeCloseTo(480, 9);
		expect(segmentPace(ran(8046.72, 2400), 'km')).toBeCloseTo(298.258172, 6);
	});

	it('has none without both a distance and a time', () => {
		expect(segmentPace(ran(null, 90), 'km')).toBeNull();
		expect(segmentPace(ran(400, null), 'mi')).toBeNull();
		expect(segmentPace(ran(null, null), 'km')).toBeNull();
	});
});

describe('runTotals', () => {
	/** The fixture's run as run: a 2 km warm-up, six 400 m reps with 90 s standing recoveries, a 1.5 km cool-down. */
	const RUN = [
		ran(2000, 600, 132),
		...[84, 85, 86, 85, 87, 88].flatMap((seconds) => [ran(400, seconds, 171), ran(null, 90, 140)]),
		ran(1500, 600, 128)
	];

	it('sums the distance and the time the segments recorded; the pace is that of the totals', () => {
		const totals = runTotals(RUN);
		expect(totals.distanceMetres).toBe(2000 + 6 * 400 + 1500);
		expect(totals.durationSeconds).toBe(600 + 515 + 6 * 90 + 600);
		// The pace run_records generates from the run's own distance and time.
		expect(segmentPace(totals, 'km')).toBeCloseTo((2255 * 1000) / 5900, 9);
		expect(runTotals([ran(8046.72, 2400), ran(0.1 + 0.2, 1)]).distanceMetres).toBe(8047.02);
	});

	it('ignores skipped segments: only what was run counts, never a target', () => {
		// Intervals 5 and 6 and their recoveries skipped: the screen lists them with no actuals,
		// and the run's rows never hold them.
		const notRun = ran(null, null);
		const listed = [...RUN.slice(0, 9), notRun, notRun, notRun, notRun, RUN[13]!];
		const rows = [...RUN.slice(0, 9), RUN[13]!];
		const expected = {
			distanceMetres: 2000 + 4 * 400 + 1500,
			durationSeconds: 600 + (84 + 85 + 86 + 85) + 4 * 90 + 600,
			// (132 × 600 + 171 × 340 + 140 × 360 + 128 × 600) / 1900 s
			avgHr: 139
		};
		expect(runTotals(listed)).toStrictEqual(expected);
		expect(runTotals(rows)).toStrictEqual(expected);
		expect(runTotals([notRun, notRun])).toStrictEqual({
			distanceMetres: null,
			durationSeconds: null,
			avgHr: null
		});
		expect(runTotals([])).toStrictEqual(runTotals([notRun]));
	});

	it('takes HR as optional: a time-weighted mean of the segments that have one, never a 0', () => {
		expect(runTotals([ran(2000, 600, 130), ran(400, 90), ran(1500, 600, 150)]).avgHr).toBe(140);
		expect(runTotals([ran(2000, 600, 130), ran(400, 120, 172)]).avgHr).toBe(137);
		expect(runTotals([ran(400, 90), ran(null, 90)]).avgHr).toBeNull();
		// A heart rate with no time to weigh it by is left out.
		expect(runTotals([ran(400, null, 190), ran(1000, 300, 150)]).avgHr).toBe(150);
		expect(Number.isInteger(runTotals(RUN).avgHr)).toBe(true);
	});

	it('keeps a total with nothing behind it empty, not 0', () => {
		expect(runTotals([ran(null, 90), ran(null, 600)])).toStrictEqual({
			distanceMetres: null,
			durationSeconds: 690,
			avgHr: null
		});
		expect(runTotals([ran(400, null)]).durationSeconds).toBeNull();
	});
});

describe('the run reducers', () => {
	it("adds a segment on its first run.segment, creating the run's record with empty totals", () => {
		const v = view([start(), addSegment('g1', fields(2, { durationSeconds: 84, avgHr: 170 }))])!;
		expect(v.run).toStrictEqual({
			distanceMetres: null,
			durationSeconds: null,
			avgHr: null,
			rpe: null,
			notes: null,
			paceSecondsPerKm: null,
			pending: false,
			segments: [
				{
					id: 'g1',
					position: 2,
					kind: 'interval',
					distanceMetres: 400,
					durationSeconds: 84,
					avgHr: 170,
					rpe: null,
					paceSecondsPerKm: segmentPace(ran(400, 84), 'km'),
					pending: true
				}
			]
		});
		expect(v.run!.segments[0]!.paceSecondsPerKm).toBeCloseTo(210, 9);
	});

	it('replaces a segment edited after its create absolutely, on top of the outbox or of the server rows', () => {
		const created = addSegment('g1', fields(2, { durationSeconds: 84, avgHr: 170, rpe: 8 }));
		const corrected = editSegment('g1', fields(2, { durationSeconds: 88 }));
		const expected = {
			id: 'g1',
			...fields(2, { durationSeconds: 88 }),
			paceSecondsPerKm: segmentPace(ran(400, 88), 'km')
		};
		const local = view([start(), created, corrected])!;
		expect(local.run!.segments).toStrictEqual([{ ...expected, pending: true }]);
		// HR and RPE left blank on the correction are cleared, not kept from the first send.
		expect(local.run!.segments[0]).toMatchObject({ avgHr: null, rpe: null });

		const synced = serverModel([start(), created]);
		expect(view([corrected], synced)!.run!.segments).toStrictEqual([
			{ ...expected, pending: true }
		]);
		expect(view([], serverModel([start(), created, corrected]))!.run!.segments).toStrictEqual([
			{ ...expected, pending: false }
		]);
	});

	it('never lets a replayed create undo a later correction, nor adds a segment twice', () => {
		const created = addSegment('g1', fields(2));
		const corrected = editSegment('g1', fields(2, { durationSeconds: 95 }));
		const canonical = serverModel([start(), created, corrected]);
		const v = view([created], canonical)!;
		expect(v.run!.segments.map((s) => [s.id, s.durationSeconds, s.pending])).toEqual([
			['g1', 95, true]
		]);
		expect(serverModel([start(), created, created])).toStrictEqual(serverModel([start(), created]));
	});

	it('keeps a correction of a segment not known yet waiting, and applies it once the segment arrives', () => {
		const early = editSegment('g9', fields(3, { durationSeconds: 80 }));
		expect(serverModel([start(), early])).toStrictEqual(serverModel([start()]));
		expect(view([early], serverModel([start()]))!.run).toBeNull();
		const elsewhere = serverModel([start(), addSegment('g9', fields(3))]);
		expect(view([early], elsewhere)!.run!.segments[0]).toMatchObject({
			id: 'g9',
			durationSeconds: 80,
			pending: true
		});
	});

	const EMPTY_OWN = {
		distanceMetres: null,
		durationSeconds: null,
		avgHr: null,
		rpe: null,
		notes: null,
		paceSecondsPerKm: null
	};

	it("sets the run's own fields a run.log carries, absolutely, with the pace of its distance and time", () => {
		const first = logRun({ distanceMetres: 5000, durationSeconds: 1500, rpe: 7, avgHr: 150 });
		const later = logRun({ durationSeconds: 1560, rpe: 8, avgHr: null, notes: 'Windy' }, 120);
		const run = (pending: Mutation[], canonical: CanonicalWorkout | null = null) => {
			const { segments, ...own } = view(pending, canonical)!.run!;
			return { own, segments };
		};
		expect(run([start(), first]).own).toStrictEqual({
			distanceMetres: 5000,
			durationSeconds: 1500,
			avgHr: 150,
			rpe: 7,
			notes: null,
			paceSecondsPerKm: 300,
			pending: true
		});
		const expected = {
			distanceMetres: 5000,
			durationSeconds: 1560,
			avgHr: null,
			rpe: 8,
			notes: 'Windy',
			paceSecondsPerKm: 312,
			pending: true
		};
		expect(run([start(), first, later]).own).toStrictEqual(expected);
		expect(run([later], serverModel([start(), first])).own).toStrictEqual(expected);
		expect(run([start(), first, later]).segments).toEqual([]);
		// A run.log carries only the run's fields: nothing else it holds reaches the record.
		const sneaky = logRun({ rpe: 6, ...{ segments: [{ id: 'junk' }], paceSecondsPerKm: 1 } });
		expect(run([start(), sneaky])).toStrictEqual({
			own: { ...EMPTY_OWN, rpe: 6, pending: true },
			segments: []
		});
	});

	it("keeps a run's totals and its segments apart, whichever arrives first", () => {
		const segment = addSegment('g1', fields(1, { distanceMetres: 1000, durationSeconds: 300 }));
		const log = logRun({ distanceMetres: 5000, durationSeconds: 1500 });
		const one = serverModel([start(), segment, log]);
		const other = serverModel([start(), log, segment]);
		expect(other).toStrictEqual(one);
		expect(one!.run).toMatchObject({ distanceMetres: 5000, paceSecondsPerKm: 300 });
		expect(one!.run!.segments.map((s) => s.id)).toEqual(['g1']);
	});

	it('takes free segments on an ad-hoc run, at any position, in any kind', () => {
		const adhoc: RunKit = {
			...KIT,
			title: 'Run',
			plannedLineage: null,
			plannedSessionId: null,
			programId: null,
			versionNumber: null,
			run: { segments: [] }
		};
		const pending = [
			start(adhoc),
			addSegment('f2', fields(2, { distanceMetres: 3000, durationSeconds: 900 }, 'tempo')),
			addSegment('f1', fields(1, { distanceMetres: 2000, durationSeconds: 660 }, 'easy')),
			addSegment('f3', fields(3, { distanceMetres: 1000, durationSeconds: 360 }, 'easy'))
		];
		const v = view(pending, null, adhoc)!;
		expect(expandSegments(adhoc.run.segments)).toEqual([]);
		expect(v.run!.segments.map((s) => [s.id, s.position, s.kind])).toEqual([
			['f1', 1, 'easy'],
			['f2', 2, 'tempo'],
			['f3', 3, 'easy']
		]);
		expect(runTotals(v.run!.segments)).toMatchObject({
			distanceMetres: 6000,
			durationSeconds: 1920
		});
	});

	describe('replay', () => {
		const SEEDS = 300;

		/** What one device could send for one run, in outbox order. */
		function runSequence(seed: number): Mutation[] {
			const random = seeded(seed);
			let second = 0;
			const tick = () => (second += 1 + random.int(20));
			const made: string[] = [];
			const out: Mutation[] = [start()];
			const values = (position: number) =>
				fields(position, {
					distanceMetres: random.int(3) === 0 ? null : 100 * (1 + random.int(20)),
					durationSeconds: 30 + random.int(600),
					avgHr: random.int(2) === 0 ? null : 120 + random.int(60),
					rpe: random.int(2) === 0 ? null : 5 + random.int(6)
				});
			for (let step = 0, steps = 2 + random.int(20); step < steps; step++) {
				const roll = random.next();
				if (roll < 0.45 || made.length === 0) {
					const id = `00000000-0000-4000-8000-${String(seed * 100 + made.length).padStart(12, '0')}`;
					made.push(id);
					out.push(
						createMutation(
							'run.segment',
							{ workoutId: W, at: at(tick()), payload: values(made.length) },
							() => id
						)
					);
				} else if (roll < 0.8) {
					const k = random.int(made.length);
					out.push(editSegment(made[k]!, values(k + 1), tick()));
				} else {
					out.push(
						logRun(
							random.int(2) === 0
								? {
										distanceMetres: 1000 * (1 + random.int(10)),
										durationSeconds: 300 + random.int(3000)
									}
								: { rpe: 5 + random.int(6), notes: random.int(2) === 0 ? null : `Run ${seed}` },
							tick()
						)
					);
				}
			}
			if (random.int(3) === 0) out.push(make('workout.finish', { second: tick(), payload: {} }));
			return out;
		}

		it(`folds ${SEEDS} seeded runs to one view, however the server and the outbox overlap`, () => {
			let overlaps = 0;
			for (let seed = 1; seed <= SEEDS; seed++) {
				const M = runSequence(seed);
				const fold = settled(view(M));
				const { k, applied, random } = serverSplit(seed, M);
				const server = serverModel(applied);
				const canonical = server && {
					...server,
					run: server.run && { ...server.run, segments: random.shuffle(server.run.segments) }
				};
				for (let i = 0; i <= k + 1; i++) {
					const v = view(M.slice(i), canonical);
					expect(settled(v), `seed ${seed}, k ${k}, i ${i}`).toStrictEqual(fold);
					const touched = new Set(M.slice(i).map((m) => `${m.type}:${m.entityId}`));
					for (const s of v!.run?.segments ?? []) {
						expect(s.pending).toBe(touched.has(`run.segment:${s.id}`));
					}
					expect(v!.run?.pending ?? false).toBe(touched.has(`run.log:${W}`));
					if (i <= k) overlaps++;
				}
				// Replaying every mutation on rows that already hold them all changes nothing.
				expect(settled(view(M, serverModel(M)))).toStrictEqual(fold);
				expect(view(M)).toStrictEqual(view(M));
			}
			expect(overlaps).toBeGreaterThan(SEEDS);
		}, 30_000);

		it('generates runs that create, correct and total segments', () => {
			const counts = { create: 0, edit: 0, log: 0 };
			for (let seed = 1; seed <= SEEDS; seed++) {
				for (const m of runSequence(seed)) {
					if (m.type === 'run.log') counts.log++;
					if (m.type !== 'run.segment') continue;
					if (m.id === m.entityId) counts.create++;
					else counts.edit++;
				}
			}
			for (const [kind, count] of Object.entries(counts)) expect(count, kind).toBeGreaterThan(300);
		});
	});
});
