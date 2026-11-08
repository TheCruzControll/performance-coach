import { describe, expect, it } from 'vitest';
import { addDays } from '../../calendar';
import type {
	BlockPlan,
	OtherSessionPlan,
	ProgramPlan,
	RunSessionPlan,
	SessionPlan,
	SetPrescription,
	StrengthSessionPlan,
	WeekPlan
} from '../../training/types';
import type { Phase, WeekKind } from '../../training/vocabulary';
import {
	describeChanges,
	noChange,
	shapeDigest,
	SUMMARY_LINES_MAX,
	weekShapes,
	type ChangeExercise,
	type ChangeOptions
} from './changes';

// Mondays: 9, 16, 23 and 30 Nov 2026.
const W1 = '2026-11-09';
const W2 = '2026-11-16';
const W3 = '2026-11-23';
const W4 = '2026-11-30';

const EXERCISES = new Map<string, ChangeExercise>([
	['back_squat', { name: 'Back squat', primaryMuscles: ['quads'], secondaryMuscles: ['glutes'] }],
	['bench_press', { name: 'Bench press', primaryMuscles: ['chest'], secondaryMuscles: [] }]
]);

const KM_KG: ChangeOptions = {
	units: { unit: 'kg', distanceUnit: 'km' },
	from: W2,
	exercises: EXERCISES
};
const MI_LB: ChangeOptions = { ...KM_KG, units: { unit: 'lb', distanceUnit: 'mi' } };

const base = {
	timeOfDay: null,
	orderInDay: 1,
	customDiscipline: null,
	intensity: 'moderate',
	source: 'generator',
	commitmentRef: null,
	instructions: null,
	notes: null
} as const;

const set = (overrides: Partial<SetPrescription> = {}): SetPrescription => ({
	role: 'working',
	sets: 3,
	repsMin: 5,
	repsMax: 5,
	seconds: null,
	metres: null,
	targetRpe: 8,
	loadKind: 'absolute',
	loadValue: 100,
	loadUnit: 'kg',
	loadBasis: null,
	reference1rm: null,
	reference1rmUnit: null,
	restSeconds: 180,
	tempo: null,
	notes: null,
	...overrides
});

const lift = (
	date: string,
	title: string,
	loadKg = 100,
	key = 'back_squat'
): StrengthSessionPlan => ({
	...base,
	kind: 'strength',
	type: 'strength',
	discipline: 'strength',
	date,
	title,
	estMinutes: 45,
	estLoad: 360,
	targetRpe: 8,
	exercises: [
		{
			exercise: { key },
			baselineLift: null,
			superset: null,
			substitutedFrom: null,
			substitutionReason: null,
			instructions: null,
			notes: null,
			sets: [set({ loadValue: loadKg })]
		}
	]
});

const longRun = (date: string, metres: number): RunSessionPlan => ({
	...base,
	kind: 'run',
	type: 'long_run',
	discipline: 'running',
	date,
	title: 'Long run',
	estMinutes: Math.round(metres / 200),
	estLoad: Math.round(metres / 200) * 5,
	targetRpe: 5,
	segments: [
		{
			kind: 'long',
			repeatGroup: null,
			repeats: null,
			distanceMetres: metres,
			durationSeconds: null,
			paceMinSecondsPerKm: null,
			paceMaxSecondsPerKm: null,
			hrZone: null,
			targetRpe: 5
		}
	]
});

const thai = (date: string): OtherSessionPlan => ({
	...base,
	kind: 'other',
	type: 'muay_thai',
	discipline: 'muay_thai',
	date,
	title: 'Muay Thai class',
	estMinutes: 60,
	estLoad: 420,
	targetRpe: 7,
	details: { kind: 'class', durationMinutes: 60, targetRpe: 7, metrics: [], notes: null }
});

/** A week of Lower A Tue, Muay Thai Wed and a long run Sun. */
const sessionsOf = (monday: string): SessionPlan[] => [
	lift(addDays(monday, 1), 'Lower A'),
	thai(addDays(monday, 2)),
	longRun(addDays(monday, 6), 22000)
];

const week = (
	monday: string,
	kind: WeekKind = 'build',
	sessions = sessionsOf(monday)
): WeekPlan => ({
	kind,
	startsOn: monday,
	endsOn: addDays(monday, 6),
	targets: { rpeCap: 9, volumeFactor: 1, loadStep: 0.025, runVolumeFactor: 1 },
	sessions
});

const block = (phase: Phase, name: string, weeks: WeekPlan[]): BlockPlan => ({
	phase,
	name,
	startsOn: weeks[0]!.startsOn,
	endsOn: weeks.at(-1)!.endsOn,
	outline: false,
	goalRefs: [],
	progression: {},
	weeks
});

const plan = (blocks: BlockPlan[]): ProgramPlan => ({
	title: 'Hybrid',
	startsOn: W1,
	firstPlannedDay: W1,
	blocks,
	decisions: []
});

const BEFORE = plan([
	block(
		'marathon_build',
		'Marathon build',
		[W1, W2, W3, W4].map((m) => week(m))
	)
]);

/** BEFORE with week `monday`'s sessions replaced by `edit`'s result. */
function editWeek(
	monday: string,
	edit: (sessions: SessionPlan[]) => SessionPlan[],
	from = BEFORE
): ProgramPlan {
	const copy = structuredClone(from);
	const target = copy.blocks[0]!.weeks.find((w) => w.startsOn === monday)!;
	target.sessions = edit(target.sessions);
	return copy;
}

const lines = (p: ProgramPlan, options = KM_KG) =>
	describeChanges(BEFORE, p, options).weeks.flatMap((w) => w.rows.map((r) => r.line));

describe('describeChanges', () => {
	it('gives an added, a removed and a moved session one row each', () => {
		const added = editWeek(W2, (s) => [...s, lift(addDays(W2, 3), 'Upper A', 60, 'bench_press')]);
		expect(lines(added)).toEqual(['Week of 16 Nov · Upper A added on Thu']);

		const removed = editWeek(W2, (s) => s.filter((x) => x.title !== 'Muay Thai class'));
		expect(lines(removed)).toEqual(['Week of 16 Nov · Muay Thai class removed from Wed']);

		const moved = editWeek(W2, (s) =>
			s.map((x) => (x.title === 'Lower A' ? { ...x, date: addDays(W2, 4) } : x))
		);
		const changes = describeChanges(BEFORE, moved, KM_KG);
		expect(changes.weeks).toHaveLength(1);
		expect(changes.weeks[0]!.rows).toEqual([
			{
				kind: 'moved',
				label: 'Lower A',
				before: 'Tue',
				after: 'Fri',
				date: '2026-11-20',
				line: 'Week of 16 Nov · Lower A Tue → Fri'
			}
		]);
		// A move changes no number.
		expect(changes.impact).toEqual([]);
	});

	it('names the time of day when a session moves within its day', () => {
		const moved = editWeek(W2, (s) =>
			s.map((x) => (x.title === 'Lower A' ? { ...x, timeOfDay: 'evening' as const } : x))
		);
		expect(lines(moved)).toEqual(['Week of 16 Nov · Lower A Tue → Tue evening']);
	});

	it('gives a phase change one block row, in the first week it applies to', () => {
		const after = plan([
			block('marathon_build', 'Marathon build', [week(W1), week(W2)]),
			block('marathon_peak', 'Marathon peak', [week(W3, 'peak'), week(W4, 'peak')])
		]);
		const changes = describeChanges(BEFORE, after, KM_KG);
		expect(changes.weeks.map((w) => w.rows.map((r) => r.line))).toEqual([
			[
				'Week of 23 Nov · Block Marathon build → Marathon peak',
				'Week of 23 Nov · Week Build → Peak'
			],
			['Week of 30 Nov · Week Build → Peak']
		]);
		expect(changes.weeks[0]!.rows[0]).toMatchObject({ kind: 'block', date: null });
		expect(changes.summaryLines[0]).toBe('From Mon 16 Nov, 2 weeks change: 1 block change');
		expect(changes.summaryLines[1]).toBe(changes.weeks[0]!.rows[0]!.line);
	});

	it('says the long run, loads and the impact in kg and km, or lb and mi, with the same rows', () => {
		const after = editWeek(W3, (s) =>
			s.map((x) =>
				x.kind === 'run'
					? longRun(x.date, 18000)
					: x.title === 'Lower A'
						? lift(x.date, 'Lower A', 105)
						: x
			)
		);
		const metric = describeChanges(BEFORE, after, KM_KG);
		const imperial = describeChanges(BEFORE, after, MI_LB);
		expect(metric.weeks[0]!.rows.map((r) => r.line)).toEqual([
			'Week of 23 Nov · Lower A, Back squat 3 × 5 @ RPE 8, 100 kg → 3 × 5 @ RPE 8, 105 kg',
			'Week of 23 Nov · Long run 22 → 18 km'
		]);
		expect(imperial.weeks[0]!.rows.map((r) => r.line)).toEqual([
			'Week of 23 Nov · Lower A, Back squat 3 × 5 @ RPE 8, 220 lb → 3 × 5 @ RPE 8, 230 lb',
			'Week of 23 Nov · Long run 13.67 → 11.18 mi'
		]);
		// The same rows, kind for kind, only the units differ.
		const shape = (c: typeof metric) => c.weeks.map((w) => w.rows.map((r) => [r.kind, r.date]));
		expect(shape(imperial)).toEqual(shape(metric));
		expect(metric.impact).toEqual(imperial.impact);
		expect(metric.impact[0]).toMatchObject({ weekStart: W3, minutes: -20, runMetres: -4000 });
		expect(metric.summaryLines.at(-1)).toBe('In all: −20 min, running −4 km');
		expect(imperial.summaryLines.at(-1)).toBe('In all: −20 min, running −2.49 mi');
	});

	it('names a relative load change when the set has no computed load', () => {
		const relative = (loadValue: number) =>
			editWeek(W2, (s) =>
				s.map((x) =>
					x.kind === 'strength'
						? {
								...x,
								exercises: x.exercises.map((e) => ({
									...e,
									sets: [set({ loadKind: 'from_e1rm', loadValue, loadUnit: null })]
								}))
							}
						: x
				)
			);
		const changes = describeChanges(relative(0.7), relative(0.8), KM_KG);
		expect(changes.weeks.flatMap((w) => w.rows.map((r) => r.line))).toEqual([
			'Week of 16 Nov · Lower A, Back squat 3 × 5 @ RPE 8, 70 % of your week-1 estimate → 3 × 5 @ RPE 8, 80 % of your week-1 estimate'
		]);
	});

	it('names a Muay Thai format change and a rounds change at the same duration and RPE', () => {
		const details = (edit: Partial<OtherSessionPlan['details']>) =>
			editWeek(W2, (s) =>
				s.map((x) => (x.kind === 'other' ? { ...x, details: { ...x.details, ...edit } } : x))
			);
		expect(lines(details({ kind: 'technical' }))).toEqual([
			'Week of 16 Nov · Muay Thai class Class 60 min @ RPE 7 → Technical 60 min @ RPE 7'
		]);
		const rounds = (value: number) => ({ key: 'rounds', label: 'Rounds', unit: null, value });
		expect(
			describeChanges(
				details({ kind: 'sparring', metrics: [rounds(5)] }),
				details({ kind: 'sparring', metrics: [rounds(3)] }),
				KM_KG
			).weeks.flatMap((w) => w.rows.map((r) => r.line))
		).toEqual([
			'Week of 16 Nov · Muay Thai class Sparring 60 min @ RPE 7, Rounds 5 → Sparring 60 min @ RPE 7, Rounds 3'
		]);
	});

	it('counts the hard sets an added strength session brings, per muscle group', () => {
		const added = editWeek(W2, (s) => [...s, lift(addDays(W2, 3), 'Upper A', 60, 'bench_press')]);
		const changes = describeChanges(BEFORE, added, KM_KG);
		expect(changes.impact).toEqual([
			{ weekStart: W2, hardSets: { chest: 3 }, minutes: 45, load: 360, runMetres: 0 }
		]);
		expect(changes.summaryLines).toEqual([
			'From Mon 16 Nov, 1 week changes: 1 session added',
			'Week of 16 Nov · Upper A added on Thu',
			'In all: Chest +3 hard sets, +45 min'
		]);
		expect(changes.summaryLines.length).toBeLessThanOrEqual(SUMMARY_LINES_MAX);
	});

	it('never shows a week before from, and gives the same answer every time', () => {
		const after = editWeek(W1, () => []);
		expect(describeChanges(BEFORE, after, KM_KG).weeks).toEqual([]);
		// A session before from in from's own week is left out too.
		const midWeek = { ...KM_KG, from: addDays(W2, 3) };
		const early = editWeek(W2, (s) => s.filter((x) => x.title !== 'Lower A'));
		expect(describeChanges(BEFORE, early, midWeek).weeks).toEqual([]);

		const both = editWeek(
			W1,
			() => [],
			editWeek(W4, (s) => s.slice(1))
		);
		const once = describeChanges(BEFORE, both, KM_KG);
		expect(once.weeks.map((w) => w.weekStart)).toEqual([W4]);
		expect(JSON.stringify(describeChanges(structuredClone(BEFORE), both, KM_KG))).toBe(
			JSON.stringify(once)
		);
	});

	it('says nothing changes for identical plans', () => {
		const changes = describeChanges(BEFORE, structuredClone(BEFORE), KM_KG);
		expect(changes).toEqual({
			weeks: [],
			impact: [],
			summaryLines: ['Nothing changes from Mon 16 Nov']
		});
		expect(noChange(BEFORE, structuredClone(BEFORE), W2)).toBe(true);
	});
});

describe('noChange', () => {
	it('sees a load change from from on, and ignores one before it', () => {
		const heavier = (monday: string) =>
			editWeek(monday, (s) =>
				s.map((x) => (x.title === 'Lower A' ? lift(x.date, 'Lower A', 105) : x))
			);
		expect(noChange(BEFORE, heavier(W3), W2)).toBe(false);
		expect(noChange(BEFORE, heavier(W1), W2)).toBe(true);
	});
});

describe('shapeDigest and weekShapes', () => {
	const heavier = editWeek(W3, (s) =>
		s.map((x) =>
			x.title === 'Lower A'
				? lift(x.date, 'Lower A', 140)
				: x.kind === 'run'
					? longRun(x.date, 30000)
					: x
		)
	);
	const moved = editWeek(W3, (s) =>
		s.map((x) => (x.title === 'Lower A' ? { ...x, date: addDays(W3, 3) } : x))
	);

	it('ignores load changes and changes with a moved day', () => {
		expect(shapeDigest(BEFORE, W2)).toMatch(/^[0-9a-f]{16}$/);
		expect(shapeDigest(heavier, W2)).toBe(shapeDigest(BEFORE, W2));
		expect(shapeDigest(moved, W2)).not.toBe(shapeDigest(BEFORE, W2));
		// A changed week kind or phase changes the shape too.
		const deload = structuredClone(BEFORE);
		deload.blocks[0]!.weeks[2]!.kind = 'deload';
		expect(shapeDigest(deload, W2)).not.toBe(shapeDigest(BEFORE, W2));
		const peak = structuredClone(BEFORE);
		peak.blocks[0]!.phase = 'marathon_peak';
		expect(shapeDigest(peak, W2)).not.toBe(shapeDigest(BEFORE, W2));
	});

	it('ignores a change before from', () => {
		const early = editWeek(W1, (s) => s.slice(1));
		expect(shapeDigest(early, W2)).toBe(shapeDigest(BEFORE, W2));
		// From a Thursday, that week's Tuesday session is already past.
		const thursday = addDays(W2, 3);
		const past = editWeek(W2, (s) => s.filter((x) => x.title !== 'Lower A'));
		expect(shapeDigest(past, thursday)).toBe(shapeDigest(BEFORE, thursday));
		expect(weekShapes(past, thursday)).toEqual(weekShapes(BEFORE, thursday));
		expect(noChange(BEFORE, past, thursday)).toBe(true);
		expect(noChange(BEFORE, past, W2)).toBe(false);
		expect(Object.keys(weekShapes(BEFORE, W2))).toEqual([W2, W3, W4]);
	});

	it('differs only in the week that changed', () => {
		const a = weekShapes(BEFORE, W2);
		const b = weekShapes(moved, W2);
		expect(Object.keys(b)).toEqual(Object.keys(a));
		expect(Object.keys(a).filter((m) => a[m] !== b[m])).toEqual([W3]);
		expect(weekShapes(heavier, W2)).toEqual(a);
	});
});
