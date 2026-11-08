import { describe, expect, it } from 'vitest';
import { addDays } from '../../calendar';
import type { IsoDate } from '../../calendar';
import type { RunFact } from '../../analytics/running';
import type { StrengthFact } from '../../analytics/strength';
import type { RecoveryEntry } from '../../analytics/workload';
import { catalogueByKey } from '../../exercises/index';
import type { SetPrescription } from '../../training/types';
import type { OtherSessionKind, SessionType } from '../../training/vocabulary';
import { demandOf, INTERFERENCE_RULES } from '../interference';
import { SUMMARY_MAX } from './brief';
import type { Finding } from './brief';
import { readSnapshot, SNAPSHOT_VERSION, weeklyReviewSnapshotSchema } from './snapshot';
import { composeWeeklyReview, performedSessions, scaledTargets, TRAILING_WEEKS } from './weekly';
import type {
	PrescribedExercise,
	ReviewExercise,
	ReviewPlannedSession,
	ReviewWorkout,
	WeeklyReviewInput
} from './weekly';

/** The reviewed week: Monday 2 Nov to Sunday 8 Nov 2026, in Los Angeles. */
const MONDAY = '2026-11-02';
const day = (n: number) => addDays(MONDAY, n);
const TZ = 'America/Los_Angeles';
/** 10:00 in Los Angeles, plus `minutes`: the same calendar day there. */
const at = (date: IsoDate, minutes = 0) =>
	new Date(new Date(`${date}T18:00:00Z`).getTime() + minutes * 60_000);

const exercise = (key: string): ReviewExercise => {
	const entry = catalogueByKey.get(key)!;
	return { ...entry, name: entry.name };
};
const EXERCISES = new Map([
	['back_squat', exercise('back_squat')],
	['bench_press', exercise('bench_press')]
]);

const line = (sets: number, targetRpe: number): SetPrescription => ({
	role: 'working',
	sets,
	repsMin: 5,
	repsMax: 5,
	seconds: null,
	metres: null,
	targetRpe,
	loadKind: 'rpe_based',
	loadValue: null,
	loadUnit: null,
	loadBasis: null,
	reference1rm: null,
	reference1rmUnit: null,
	restSeconds: null,
	tempo: null,
	notes: null
});

interface Week {
	workouts: ReviewWorkout[];
	sets: StrengthFact[];
	runs: RunFact[];
	prescriptions: PrescribedExercise[];
	planned: ReviewPlannedSession[];
}

const empty = (): Week => ({ workouts: [], sets: [], runs: [], prescriptions: [], planned: [] });

function workout(
	w: Week,
	id: string,
	date: IsoDate,
	type: SessionType,
	more: Partial<ReviewWorkout> = {}
): ReviewWorkout {
	const row: ReviewWorkout = {
		id,
		title: id,
		sessionType: type,
		startedAt: at(date),
		durationSeconds: 3600,
		sessionRpe: 7,
		run: null,
		other: null,
		discipline: 'strength',
		plannedLineage: null,
		...more
	};
	w.workouts.push(row);
	return row;
}

/** A planned session on `date`, completed by a workout of the same id unless told otherwise. */
function plan(
	w: Week,
	id: string,
	date: IsoDate,
	type: SessionType,
	more: Partial<ReviewPlannedSession> = {}
) {
	w.planned.push({
		lineage: `lineage-${id}`,
		date,
		status: 'planned',
		movedFrom: null,
		discipline: 'strength',
		title: id,
		type,
		source: 'generator',
		plannedMetres: null,
		...more
	});
}

/** A strength workout of `exercise`: `sets` working sets of 5 at `kg` and `rpe`, planned at RPE `target`. */
function lift(
	w: Week,
	id: string,
	date: IsoDate,
	exerciseId: string,
	{ sets = 3, kg = 100, rpe = 8, target = 8 as number | null } = {}
) {
	const lineage = `lineage-${id}`;
	const pl = `${lineage}:${exerciseId}`;
	if (!w.workouts.some((o) => o.id === id))
		workout(w, id, date, 'strength', { plannedLineage: lineage });
	for (let i = 1; i <= sets; i += 1) {
		w.sets.push({
			id: `${id}:${exerciseId}:${i}`,
			workoutId: id,
			exercise: exerciseId,
			plannedLineage: target === null ? null : pl,
			setIndex: i,
			weight: kg,
			unit: 'kg',
			reps: 5,
			rpe,
			seconds: null,
			metres: null,
			assistance: null,
			missedReps: 0,
			isWarmup: false,
			isSkipped: false,
			isExtra: false,
			performedAt: at(date, i),
			deletedAt: null
		});
	}
	if (target !== null)
		w.prescriptions.push({
			lineage: pl,
			exerciseId,
			lines: [line(sets, target)],
			workoutId: id,
			day: date
		});
}

function run(w: Week, id: string, date: IsoDate, type: SessionType, km: number, minutes: number) {
	workout(w, id, date, type, {
		plannedLineage: `lineage-${id}`,
		discipline: 'running',
		sessionRpe: null,
		durationSeconds: minutes * 60,
		run: { durationSeconds: minutes * 60, rpe: 6 }
	});
	w.runs.push({
		workout: id,
		startedAt: at(date),
		sessionType: type,
		metres: km * 1000,
		seconds: minutes * 60,
		avgHr: null,
		rpe: 6,
		segments: []
	});
}

function thai(w: Week, id: string, date: IsoDate, kind: OtherSessionKind, rpe = 8) {
	workout(w, id, date, 'muay_thai', {
		plannedLineage: `lineage-${id}`,
		discipline: 'muay_thai',
		sessionRpe: rpe,
		other: {
			kind,
			durationMinutes: 60,
			rpe,
			metrics: [{ key: 'rounds', label: 'Rounds', unit: null, value: 6 }]
		}
	});
}

/** The usual week: squat and bench Monday and Friday, an easy run Wednesday, pads Saturday. */
function usualWeek(w: Week, monday: IsoDate, prefix: string) {
	lift(w, `${prefix}-mon`, monday, 'back_squat');
	lift(w, `${prefix}-mon`, monday, 'bench_press');
	run(w, `${prefix}-wed`, addDays(monday, 2), 'easy_run', 5, 30);
	lift(w, `${prefix}-fri`, addDays(monday, 4), 'back_squat');
	thai(w, `${prefix}-sat`, addDays(monday, 5), 'pad_work', 6);
}

/** The reviewed week planned and done as usual, with the eight weeks before it logged too. */
function history(): Week {
	const w = empty();
	for (let n = TRAILING_WEEKS; n >= 1; n -= 1) usualWeek(w, day(-7 * n), `w${n}`);
	usualWeek(w, MONDAY, 'this');
	plan(w, 'this-mon', MONDAY, 'strength');
	plan(w, 'this-wed', day(2), 'easy_run', { discipline: 'running', plannedMetres: 5000 });
	plan(w, 'this-fri', day(4), 'strength');
	plan(w, 'this-sat', day(5), 'muay_thai', { discipline: 'muay_thai' });
	return w;
}

function input(w: Week, more: Partial<WeeklyReviewInput> = {}): WeeklyReviewInput {
	return {
		weekStartsOn: MONDAY,
		today: day(8),
		timeZone: TZ,
		unit: 'kg',
		distanceUnit: 'km',
		week: { kind: 'accumulation', sessions: w.planned },
		next: { state: 'planned', kind: 'accumulation' },
		completedLineages: new Set(w.workouts.flatMap((o) => o.plannedLineage ?? [])),
		workouts: w.workouts,
		sets: w.sets,
		runs: w.runs,
		recovery: [],
		prescriptions: w.prescriptions,
		exercises: EXERCISES,
		targets: {
			band: { chest: [10, 20], quads: [10, 20] },
			volumeFactor: 1,
			planned: { chest: 6, quads: 12 },
			label: 'From your program'
		},
		digest: {
			facts: w.sets.map((s) => ({ kind: 'set', id: s.id, updatedAt: s.performedAt })),
			workouts: w.workouts.map((o) => ({ id: o.id, status: 'completed' }))
		},
		...more
	};
}

const find = (findings: Finding[], id: string) => findings.find((f) => f.id === id);
const ids = (findings: Finding[]) => findings.map((f) => f.id);

describe('composeWeeklyReview', () => {
	it('reviews a week with everything done', () => {
		const review = composeWeeklyReview(input(history()));
		expect(review.snapshot.adherence).toEqual({
			planned: 4,
			completed: 4,
			skipped: 0,
			missed: 0,
			pct: 100
		});
		const adherence = find(review.findings, 'adherence')!;
		expect(adherence.verdict).toEqual({ level: 'good', words: '4 of 4 sessions done · On plan' });
		expect(review.summary).toBe('4 of 4 sessions done.');
		expect(review.snapshot.noProposal).toBeNull();
		expect(ids(review.findings)).toEqual(
			expect.arrayContaining([
				'verdicts:e1rm:back_squat',
				'verdicts:tonnage',
				'verdicts:mileage',
				'rpe:average',
				'volume:tonnage',
				'volume:intensity',
				'volume:sets:quads',
				'running:mileage',
				'running:pace:easy_run',
				'muay_thai:load',
				'fatigue',
				'next'
			])
		);
		expect(find(review.findings, 'muay_thai:load')!.figures.map((f) => f.words)).toEqual([
			'1 session',
			'360 AU',
			'6 rounds'
		]);
		expect(find(review.findings, 'running:mileage')!.verdict).toEqual({
			level: 'good',
			words: '5 km of 5 km planned'
		});
		// The same load every week: steady, never a trend.
		expect(find(review.findings, 'verdicts:tonnage')!.verdict.level).toBe('neutral');
		expect(find(review.findings, 'verdicts:tonnage')!.window!.label).toBe(
			'Trend over the last 9 weeks'
		);
	});

	it('counts one skipped and one missed session', () => {
		const w = history();
		w.workouts = w.workouts.filter((o) => o.id !== 'this-wed' && o.id !== 'this-sat');
		w.runs = w.runs.filter((r) => r.workout !== 'this-wed');
		w.planned = w.planned.map((s) =>
			s.lineage === 'lineage-this-wed' ? { ...s, status: 'skipped' } : s
		);
		const review = composeWeeklyReview(input(w));
		expect(review.snapshot.adherence).toEqual({
			planned: 4,
			completed: 2,
			skipped: 1,
			missed: 1,
			pct: 50
		});
		expect(find(review.findings, 'adherence')!.verdict.level).toBe('low');
		expect(review.summary).toBe('2 of 4 sessions done.');
		expect(find(review.findings, 'running:mileage')!.verdict).toEqual({
			level: 'watch',
			words: '0 km of 5 km planned'
		});
	});

	it('finds bench pressed below its target RPE twice', () => {
		const w = history();
		const easy = { kg: 100, rpe: 6.5, target: 8 };
		w.sets = w.sets.filter((s) => !(s.exercise === 'bench_press' && s.workoutId.startsWith('w1-')));
		w.sets = w.sets.filter((s) => !(s.exercise === 'bench_press' && s.workoutId === 'this-mon'));
		w.prescriptions = w.prescriptions.filter(
			(p) => !(p.exerciseId === 'bench_press' && ['w1-mon', 'this-mon'].includes(p.workoutId))
		);
		lift(w, 'w1-mon', day(-7), 'bench_press', easy);
		lift(w, 'this-mon', MONDAY, 'bench_press', easy);
		const review = composeWeeklyReview(input(w));
		const bench = find(review.findings, 'rpe:bench_press')!;
		expect(bench.verdict).toEqual({
			level: 'watch',
			words: 'Felt about an RPE or more easier than prescribed in 2 of the last 3 sessions'
		});
		expect(bench.figures[0]!.value).toBe(-1.5);
		expect(bench.sources.map((s) => s.id)).toEqual(['this-mon', 'w1-mon', 'w2-mon']);
		// The squat, on target every session, is not flagged.
		expect(find(review.findings, 'rpe:back_squat')!.verdict.level).toBe('good');
		// next week's rules read the same exposures, by day
		const benches = review.exposures.filter((e) => e.exerciseId === 'bench_press');
		expect(benches).toHaveLength(TRAILING_WEEKS + 1);
		expect(benches.at(-1)).toMatchObject({ day: MONDAY, meanRpeDeviation: -1.5 });
	});

	it('flags hard sparring the day before the long run, with its why', () => {
		const w = history();
		w.workouts = w.workouts.filter((o) => o.id !== 'this-sat');
		thai(w, 'this-sat', day(5), 'sparring');
		run(w, 'this-sun', day(6), 'long_run', 16, 100);
		const review = composeWeeklyReview(input(w));
		const conflicts = review.findings.filter((f) => f.section === 'conflicts');
		const sparring = conflicts.find((f) => f.sources.some((s) => s.id === 'this-sun'))!;
		expect(sparring).toMatchObject({
			label: INTERFERENCE_RULES.hard_days_apart.headline,
			window: { from: day(5), to: day(6), label: '2 days' },
			sources: [
				{ type: 'workout', id: 'this-sat', label: 'this-sat', date: day(5) },
				{ type: 'workout', id: 'this-sun', label: 'this-sun', date: day(6) }
			]
		});
		expect(sparring.verdict).toEqual({
			level: 'watch',
			words: `this-sat on Saturday, then this-sun on Sunday. ${INTERFERENCE_RULES.hard_days_apart.why}`
		});
		expect(review.summary).toContain(`${conflicts.length} conflicts`);
		// The usual week, pads at RPE 6 and no long run, has no conflict.
		const usual = composeWeeklyReview(input(history()));
		expect(usual.findings.filter((f) => f.section === 'conflicts')).toEqual([]);
	});

	it('reads poor recovery and a sharp rise in load as fatigue to watch', () => {
		const w = empty();
		// Four light weeks, then a heavy one: the acute:chronic ratio rises sharply.
		for (let n = 4; n >= 1; n -= 1)
			for (const offset of [0, 3])
				workout(w, `light-${n}-${offset}`, day(-7 * n + offset), 'conditioning', {
					discipline: 'athletic',
					durationSeconds: 1800,
					sessionRpe: 4
				});
		for (const offset of [3, 4, 5, 6])
			workout(w, `heavy-${offset}`, day(offset), 'conditioning', {
				discipline: 'athletic',
				durationSeconds: 5400,
				sessionRpe: 8
			});
		const note = (n: number, more: Partial<RecoveryEntry>): RecoveryEntry => ({
			id: `note-${n}`,
			notedOn: day(n),
			sleepHours: 7.5,
			soreness: 2,
			energy: 2,
			stress: 4,
			note: null,
			...more
		});
		const poor = [note(1, {}), note(4, {})];
		const review = composeWeeklyReview(input(w, { recovery: poor }));
		expect(review.snapshot.fatigue.level).toBe('watch');
		expect(review.snapshot.fatigue.reasons).toHaveLength(1);
		expect(review.snapshot.fatigue.reasons[0]).toMatch(/^Your load is rising sharply/);
		expect(find(review.findings, 'fatigue:acwr')!.verdict.words).toContain(
			'not an injury predictor'
		);
		expect(find(review.findings, 'recovery:energy')!.verdict.level).toBe('low');
		expect(find(review.findings, 'recovery:stress')!.verdict.level).toBe('low');
		expect(review.summary).toContain('Fatigue: watch');
		// Soreness as well is a second signal: high, with a deload to consider.
		const sore = composeWeeklyReview(
			input(w, { recovery: [note(1, { soreness: 4 }), note(4, { soreness: 4 })] })
		);
		expect(sore.snapshot.fatigue.level).toBe('high');
		expect(find(sore.findings, 'fatigue')!.verdict.words).toMatch(/A deload is worth considering$/);
	});

	it('says so when nothing was logged', () => {
		const w = history();
		w.workouts = w.workouts.filter((o) => !o.id.startsWith('this-'));
		w.sets = w.sets.filter((s) => !s.workoutId.startsWith('this-'));
		w.runs = w.runs.filter((r) => !r.workout.startsWith('this-'));
		w.prescriptions = w.prescriptions.filter((p) => !p.workoutId.startsWith('this-'));
		const review = composeWeeklyReview(input(w, { completedLineages: new Set() }));
		expect(review.snapshot.adherence).toMatchObject({ completed: 0, missed: 4, pct: 0 });
		expect(find(review.findings, 'adherence')!.verdict).toEqual({
			level: 'low',
			words: 'Nothing logged this week: 0 of 4 sessions done'
		});
		expect(review.summary).toBe('Nothing logged this week: 0 of 4 sessions done.');
		expect(ids(review.findings).filter((id) => id.startsWith('rpe:'))).toEqual([]);
	});

	it('establishes a baseline in a baseline week, with no verdicts', () => {
		const w = history();
		const review = composeWeeklyReview(
			input(w, { week: { kind: 'baseline', sessions: w.planned } })
		);
		const verdicts = review.findings.filter((f) => f.section === 'verdicts');
		expect(verdicts.map((f) => [f.id, f.label])).toEqual([
			['verdicts:baseline', 'Baseline established']
		]);
		expect(review.summary).toBe('4 of 4 sessions done. Baseline established.');
	});

	it('flags the block boundary when next week is in the outline', () => {
		const review = composeWeeklyReview(
			input(history(), { next: { state: 'outline', kind: null } })
		);
		expect(review.snapshot.next).toEqual({ weekStartsOn: day(7), state: 'outline', kind: null });
		expect(review.snapshot.noProposal).toBe('boundary');
		expect(find(review.findings, 'next')!.verdict.words).toBe(
			'Next week starts the next block of your outline: your cycle review plans it'
		);
		expect(review.summary).toBe('4 of 4 sessions done. Next week: your cycle review.');
	});

	it('is late once next week has ended', () => {
		const review = composeWeeklyReview(input(history(), { today: day(14) }));
		expect(review.snapshot.noProposal).toBe('late');
		expect(
			composeWeeklyReview(input(history(), { today: day(13) })).snapshot.noProposal
		).toBeNull();
	});

	it("judges a deload week's hard sets against the range × 0.6", () => {
		expect(scaledTargets({ chest: [10, 20] }, 0.6)).toEqual({ chest: [6, 12] });
		const w = history();
		w.sets = w.sets.filter((s) => !(s.exercise === 'bench_press' && s.workoutId === 'this-mon'));
		w.prescriptions = w.prescriptions.filter(
			(p) => !(p.exerciseId === 'bench_press' && p.workoutId === 'this-mon')
		);
		lift(w, 'this-mon', MONDAY, 'bench_press', { sets: 13 });
		const deload = (volumeFactor: number) =>
			find(
				composeWeeklyReview(
					input(w, {
						week: { kind: 'deload', sessions: w.planned },
						targets: { band: { chest: [10, 20] }, volumeFactor, planned: { chest: 6 }, label: '' }
					})
				).findings,
				'volume:sets:chest'
			)!;
		expect(deload(0.6)).toMatchObject({
			figures: [
				{ label: 'Done', value: 13 },
				{ label: 'Planned', value: 6 }
			],
			verdict: { level: 'watch', words: 'Above the target range: 6–12 (10–20 × 0.6)' }
		});
		// The same 13 sets in a normal week are within 10–20.
		expect(deload(1).verdict).toEqual({ level: 'good', words: 'Within the target range: 10–20' });
	});

	it('shows a planned group with nothing done and no stored band', () => {
		const w = history();
		w.sets = w.sets.filter((s) => !(s.exercise === 'bench_press' && s.workoutId === 'this-mon'));
		const targets = { band: null, volumeFactor: 1, planned: { chest: 6 }, label: 'From your plan' };
		const chest = find(composeWeeklyReview(input(w, { targets })).findings, 'volume:sets:chest');
		expect(chest).toMatchObject({
			figures: [
				{ label: 'Done', value: 0 },
				{ label: 'Planned', value: 6 }
			],
			verdict: { level: 'neutral', words: 'From your plan' }
		});
	});

	it('keeps a personal best set before the weeks read', () => {
		const w = history();
		w.sets = w.sets.filter((s) => !(s.exercise === 'bench_press' && s.workoutId === 'this-mon'));
		lift(w, 'this-mon', MONDAY, 'bench_press', { kg: 110 });
		const prs = (week: Week) =>
			ids(composeWeeklyReview(input(week)).findings).filter((id) => id.startsWith('prs:'));
		expect(prs(w).length).toBeGreaterThan(0);
		lift(w, 'old', day(-7 * (TRAILING_WEEKS + 2)), 'bench_press', { kg: 120 });
		expect(prs(w)).toEqual([]);
	});

	it("words a weight PR in the profile's units", () => {
		const w = history();
		w.sets = w.sets.filter((s) => !(s.exercise === 'bench_press' && s.workoutId === 'this-mon'));
		lift(w, 'this-mon', MONDAY, 'bench_press', { kg: 110 });
		const format = (metric: { unit: string }, value: number) => `${value} as ${metric.unit} in lb`;
		const prs = composeWeeklyReview(input(w, { format })).findings.filter(
			(f) => f.section === 'prs'
		);
		const weights = prs.flatMap((f) => f.figures).filter((f) => f.unit === 'kg');
		expect(weights.length).toBeGreaterThan(0);
		for (const f of weights) expect(f.words).toMatch(/^[\d.]+ as kg in lb$/);
	});

	it('gives a short summary, byte-identical for the same input in any order', () => {
		const w = history();
		thai(w, 'this-sat-2', day(5), 'sparring');
		run(w, 'this-sun', day(6), 'long_run', 16, 100);
		const once = composeWeeklyReview(input(w));
		const again = composeWeeklyReview(input(w));
		expect(JSON.stringify(again)).toBe(JSON.stringify(once));
		const reversed: Week = {
			workouts: [...w.workouts].reverse(),
			sets: [...w.sets].reverse(),
			runs: [...w.runs].reverse(),
			prescriptions: [...w.prescriptions].reverse(),
			planned: w.planned
		};
		expect(JSON.stringify(composeWeeklyReview(input(reversed)).snapshot)).toBe(
			JSON.stringify(once.snapshot)
		);
		expect(once.summary.length).toBeLessThanOrEqual(SUMMARY_MAX);
		expect(once.snapshot.brief.summary).toBe(once.summary);
		// A title the owner typed never pushes a finding past the brief's limits.
		const long = history();
		long.workouts = long.workouts.map((o) => ({ ...o, title: 'x'.repeat(500) }));
		const checked = weeklyReviewSnapshotSchema.safeParse(composeWeeklyReview(input(long)).snapshot);
		expect(checked.success).toBe(true);
	});

	it('produces a snapshot its schema accepts, for every week above', () => {
		const weeks = [
			input(history()),
			input(empty(), {
				week: { kind: null, sessions: [] },
				next: { state: 'unplanned', kind: null }
			}),
			input(history(), { week: { kind: 'baseline', sessions: history().planned } })
		];
		for (const week of weeks) {
			const { snapshot, summary, inputsDigest } = composeWeeklyReview(week);
			const read = readSnapshot({ snapshotVersion: SNAPSHOT_VERSION, snapshot, summary });
			expect(read).toEqual({ legacy: false, version: SNAPSHOT_VERSION, summary, snapshot });
			expect(snapshot.inputsDigest).toBe(inputsDigest);
		}
		const none = composeWeeklyReview(weeks[1]!);
		expect(none.snapshot.noProposal).toBe('no_program');
		expect(none.summary).toBe('Nothing planned or logged this week.');
	});
});

describe('performedSessions', () => {
	it('reads a performed week as the interference rules read a plan', () => {
		const w = empty();
		lift(w, 'squat', MONDAY, 'back_squat', { rpe: 8.5 });
		thai(w, 'spar', MONDAY, 'sparring', 9);
		w.workouts[1]!.startedAt = at(MONDAY, 120);
		run(w, 'long', day(1), 'long_run', 16, 100);
		plan(w, 'squat', MONDAY, 'strength', { source: 'commitment' });
		const dated = w.workouts.map((o) => ({ ...o, date: o.startedAt.toISOString().slice(0, 10) }));
		const [squat, spar, long] = performedSessions(dated, w.sets, w.runs, w.planned);
		expect(squat).toMatchObject({
			id: 'squat',
			kind: 'strength',
			date: MONDAY,
			orderInDay: 1,
			intensity: 'hard',
			source: 'commitment',
			estMinutes: 60
		});
		expect(spar).toMatchObject({
			kind: 'other',
			details: { kind: 'sparring' },
			orderInDay: 2,
			intensity: 'very_hard',
			source: 'generator'
		});
		expect(long).toMatchObject({ kind: 'run', type: 'long_run', estMinutes: 100, segments: [] });
		// Squats at RPE 8.5 are heavy lower body; sparring is hard combat; 100 minutes is a long run.
		expect(demandOf(squat!).heavyLower).toBe(true);
		expect(demandOf(spar!).hardCombat).toBe(true);
		expect(demandOf(long!).longRun).toBe(true);
	});
});
