import { describe, expect, it } from 'vitest';
import { CATALOGUE } from '../../exercises/index';
import type { TrainingProfile } from '../../profile/types';
import { buildProgrammingInput } from '../input';
import { SCENARIOS } from '../scenarios';
import type { CycleDirectives } from '../review/directives';
import { actualsOverlay, nextBlockInput } from './input';
import type { ResultsSnapshot } from './input';

const SQUAT = 'back_squat';
const BENCH = 'bench_press';
const CURL = 'barbell_curl';
const LEG_EXT = 'leg_extension';

/** The hybrid scenario (squat 140 measured, bench 100 estimated, 30 km a week) with changes. */
function base(change: (p: TrainingProfile) => void = () => {}) {
	const profile = SCENARIOS.hybrid();
	change(profile);
	return buildProgrammingInput(profile, { catalogue: CATALOGUE });
}

const directives = (over: Partial<CycleDirectives> = {}): CycleDirectives => ({
	fromBlockLineage: '5b3c3d0e-8f5a-4a43-9a9c-2f0f6a1c0b01',
	phase: 'marathon_base',
	weeks: 4,
	fromOutline: true,
	keep: [{ exercise: SQUAT, reason: 'Progressed over 4 sessions' }],
	rotate: [{ exercise: LEG_EXT, reason: 'Stalled over 4 sessions: a fresh stimulus' }],
	volume: [],
	rpe: [7, 8.5],
	deload: 'none',
	running: { weeklyMetres: 32000, longRunMetres: 20000, paces: [] },
	avoidDays: [],
	progression: 'progress',
	...over
});

const week = (weekStart: string, km: number) => ({ weekStart, metres: km * 1000 });
const longRun = (weekStart: string, km: number, at: string) => ({
	weekStart,
	run: { workout: `w-${weekStart}`, startedAt: new Date(at), metres: km * 1000, seconds: null }
});
const easy = (at: string, km: number, seconds: number) => ({
	workout: `e-${at}`,
	startedAt: new Date(at),
	sessionType: 'easy_run' as const,
	distanceMetres: km * 1000,
	durationSeconds: seconds
});

const snapshot = (over: Partial<ResultsSnapshot> = {}): ResultsSnapshot => ({
	timeZone: 'UTC',
	e1rms: [],
	maxes: [],
	running: null,
	...over
});

const RUNNING: NonNullable<ResultsSnapshot['running']> = {
	// Older weeks ran less: only the last three count.
	weeks: [
		week('2026-10-05', 10),
		week('2026-10-12', 30),
		week('2026-10-19', 32),
		week('2026-10-26', 34)
	],
	longRuns: [
		longRun('2026-10-12', 22, '2026-10-18T08:00:00Z'),
		longRun('2026-10-19', 24.37, '2026-10-25T08:00:00Z'),
		{ weekStart: '2026-10-26', run: null }
	],
	paces: [
		easy('2026-10-20T07:00:00Z', 10, 3000),
		{ ...easy('2026-10-21T07:00:00Z', 8, 2000), sessionType: 'tempo_run' },
		easy('2026-10-27T07:00:00Z', 10, 3400)
	],
	efforts: [
		{
			best: {
				id: 'w-5k',
				label: 'best_effort',
				kind: 'measured',
				on: new Date('2026-10-22T07:00:00Z'),
				distanceMetres: 5000,
				durationSeconds: 1300,
				paceSecondsPerKm: 260,
				eventName: null
			}
		},
		{ best: null }
	]
};

describe('nextBlockInput: baselines', () => {
	it('turns a 140 kg squat e1RM into an estimated baseline of 140', () => {
		const { input, assumptions } = nextBlockInput(
			base((p) => (p.baselines = [{ ...p.baselines[0]!, value: 120 }])),
			snapshot({ e1rms: [{ lift: SQUAT, point: { value: 140.00000001, on: '2026-10-30' } }] }),
			directives()
		);
		expect(input.baselines.back_squat).toEqual({ kg: 140, kind: 'estimated' });
		expect(assumptions).toContainEqual(
			expect.objectContaining({ rule: 'e1rm_baseline', field: 'baselines.back_squat', value: 140 })
		);
	});

	it('takes the latest of several e1RMs for one lift', () => {
		const { input } = nextBlockInput(
			base(),
			snapshot({
				e1rms: [
					{ lift: SQUAT, point: { value: 150, on: '2026-10-01' } },
					{ lift: SQUAT, point: { value: 142.5, on: '2026-10-30' } }
				]
			}),
			directives()
		);
		expect(input.baselines.back_squat).toEqual({ kg: 142.5, kind: 'estimated' });
	});

	it('keeps a measured bench 1RM newer than the latest e1RM as measured', () => {
		const measured = (p: TrainingProfile) =>
			(p.baselines = [{ ...p.baselines[1]!, kind: 'measured', source: 'tested', value: 110 }]);
		const { input, assumptions } = nextBlockInput(
			base(measured),
			snapshot({
				e1rms: [{ lift: BENCH, point: { value: 104, on: '2026-10-20' } }],
				maxes: [{ lift: BENCH, kind: 'measured', kg: 110, on: '2026-10-28' }]
			}),
			directives()
		);
		expect(input.baselines.bench_press).toEqual({ kg: 110, kind: 'measured' });
		expect(assumptions).toContainEqual(
			expect.objectContaining({ rule: 'measured_kept', field: 'baselines.bench_press' })
		);
		// An older (or undated) measured 1RM gives way to the e1RM.
		for (const on of ['2026-10-01', null]) {
			const older = nextBlockInput(
				base(measured),
				snapshot({
					e1rms: [{ lift: BENCH, point: { value: 104, on: '2026-10-20' } }],
					maxes: [{ lift: BENCH, kind: 'measured', kg: 110, on }]
				}),
				directives()
			);
			expect(older.input.baselines.bench_press).toEqual({ kg: 104, kind: 'estimated' });
		}
	});

	it('keeps the profile’s value, or null, for a lift with no estimate', () => {
		const told = base();
		const { input, assumptions } = nextBlockInput(told, snapshot(), directives());
		expect(input.baselines.back_squat).toEqual({ kg: 140, kind: 'measured' });
		expect(input.baselines.bench_press).toEqual({ kg: 100, kind: 'estimated' });
		expect(input.baselines.deadlift).toBeNull();
		expect(input.baselines).toEqual(told.baselines);
		expect(assumptions.filter((a) => a.rule === 'profile_baseline').map((a) => a.field)).toEqual([
			'baselines.back_squat',
			'baselines.bench_press'
		]);
	});
});

describe('nextBlockInput: running', () => {
	const told = () =>
		base((p) => (p.running = { ...p.running!, weeklyDistance: 20, longestRun: 15 }));

	it('takes weekly metres from an actual 32 km, not the profile’s 20', () => {
		const { input, assumptions } = nextBlockInput(
			told(),
			snapshot({ running: RUNNING }),
			directives()
		);
		expect(told().running!.weeklyMetres).toBe(20000);
		// (30 + 32 + 34) ÷ 3 = 32 km; the 10 km week is older than the last three.
		expect(input.running!.weeklyMetres).toBe(32000);
		expect(assumptions).toContainEqual(
			expect.objectContaining({
				rule: 'actual_weekly',
				field: 'running.weeklyMetres',
				value: 32000
			})
		);
	});

	it('takes the longest run from the last completed long run, rounded down to 100 m', () => {
		const { input } = nextBlockInput(told(), snapshot({ running: RUNNING }), directives());
		// The week of 26 Oct had no long run: the 24.37 km of 25 Oct is the last, not the 22 km.
		expect(input.running!.longestRunMetres).toBe(24300);
	});

	it('takes easy pace from recent easy runs only, and adds the best logged effort to the races', () => {
		const { input } = nextBlockInput(told(), snapshot({ running: RUNNING }), directives());
		// 6400 s over 20 km of easy runs: 320 s/km; the tempo run does not count.
		expect(input.running!.easyPaceSecondsPerKm).toBe(320);
		expect(input.running!.races).toEqual([
			{ distanceMetres: 5000, timeSeconds: 1300, racedOn: '2026-10-22' }
		]);
	});

	it('keeps the profile’s running where the block showed none', () => {
		const { input } = nextBlockInput(
			told(),
			snapshot({ running: { weeks: [], longRuns: [], paces: [], efforts: [] } }),
			directives()
		);
		expect(input.running).toEqual(told().running);
	});

	it('drops the running-volume default once the actual distance replaces it', () => {
		const blank = base((p) => (p.running = { ...p.running!, weeklyDistance: null }));
		expect(blank.assumptions.map((a) => a.field)).toContain('running.weeklyMetres');
		const { input } = nextBlockInput(blank, snapshot({ running: RUNNING }), directives());
		expect(input.assumptions.map((a) => a.field)).not.toContain('running.weeklyMetres');
	});
});

describe('nextBlockInput: kept and rotated exercises', () => {
	it('likes the kept exercises and leaves the rotated ones out for the block', () => {
		const { input, assumptions } = nextBlockInput(base(), snapshot(), directives());
		expect(input.likes).toContain(SQUAT);
		expect(input.dislikes).toContain(LEG_EXT);
		expect(assumptions).toContainEqual(
			expect.objectContaining({ rule: 'rotated_excluded', value: LEG_EXT })
		);
	});

	it('never rotates a liked exercise', () => {
		const liked = base((p) => {
			p.exercises = [{ id: 'pref-1', exercise: 'Barbell curl', sentiment: 'like', reason: null }];
		});
		expect(liked.likes).toContain(CURL);
		const { input, assumptions } = nextBlockInput(
			liked,
			snapshot(),
			directives({ rotate: [{ exercise: CURL, reason: 'Stalled' }] })
		);
		expect(input.likes).toContain(CURL);
		expect(input.dislikes).not.toContain(CURL);
		expect(assumptions).toContainEqual(
			expect.objectContaining({ rule: 'liked_not_rotated', value: CURL })
		);
	});
});

describe('nextBlockInput: overrides', () => {
	it('clamps an out-of-bounds override and records it', () => {
		const { input, assumptions, subset } = nextBlockInput(
			base(),
			snapshot({ running: RUNNING }),
			directives(),
			{
				targets: { rpeCap: 10, volumeFactor: 1, loadStep: 0.025, runVolumeFactor: 1 },
				running: { weeklyMetres: 60000, longRunMetres: null }
			}
		);
		expect(subset.targets.rpeCap).toBe(8.5);
		// 32 km directed, at most +10 %.
		expect(input.running!.weeklyMetres).toBe(35200);
		expect(assumptions).toContainEqual({
			rule: 'override_clamped',
			field: 'targets.rpeCap',
			value: 8.5,
			why: 'Asked for 10: held to 8.5, the most this review allows'
		});
		expect(assumptions).toContainEqual(
			expect.objectContaining({
				rule: 'override_clamped',
				field: 'running.weeklyMetres',
				value: 35200
			})
		);
	});

	it('records nothing without overrides', () => {
		const { assumptions } = nextBlockInput(base(), snapshot(), directives());
		expect(assumptions.filter((a) => a.rule === 'override_clamped')).toEqual([]);
	});
});

describe('nextBlockInput: determinism', () => {
	it('gives the same result for the same arguments, whatever the order of the snapshot’s lists', () => {
		const s = snapshot({
			running: RUNNING,
			e1rms: [
				{ lift: SQUAT, point: { value: 140, on: '2026-10-30' } },
				{ lift: BENCH, point: { value: 104, on: '2026-10-29' } }
			]
		});
		const reversed: ResultsSnapshot = {
			...s,
			e1rms: [...s.e1rms].reverse(),
			running: {
				weeks: [...RUNNING.weeks].reverse(),
				longRuns: [...RUNNING.longRuns].reverse(),
				paces: [...RUNNING.paces].reverse(),
				efforts: [...RUNNING.efforts].reverse()
			}
		};
		const first = nextBlockInput(base(), s, directives());
		expect(nextBlockInput(base(), s, directives())).toEqual(first);
		expect(JSON.stringify(nextBlockInput(base(), reversed, directives()))).toBe(
			JSON.stringify(first)
		);
	});
});

describe('actualsOverlay: what the training showed, with no cycle review (M7 re-plans)', () => {
	const actual = snapshot({
		e1rms: [{ lift: SQUAT, point: { value: 152.5, on: '2026-10-30' } }],
		running: RUNNING
	});

	it('sets the e1RM baselines and the actual running, recording each, and nothing else', () => {
		const { input, assumptions } = actualsOverlay(base(), actual);
		expect(input.baselines.back_squat).toEqual({ kg: 152.5, kind: 'estimated' });
		expect(input.running?.weeklyMetres).toBe(32000);
		expect(input.running?.longestRunMetres).toBe(24300);
		expect(assumptions.map((a) => a.rule)).toEqual(
			expect.arrayContaining(['e1rm_baseline', 'actual_weekly', 'last_long_run', 'easy_pace'])
		);
		// No directive is read: likes and dislikes stay the profile's, and nothing is clamped.
		expect(input.likes).toEqual(base().likes);
		expect(input.dislikes).toEqual(base().dislikes);
		expect(assumptions.some((a) => a.rule.startsWith('kept') || a.rule.startsWith('rotated'))).toBe(
			false
		);
	});

	it('is the overlay nextBlockInput applies before the directives', () => {
		const alone = actualsOverlay(base(), actual);
		const next = nextBlockInput(base(), actual, directives({ keep: [], rotate: [] }));
		expect(next.input).toEqual({ ...alone.input, likes: next.input.likes });
		expect(next.assumptions).toEqual(alone.assumptions);
	});

	it('leaves an input with nothing logged as it was, but for the profile’s baselines noted', () => {
		const { input, assumptions } = actualsOverlay(base(), snapshot());
		expect(input).toEqual(base());
		expect(assumptions.every((a) => a.rule === 'profile_baseline')).toBe(true);
	});
});
