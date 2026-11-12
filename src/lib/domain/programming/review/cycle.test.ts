import { describe, expect, it } from 'vitest';
import { addDays } from '../../calendar';
import type { IsoDate } from '../../calendar';
import type { RunFact } from '../../analytics/running';
import type { StrengthFact } from '../../analytics/strength';
import type { RecoveryEntry } from '../../analytics/workload';
import { catalogueByKey } from '../../exercises/index';
import { hardSets, plannedHardSets } from '../../training/metrics';
import type { SetPrescription, WeekPlan } from '../../training/types';
import type { SessionType, SetRole } from '../../training/vocabulary';
import { SUMMARY_MAX } from './brief';
import type { Finding } from './brief';
import { evaluateCycle, racePaceTarget, strengthTarget } from './cycle';
import type { CycleGoal, CycleReviewInput } from './cycle';
import {
	CYCLE_SNAPSHOT_VERSION,
	cycleReviewSnapshotSchema,
	readCycleSnapshot
} from './cycle-snapshot';
import type {
	PrescribedExercise,
	ReviewExercise,
	ReviewPlannedSession,
	ReviewWorkout
} from './weekly';

/** The block: four weeks from Monday 5 Oct to Sunday 1 Nov 2026, in Los Angeles. */
const MONDAY = '2026-10-05';
const WEEKS = 4;
const END = addDays(MONDAY, 7 * WEEKS - 1);
const TZ = 'America/Los_Angeles';
const weekOf = (n: number) => addDays(MONDAY, 7 * n);
/** 10:00 in Los Angeles, plus `minutes`: the same calendar day there. */
const at = (date: IsoDate, minutes = 0) =>
	new Date(new Date(`${date}T17:00:00Z`).getTime() + minutes * 60_000);

const exercise = (key: string): ReviewExercise => {
	const entry = catalogueByKey.get(key)!;
	return { ...entry, name: entry.name };
};
const EXERCISES = new Map(
	['back_squat', 'bench_press', 'barbell_row', 'overhead_press'].map((k) => [k, exercise(k)])
);

const line = (role: SetRole, sets: number, targetRpe = 8): SetPrescription => ({
	role,
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

interface Log {
	workouts: ReviewWorkout[];
	sets: StrengthFact[];
	runs: RunFact[];
	prescriptions: PrescribedExercise[];
	planned: ReviewPlannedSession[];
	recovery: RecoveryEntry[];
}

const empty = (): Log => ({
	workouts: [],
	sets: [],
	runs: [],
	prescriptions: [],
	planned: [],
	recovery: []
});

function plan(log: Log, id: string, date: IsoDate, type: SessionType, discipline = 'strength') {
	log.planned.push({
		lineage: `lineage-${id}`,
		date,
		status: 'planned',
		movedFrom: null,
		discipline: discipline as ReviewPlannedSession['discipline'],
		title: id,
		type,
		source: 'generator',
		plannedMetres: null
	});
}

/** A logged lift: `sets` working sets of 5 at `kg` and `rpe`, planned as a top set or as work. */
function lift(
	log: Log,
	id: string,
	date: IsoDate,
	exerciseId: string,
	{ kg = 100, rpe = 8, sets = 3, role = 'top' as SetRole } = {}
) {
	const lineage = `lineage-${id}`;
	if (!log.workouts.some((w) => w.id === id))
		log.workouts.push({
			id,
			title: id,
			sessionType: 'strength',
			startedAt: at(date),
			durationSeconds: 3600,
			sessionRpe: 7,
			run: null,
			other: null,
			discipline: 'strength',
			plannedLineage: lineage
		});
	const pl = `${lineage}:${exerciseId}`;
	for (let i = 1; i <= sets; i += 1)
		log.sets.push({
			id: `${id}:${exerciseId}:${i}`,
			workoutId: id,
			exercise: exerciseId,
			plannedLineage: pl,
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
	log.prescriptions.push({
		lineage: pl,
		exerciseId,
		lines: [line(role, sets)],
		workoutId: id,
		day: date
	});
}

function run(log: Log, id: string, date: IsoDate, km: number) {
	log.workouts.push({
		id,
		title: id,
		sessionType: 'easy_run',
		startedAt: at(date),
		durationSeconds: km * 330,
		sessionRpe: null,
		run: { durationSeconds: km * 330, rpe: 5 },
		other: null,
		discipline: 'running',
		plannedLineage: `lineage-${id}`
	});
	log.runs.push({
		workout: id,
		startedAt: at(date),
		sessionType: 'easy_run',
		metres: km * 1000,
		seconds: km * 330,
		avgHr: null,
		rpe: 5,
		segments: []
	});
}

interface Shape {
	/** The squat's and bench's load step per week, in kg. */
	mainStep?: number;
	/** The row's load step per week. */
	rowStep?: number;
	/** Weeks whose Friday session is planned but not done. */
	fridaysMissed?: number[];
	/** Only Mondays are logged: a third of the block. */
	mondaysOnly?: boolean;
}

/**
 * Each week: Monday squat and bench (main lifts) and a row (an accessory), an easy run on
 * Wednesday, Friday squat and row; all three sessions planned.
 */
function block({
	mainStep = 2.5,
	rowStep = 0,
	fridaysMissed = [],
	mondaysOnly = false
}: Shape = {}): Log {
	const log = empty();
	for (let n = 0; n < WEEKS; n += 1) {
		const mon = weekOf(n);
		plan(log, `w${n}-mon`, mon, 'strength');
		plan(log, `w${n}-wed`, addDays(mon, 2), 'easy_run', 'running');
		plan(log, `w${n}-fri`, addDays(mon, 4), 'strength');
		lift(log, `w${n}-mon`, mon, 'back_squat', { kg: 100 + mainStep * n });
		lift(log, `w${n}-mon`, mon, 'bench_press', { kg: 80 + mainStep * n });
		lift(log, `w${n}-mon`, mon, 'barbell_row', { kg: 60 + rowStep * n, role: 'working' });
		if (mondaysOnly) continue;
		run(log, `w${n}-wed`, addDays(mon, 2), 5 + n);
		if (fridaysMissed.includes(n)) continue;
		lift(log, `w${n}-fri`, addDays(mon, 4), 'back_squat', { kg: 100 + mainStep * n });
		lift(log, `w${n}-fri`, addDays(mon, 4), 'barbell_row', {
			kg: 60 + rowStep * n,
			role: 'working'
		});
	}
	return log;
}

const TARGETS = {
	band: { back: [10, 20], quads: [10, 20], chest: [10, 20] },
	volumeFactor: 1,
	planned: { back: 6, quads: 6, chest: 3 },
	label: 'From your program'
} as const;

function input(log: Log, more: Partial<CycleReviewInput> = {}): CycleReviewInput {
	return {
		block: {
			lineage: 'block-1',
			name: 'Block 1',
			phase: 'accumulation',
			weeks: Array.from({ length: WEEKS }, (_, n) => ({
				startsOn: weekOf(n),
				kind: 'accumulation' as const,
				targets: TARGETS
			}))
		},
		today: addDays(END, 1),
		timeZone: TZ,
		unit: 'kg',
		distanceUnit: 'km',
		sessions: log.planned,
		completedLineages: new Set(log.workouts.flatMap((w) => w.plannedLineage ?? [])),
		workouts: log.workouts,
		sets: log.sets,
		runs: log.runs,
		recovery: log.recovery,
		prescriptions: log.prescriptions,
		exercises: EXERCISES,
		goals: [],
		previous: null,
		next: {
			name: 'Block 2',
			phase: 'intensification',
			startsOn: addDays(END, 1),
			firstWeekKind: 'intensification'
		},
		digest: {
			facts: log.sets.map((s) => ({ kind: 'set', id: s.id, updatedAt: s.performedAt })),
			workouts: log.workouts.map((w) => ({ id: w.id, status: 'completed' }))
		},
		...more
	};
}

const find = (findings: Finding[], id: string) => findings.find((f) => f.id === id);
const goal = (more: Partial<CycleGoal>): CycleGoal => ({
	id: 'goal-1',
	title: 'Goal',
	disciplines: ['strength'],
	eventType: null,
	eventDate: null,
	targetPerformance: null,
	measure: null,
	...more
});

describe('evaluateCycle', () => {
	it('says every main lift progressed when each rose over the block', () => {
		const review = evaluateCycle(input(block()));
		const mains = review.effectiveness.filter((e) => e.main);
		expect(mains.map((e) => [e.exercise, e.verdict])).toEqual([
			['back_squat', 'progressed'],
			['bench_press', 'progressed']
		]);
		expect(find(review.findings, 'verdicts:strength')!.verdict).toEqual({
			level: 'good',
			words: '2 of 2 main lifts progressed'
		});
		expect(find(review.findings, 'verdicts:e1rm:back_squat')!.verdict.level).toBe('good');
		expect(review.summary).toBe(
			'Block 1: 12 of 12 sessions done. 2 of 2 main lifts progressed. No deload needed.'
		);
		expect(review.snapshot.adherence.verdictsWithheld).toBe(false);
	});

	it('marks an accessory stalled over 4 or more sessions as held, or regressed when it fell', () => {
		const held = evaluateCycle(input(block())).effectiveness.find(
			(e) => e.exercise === 'barbell_row'
		)!;
		expect(held).toMatchObject({ main: false, verdict: 'held', exposures: 8, stalled: true });
		const fell = evaluateCycle(input(block({ rowStep: -5 }))).effectiveness.find(
			(e) => e.exercise === 'barbell_row'
		)!;
		expect(fell).toMatchObject({ verdict: 'regressed', stalled: true });
		expect(fell.lastKg!).toBeLessThan(fell.firstKg!);
	});

	it('needs a deload when fatigue is high and lifts regressed', () => {
		const log = block({ mainStep: -5 });
		for (let d = 14; d < 28; d += 1)
			log.recovery.push({
				id: `note-${d}`,
				notedOn: addDays(MONDAY, d),
				sleepHours: 5.5,
				soreness: 5,
				energy: 2,
				stress: 4,
				note: null
			});
		const review = evaluateCycle(input(log));
		expect(review.fatigue.level).toBe('high');
		expect(review.effectiveness.find((e) => e.exercise === 'back_squat')!.verdict).toBe(
			'regressed'
		);
		expect(review.deloadNeed.verdict).toBe('needed');
		expect(review.deloadNeed.reasons).toContain('Back squat, Bench press regressed');
		expect(find(review.findings, 'fatigue:deload')!.verdict.level).toBe('low');
		// The same block, rested and progressing, needs none.
		expect(evaluateCycle(input(block())).deloadNeed).toEqual({
			verdict: 'not_needed',
			reasons: []
		});
	});

	it('flags a deload already planned to open the next block', () => {
		const review = evaluateCycle(
			input(block(), {
				next: {
					name: 'Deload',
					phase: 'deload',
					startsOn: addDays(END, 1),
					firstWeekKind: 'deload'
				}
			})
		);
		expect(review.fatigue.deloadPlanned).toBe(true);
		expect(review.deloadNeed.reasons).toContain(
			'Your next block already opens with a lighter week'
		);
	});

	it('flags a weekday often missed', () => {
		const review = evaluateCycle(input(block({ fridaysMissed: [0, 1, 3] })));
		expect(review.snapshot.adherence.oftenMissed).toEqual(['fri']);
		expect(find(review.findings, 'adherence:weekday:fri')!.label).toBe('Fridays often missed');
		expect(review.snapshot.adherence.weeks.map((w) => w.missed)).toEqual([1, 1, 0, 1]);
		expect(
			evaluateCycle(input(block({ fridaysMissed: [0, 1] }))).snapshot.adherence.oftenMissed
		).toEqual([]);
	});

	it('sets planned against achieved hard sets per group per week as plannedHardSets and hardSets count them', () => {
		const log = block();
		const weekPlan = {
			startsOn: MONDAY,
			sessions: [
				{
					kind: 'strength',
					exercises: [
						{ exercise: { key: 'back_squat' }, sets: [line('top', 3), line('top', 3)] },
						{ exercise: { key: 'bench_press' }, sets: [line('top', 3)] },
						{ exercise: { key: 'barbell_row' }, sets: [line('working', 3), line('working', 3)] }
					]
				}
			]
		} as unknown as WeekPlan;
		const planned = plannedHardSets(weekPlan, EXERCISES).groups;
		const targets = { ...TARGETS, planned };
		const base = input(log);
		const review = evaluateCycle({
			...base,
			block: { ...base.block, weeks: base.block.weeks.map((w) => ({ ...w, targets })) }
		});
		const achieved = new Map(hardSets(log.sets, EXERCISES, TZ).map((w) => [w.weekStart, w.groups]));
		for (let n = 0; n < WEEKS; n += 1) {
			const rows = review.snapshot.volume.filter((r) => r.weekStartsOn === weekOf(n));
			const groups = Object.keys({ ...planned, ...achieved.get(weekOf(n)) }).sort();
			expect(rows.map((r) => r.group).sort()).toEqual(groups);
			for (const row of rows) {
				expect(row.planned).toBe(planned[row.group] ?? null);
				expect(row.achieved).toBe(achieved.get(weekOf(n))![row.group] ?? 0);
				expect(row.target).toEqual(TARGETS.band[row.group as 'back'] ?? null);
			}
		}
		const back = find(review.findings, 'volume:sets:back')!;
		expect(back.figures.map((f) => f.value)).toEqual([
			review.snapshot.volume.filter((r) => r.group === 'back').reduce((s, r) => s + r.achieved, 0),
			planned.back! * WEEKS
		]);
	});

	it('scales the range by each week’s volume factor', () => {
		const base = input(block());
		const weeks = base.block.weeks.map((w, n) =>
			n === WEEKS - 1
				? { ...w, kind: 'deload' as const, targets: { ...TARGETS, volumeFactor: 0.6 } }
				: w
		);
		const review = evaluateCycle({ ...base, block: { ...base.block, weeks } });
		const last = review.snapshot.volume.find(
			(r) => r.weekStartsOn === weekOf(3) && r.group === 'back'
		)!;
		expect(last.target).toEqual([6, 12]);
	});

	it('withholds verdicts when adherence is low, and says so', () => {
		const review = evaluateCycle(input(block({ mondaysOnly: true })));
		expect(review.snapshot.adherence.pct).toBe(33.333333);
		// Judged, the squat progressed: the verdict is there, only withheld.
		expect(review.effectiveness.find((e) => e.exercise === 'back_squat')!.verdict).toBe(
			'progressed'
		);
		expect(review.snapshot.adherence.verdictsWithheld).toBe(true);
		for (const id of ['verdicts:strength', 'verdicts:e1rm:back_squat', 'effectiveness:back_squat'])
			expect(find(review.findings, id)!.verdict).toEqual({
				level: 'not_enough_data',
				words: 'Withheld: only 33 % of sessions were done, too few to judge the block'
			});
		expect(review.summary).toContain('Verdicts withheld');
	});

	it('says too few sessions for an exercise done under three times', () => {
		const log = block();
		lift(log, 'w3-fri', addDays(weekOf(3), 4), 'overhead_press', { kg: 50 });
		lift(log, 'w2-fri', addDays(weekOf(2), 4), 'overhead_press', { kg: 50 });
		const review = evaluateCycle(input(log));
		expect(review.effectiveness.find((e) => e.exercise === 'overhead_press')).toMatchObject({
			verdict: 'too_few',
			exposures: 2,
			stalled: false
		});
		expect(find(review.findings, 'effectiveness:overhead_press')!.verdict).toEqual({
			level: 'not_enough_data',
			words: 'Too few sessions to judge: 2 of 3'
		});
	});

	it('keeps a prescribed main lift with no logged sets as too few, in the main-lift count', () => {
		const log = block();
		log.sets = log.sets.filter((s) => s.exercise !== 'bench_press');
		const review = evaluateCycle(input(log));
		expect(review.effectiveness.find((e) => e.exercise === 'bench_press')).toEqual({
			exercise: 'bench_press',
			main: true,
			verdict: 'too_few',
			exposures: 0,
			firstKg: null,
			lastKg: null,
			stalled: false
		});
		expect(find(review.findings, 'verdicts:strength')!.verdict.words).toBe(
			'1 of 2 main lifts progressed'
		);
	});

	it('says no measure for a free-text goal, and measures the ones it can read', () => {
		const goals = [
			goal({ id: 'free', title: 'Get strong', targetPerformance: 'Feel strong and move well' }),
			goal({ id: 'squat', title: 'Squat', targetPerformance: 'Back squat 140 kg' }),
			goal({
				id: 'race',
				title: 'Spring 10K',
				disciplines: ['running'],
				eventType: '10K race',
				eventDate: addDays(END, 1 + 7 * 6),
				targetPerformance: 'Under 45:00'
			}),
			goal({ id: 'custom', title: 'Climb', disciplines: ['custom'] })
		];
		const review = evaluateCycle(input(block(), { goals }));
		expect(review.snapshot.goals.map((g) => [g.goalId, g.measure, g.sessions])).toEqual([
			['free', 'none', 8],
			['squat', 'e1rm', 8],
			['race', 'pace', 4],
			['custom', 'none', 0]
		]);
		expect(find(review.findings, 'goals:free:strength')!.verdict).toEqual({
			level: 'neutral',
			words: 'No measure: no lift and load to read in its target · 8 sessions this block'
		});
		expect(find(review.findings, 'goals:squat:strength')!.verdict.words).toMatch(/ to go$/);
		expect(find(review.findings, 'goals:race:running')!.verdict.words).toBe(
			'Target race pace 4:30\u00a0/km · 6 weeks to the event'
		);
		expect(find(review.findings, 'goals:custom:none')!.verdict.words).toMatch(/^No measure/);
	});

	it('is deterministic, with a short summary and a snapshot that passes its schema', () => {
		const log = block({ fridaysMissed: [2] });
		const goals = [goal({ targetPerformance: 'Bench press 100 kg' })];
		const a = evaluateCycle(input(log, { goals }));
		const shuffled = {
			...input(log, { goals }),
			workouts: [...log.workouts].reverse(),
			sets: [...log.sets].reverse(),
			runs: [...log.runs].reverse(),
			prescriptions: [...log.prescriptions].reverse(),
			sessions: [...log.planned].reverse()
		};
		expect(JSON.stringify(evaluateCycle(shuffled))).toBe(JSON.stringify(a));
		expect(a.summary.length).toBeLessThanOrEqual(SUMMARY_MAX);
		expect(cycleReviewSnapshotSchema.safeParse(a.snapshot).success).toBe(true);
		const row = {
			snapshotVersion: CYCLE_SNAPSHOT_VERSION,
			snapshot: a.snapshot,
			summary: a.summary
		};
		expect(readCycleSnapshot(row)).toEqual({
			legacy: false,
			version: CYCLE_SNAPSHOT_VERSION,
			summary: a.summary,
			snapshot: a.snapshot
		});
		expect(readCycleSnapshot({ ...row, snapshotVersion: 0 }).legacy).toBe(true);
		const long = evaluateCycle(
			input(log, { block: { ...input(log).block, name: 'B'.repeat(300) } })
		);
		expect(long.summary.length).toBeLessThanOrEqual(SUMMARY_MAX);
		expect(cycleReviewSnapshotSchema.safeParse(long.snapshot).success).toBe(true);
	});
});

describe('goal targets', () => {
	it('reads one profile lift and one load, never a guess', () => {
		expect(strengthTarget('Bench press 140 kg')).toEqual({ lift: 'bench_press', kg: 140 });
		expect(strengthTarget('Deadlift 500 lb')).toEqual({ lift: 'deadlift', kg: 226.8 });
		expect(strengthTarget('Get much stronger')).toBeNull();
		expect(strengthTarget('Bench press 140 kg and deadlift 200 kg')).toBeNull();
		expect(strengthTarget(null)).toBeNull();
		expect(strengthTarget('Incline bench press 80 kg')).toBeNull();
		expect(strengthTarget('Romanian deadlift 100 kg')).toBeNull();
	});

	it('reads a race distance and one finish time as a pace', () => {
		const race = (eventType: string, targetPerformance: string | null) =>
			racePaceTarget(goal({ eventType, targetPerformance }));
		expect(race('Marathon', 'Sub 3:30:00')).toBe(298.6);
		expect(race('Half marathon', '1:45:00')).toBe(298.6);
		expect(race('Marathon', 'Finish strong')).toBeNull();
		expect(race('Trail ultra', '3:30:00')).toBeNull();
		const general = goal({ title: '10K', disciplines: ['running'], measure: 'Under 45:00' });
		expect(racePaceTarget(general)).toBe(270);
	});
});
