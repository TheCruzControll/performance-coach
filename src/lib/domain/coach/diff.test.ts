import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';
import {
	ALTERNATIVE,
	BLOCK,
	DISLIKED,
	EXERCISE,
	FIXTURES,
	GOAL,
	OTHER_SESSION,
	PLANNED,
	SESSION
} from '../../../../tests/fixtures/coach-proposals';
import { describeChanges, type PlanChanges } from '../programming/replan/changes';
import { plannedHardSets, sessionLoadOf } from '../training/metrics';
import type { ProgramPlan, SessionPlan, SetPrescription } from '../training/types';
import {
	describeImpact,
	describeProposal,
	LOAD_WORDS,
	SUMMARY_LINE_MAX,
	summaryLines,
	type DiffContext,
	type DiffSession,
	type DiffWeek
} from './diff';
import { PROPOSAL_KINDS, proposalSchema, type Proposal } from './proposals';

const PAUSE_SQUAT = 'a1b2c3d4-0000-4000-8000-000000000031';
const LEG_PRESS = 'a1b2c3d4-0000-4000-8000-000000000032';
const RUN = 'a1b2c3d4-0000-4000-8000-000000000041';
const THAI = 'a1b2c3d4-0000-4000-8000-000000000042';
const GOAL_2 = 'a1b2c3d4-0000-4000-8000-000000000043';

const set = (overrides: Partial<SetPrescription> = {}): SetPrescription => ({
	role: 'top',
	sets: 1,
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

const base = {
	orderInDay: 1,
	discipline: 'strength',
	customDiscipline: null,
	intensity: 'moderate',
	source: 'generator',
	commitmentRef: null,
	instructions: null,
	notes: null
} as const;

const squatSession = (lineage: string, date: string, title: string): DiffSession => ({
	...base,
	lineage,
	kind: 'strength',
	type: 'strength',
	date,
	timeOfDay: 'morning',
	title,
	estMinutes: 40,
	estLoad: 320,
	targetRpe: 8,
	exercises: [
		{
			lineage: PLANNED,
			exercise: { key: 'back_squat' },
			baselineLift: 'back_squat',
			superset: null,
			substitutedFrom: null,
			substitutionReason: null,
			instructions: null,
			notes: null,
			sets: [set(), set({ role: 'working', sets: 3, targetRpe: null, loadValue: 90 })]
		}
	]
});

const WEEK: DiffWeek = {
	kind: 'build',
	startsOn: '2026-11-09',
	endsOn: '2026-11-15',
	targets: { rpeCap: 9, volumeFactor: 1, loadStep: 0.025, runVolumeFactor: 1 },
	sessions: [
		squatSession(SESSION, '2026-11-09', 'Lower A'),
		{
			...base,
			lineage: THAI,
			kind: 'other',
			type: 'muay_thai',
			discipline: 'muay_thai',
			date: '2026-11-10',
			timeOfDay: 'evening',
			title: 'Muay Thai class',
			estMinutes: 60,
			estLoad: 420,
			targetRpe: 7,
			details: { kind: 'class', durationMinutes: 60, targetRpe: 7, metrics: [], notes: null }
		},
		squatSession(OTHER_SESSION, '2026-11-11', 'Lower B'),
		{
			...base,
			lineage: RUN,
			kind: 'run',
			type: 'interval_run',
			discipline: 'running',
			date: '2026-11-12',
			timeOfDay: null,
			title: 'Intervals',
			estMinutes: 31,
			estLoad: 217,
			targetRpe: 7,
			segments: [
				{ ...segment(), kind: 'warm_up', distanceMetres: 2000 },
				{ ...segment(), kind: 'interval', repeatGroup: 1, repeats: 6, distanceMetres: 400 },
				{ ...segment(), kind: 'recovery', repeatGroup: 1, repeats: 6, durationSeconds: 90 }
			]
		}
	]
};

function segment() {
	return {
		repeatGroup: null,
		repeats: null,
		distanceMetres: null,
		durationSeconds: null,
		paceMinSecondsPerKm: null,
		paceMaxSecondsPerKm: null,
		hrZone: null,
		targetRpe: null
	};
}

const exercise = (
	id: string,
	key: string | null,
	name: string,
	baselineLift: 'back_squat' | 'front_squat' | null,
	primaryMuscles: DiffContext['exercises'][number]['primaryMuscles'],
	secondaryMuscles: DiffContext['exercises'][number]['secondaryMuscles'] = []
) => ({ id, key, name, baselineLift, primaryMuscles, secondaryMuscles });

/** Minutes a test can predict: 10 a strength set; a run's distance at 5:00 /km, plus its times. */
const estimateMinutes = (s: DiffSession) =>
	s.kind === 'strength'
		? s.exercises.reduce((t, e) => t + e.sets.reduce((u, l) => u + l.sets * 10, 0), 0)
		: s.kind === 'run'
			? s.segments.reduce(
					(t, g) =>
						t + ((g.distanceMetres ?? 0) / 200 + (g.durationSeconds ?? 0) / 60) * (g.repeats ?? 1),
					0
				)
			: s.estMinutes;

const NO_GOAL_FIELDS = {
	customDiscipline: null,
	eventType: null,
	eventDate: null,
	weightClass: null,
	targetPerformance: null,
	requirements: null,
	focus: null,
	measure: null,
	targetDate: null,
	notes: null
};

/** A replan's change, as its preview describes it: next week's squats go from 3 to 2 sets. */
function replanChanges(unit: 'kg' | 'lb'): PlanChanges {
	const plan = (sets: number, title: string): ProgramPlan => {
		const made = squatSession(SESSION, '2026-11-16', title) as Extract<
			DiffSession,
			{ kind: 'strength' }
		>;
		const { lineage: _lineage, exercises, ...session } = made;
		const strength = {
			...session,
			exercises: exercises.map(({ lineage: _l, ...e }) => ({
				...e,
				sets: [set({ role: 'working', sets, targetRpe: null, loadValue: 90 })]
			}))
		} as SessionPlan;
		const week = { ...WEEK, startsOn: '2026-11-16', endsOn: '2026-11-22', sessions: [strength] };
		return {
			title: 'Strength and Muay Thai',
			startsOn: '2026-11-09',
			firstPlannedDay: '2026-11-09',
			decisions: [],
			blocks: [
				{
					...{ phase: 'accumulation', name: 'Block 1', startsOn: '2026-11-16' },
					...{ endsOn: '2026-11-22', outline: false, goalRefs: [], progression: {} },
					weeks: [week]
				}
			]
		};
	};
	const squat = { name: 'Back squat', primaryMuscles: ['quads'], secondaryMuscles: ['glutes'] };
	return describeChanges(plan(3, 'Lower A'), plan(2, 'Lower A'), {
		units: { unit, distanceUnit: 'km' },
		from: '2026-11-16',
		exercises: new Map([['back_squat', squat as never]])
	});
}

const CONTEXT: DiffContext = {
	today: '2026-11-09',
	unit: 'kg',
	distanceUnit: 'km',
	weeks: [WEEK],
	exercises: [
		exercise(EXERCISE, 'back_squat', 'Back squat', 'back_squat', ['quads'], ['glutes']),
		exercise(ALTERNATIVE, 'front_squat', 'Front squat', 'front_squat', ['quads'], ['upper_back']),
		exercise(PAUSE_SQUAT, null, 'Pause squat', 'back_squat', ['quads'], ['glutes']),
		exercise(LEG_PRESS, null, 'Leg press', null, ['quads']),
		{ ...exercise(DISLIKED, 'split_squat', 'Split squat', null, ['quads']), sentiment: 'like' }
	],
	estimateMinutes,
	goals: [
		{
			...NO_GOAL_FIELDS,
			id: GOAL,
			kind: 'event',
			title: 'Fight in March',
			disciplines: ['muay_thai'],
			status: 'active',
			eventType: 'Muay Thai fight',
			eventDate: '2027-03-01',
			weightClass: '67 kg'
		},
		{
			...NO_GOAL_FIELDS,
			id: GOAL_2,
			kind: 'general',
			title: 'Squat 180 kg',
			disciplines: ['powerlifting'],
			status: 'active',
			focus: 'Squat strength',
			measure: 'A 180 kg single'
		}
	],
	blocks: [{ lineage: BLOCK, name: 'Strength block 1' }],
	program: { title: 'Strength and Muay Thai' },
	replan: replanChanges('kg')
};

const parse = (input: unknown): Proposal => z.parse(proposalSchema, input);
const fixture = (kind: (typeof PROPOSAL_KINDS)[number]) => parse(FIXTURES[kind]);
const adjustment = (...ops: object[]) =>
	parse({ ...FIXTURES.program_adjustment, payload: { ops } });
const rowsOf = (proposal: Proposal, context = CONTEXT) =>
	describeProposal(proposal, context).rows.map(({ label, before, after }) => ({
		label,
		before,
		after
	}));

describe('describeProposal rows', () => {
	it('shows a move from day to day, and a skip', () => {
		const { rows } = describeProposal(
			adjustment(
				{ op: 'move', sessionLineage: SESSION, toDate: '2026-11-13', timeOfDay: 'evening' },
				{ op: 'skip', sessionLineage: THAI }
			),
			CONTEXT
		);
		expect(rows).toEqual([
			{
				area: 'session',
				label: 'Lower A',
				before: 'Mon 9 Nov, Morning',
				after: 'Fri 13 Nov, Evening',
				date: '2026-11-13',
				link: { type: 'session', id: SESSION, label: 'Lower A', date: '2026-11-13' }
			},
			{
				area: 'session',
				label: 'Muay Thai class',
				before: 'Tue 10 Nov, Evening',
				after: 'Skipped',
				date: '2026-11-10',
				link: { type: 'session', id: THAI, label: 'Muay Thai class', date: '2026-11-10' }
			}
		]);
	});

	it('names both exercises of a swap and how its loads convert', () => {
		const swap = (toExerciseId: string, scope = 'once') => ({
			op: 'swap',
			sessionLineage: SESSION,
			plannedExerciseLineage: PLANNED,
			toExerciseId,
			scope
		});
		expect(rowsOf(adjustment(swap(PAUSE_SQUAT), swap(EXERCISE)))).toEqual([
			{
				label: 'Exercise in Lower A',
				before: 'Back squat',
				after: `Pause squat · ${LOAD_WORDS.kept}`
			},
			{
				label: 'Exercise in Lower A',
				before: 'Pause squat',
				after: `Back squat · ${LOAD_WORDS.kept}`
			}
		]);
		expect(rowsOf(adjustment(swap(ALTERNATIVE, 'never_again')))).toEqual([
			{
				label: 'Back squat, every session from Mon 9 Nov',
				before: 'Back squat',
				after: 'Front squat · loads set by RPE'
			}
		]);
	});

	it('words set adjustments in the owner’s unit, kg and lb', () => {
		const proposal = adjustment({
			op: 'adjust_set',
			sessionLineage: SESSION,
			plannedExerciseLineage: PLANNED,
			position: 1,
			loadValue: 105,
			restSeconds: 240
		});
		expect(rowsOf(proposal)).toEqual([
			{
				label: 'Back squat, top set',
				before: '1 × 5 @ RPE 8, 100 kg, rest 3:00',
				after: '1 × 5 @ RPE 8, 105 kg, rest 4:00'
			}
		]);
		// 100 kg and 105 kg on 5 lb plates.
		expect(rowsOf(proposal, { ...CONTEXT, unit: 'lb' })).toEqual([
			{
				label: 'Back squat, top set',
				before: '1 × 5 @ RPE 8, 220 lb, rest 3:00',
				after: '1 × 5 @ RPE 8, 230 lb, rest 4:00'
			}
		]);
	});

	it('words run segments and session details, in km and mi', () => {
		const proposal = adjustment(
			{ op: 'adjust_run_segment', sessionLineage: RUN, position: 1, distanceMetres: 3000 },
			{ op: 'adjust_run_segment', sessionLineage: RUN, position: 2, repeats: 8 },
			{ op: 'adjust_details', sessionLineage: THAI, durationMinutes: 90, targetRpe: 6 }
		);
		expect(rowsOf(proposal)).toEqual([
			{ label: 'Intervals, segment 1', before: 'Warm-up 2 km', after: 'Warm-up 3 km' },
			{
				label: 'Intervals, segment 2',
				before: '6 × Interval 400 m',
				after: '8 × Interval 400 m'
			},
			{ label: 'Muay Thai class', before: '60 min @ RPE 7', after: '90 min @ RPE 6' }
		]);
		expect(rowsOf(proposal, { ...CONTEXT, distanceUnit: 'mi' }).slice(0, 1)).toEqual([
			{ label: 'Intervals, segment 1', before: 'Warm-up 1.24 mi', after: 'Warm-up 1.86 mi' }
		]);
	});

	it('words a session substitution for this session only, by RPE', () => {
		expect(describeProposal(fixture('session_substitution'), CONTEXT).rows).toEqual([
			{
				area: 'exercise',
				label: 'Lower A, this session only',
				before: 'Back squat',
				after: 'Front squat · loads set by RPE',
				date: '2026-11-09',
				link: { type: 'session', id: SESSION, label: 'Lower A', date: '2026-11-09' }
			}
		]);
	});

	it('words goal changes, a reorder as ranked lists', () => {
		const proposal = parse({
			...FIXTURES.goal_update,
			payload: {
				ops: [
					...(FIXTURES.goal_update.payload as { ops: object[] }).ops.slice(0, 2),
					{ op: 'reorder', ids: [GOAL_2, GOAL] }
				]
			}
		});
		expect(rowsOf(proposal)).toEqual([
			{ label: 'New goal', before: null, after: 'Squat 140 kg' },
			{ label: 'Fight in March', before: 'Active', after: 'Paused' },
			{
				label: 'Goal priority',
				before: '1. Fight in March · 2. Squat 180 kg',
				after: '1. Squat 180 kg · 2. Fight in March'
			}
		]);
	});

	it('shows each field a goal edit changes, not only its title', () => {
		const edit = (goal: object) =>
			parse({ ...FIXTURES.goal_update, payload: { ops: [{ op: 'edit', goalId: GOAL, goal }] } });
		const fight = {
			kind: 'event',
			title: 'Fight in March',
			disciplines: ['muay_thai'],
			eventType: 'Muay Thai fight',
			eventDate: '2027-03-22',
			weightClass: '67 kg'
		};
		const moved = edit(fight);
		expect(describeProposal(moved, CONTEXT).rows).toEqual([
			{
				area: 'goal',
				label: 'Fight in March, event date',
				before: '1 Mar 2027',
				after: '22 Mar 2027',
				date: null,
				link: { type: 'goal', id: GOAL, label: 'Fight in March' }
			}
		]);
		expect(summaryLines(moved, CONTEXT)).toEqual([
			'Fight in March, event date: 1 Mar 2027 → 22 Mar 2027'
		]);
		expect(
			rowsOf(edit({ ...fight, eventDate: '2027-03-01', weightClass: '', status: 'paused' }))
		).toEqual([
			{ label: 'Fight in March, weight class', before: '67 kg', after: 'None' },
			{ label: 'Fight in March, status', before: 'Active', after: 'Paused' }
		]);
	});

	it('words a next cycle as its brief, after the block it follows', () => {
		expect(rowsOf(fixture('next_cycle'))).toEqual([
			{ label: 'Next block', before: 'Strength block 1', after: 'Intensification, 4 weeks' },
			{ label: 'Focus', before: null, after: 'Build squat strength toward a 3RM test' },
			{ label: 'Emphasis', before: null, after: 'Quads, Glutes & hips' },
			{
				label: 'Targets',
				before: null,
				after: 'RPE cap 9, volume ×0.9, loads +2.5 % a week, running ×1'
			},
			{ label: 'Rotate', before: 'Back squat', after: 'Front squat' },
			{ label: 'Running', before: null, after: '25 km a week, long run 10 km' },
			{ label: 'Ends with', before: null, after: 'A deload week' },
			{ label: 'Keep', before: null, after: 'Muay Thai on Tuesdays and Thursdays' }
		]);
	});

	it('words a new program and a preference', () => {
		expect(rowsOf(fixture('new_program'))).toEqual([
			{ label: 'Program', before: 'Strength and Muay Thai', after: 'A new program' },
			{ label: 'First session', before: null, after: 'Mon 16 Nov' }
		]);
		expect(rowsOf(fixture('preference_update'))).toEqual([
			{ label: 'Split squat', before: 'Like', after: 'Dislike' }
		]);
	});

	it('refuses an id the context lacks rather than guessing', () => {
		const unknown = 'a1b2c3d4-0000-4000-8000-0000000000ff';
		expect(() =>
			describeProposal(adjustment({ op: 'skip', sessionLineage: unknown }), CONTEXT)
		).toThrow(RangeError);
	});
});

describe('describeProposal impact', () => {
	const muscles = new Map(CONTEXT.exercises.map((e) => [e.key ?? `custom:${e.id}`, e] as const));
	const metrics = (sessions: DiffSession[]) => ({
		groups: plannedHardSets({ ...WEEK, sessions }, muscles).groups,
		minutes: sessions.reduce((t, s) => t + s.estMinutes, 0),
		load: sessions.reduce((t, s) => t + sessionLoadOf(s), 0)
	});

	it("is M3's metrics on the week before and after", () => {
		const [lowerA, thai, lowerB, run] = WEEK.sessions as [
			DiffSession,
			DiffSession,
			DiffSession,
			DiffSession
		];
		const proposal = adjustment(
			{ op: 'skip', sessionLineage: SESSION },
			{
				op: 'adjust_set',
				sessionLineage: OTHER_SESSION,
				plannedExerciseLineage: PLANNED,
				position: 2,
				sets: 5
			}
		);
		const changedB = structuredClone(lowerB) as Extract<DiffSession, { kind: 'strength' }>;
		changedB.exercises[0]!.sets[1]!.sets = 5;
		changedB.estMinutes = estimateMinutes(changedB);
		const before = metrics([lowerA, thai, lowerB, run]);
		const after = metrics([thai, changedB, run]);

		const { impact } = describeProposal(proposal, CONTEXT);
		expect(impact).toEqual([
			{
				weekStart: '2026-11-09',
				hardSets: {
					hips: after.groups.hips! - before.groups.hips!,
					quads: after.groups.quads! - before.groups.quads!
				},
				minutes: after.minutes - before.minutes,
				load: after.load - before.load,
				runMetres: 0
			}
		]);
		// Lower A's 4 hard sets go, Lower B gains 2: quads −2, glutes (secondary) −1.
		expect(impact[0]).toMatchObject({
			hardSets: { quads: -2, hips: -1 },
			minutes: -20,
			load: -160
		});
	});

	it('counts a swap’s muscles and run metres, and leaves a move’s week unchanged', () => {
		const op = {
			op: 'swap',
			sessionLineage: SESSION,
			plannedExerciseLineage: PLANNED,
			toExerciseId: LEG_PRESS,
			scope: 'once'
		};
		expect(describeProposal(adjustment(op), CONTEXT).impact).toEqual([
			{ weekStart: '2026-11-09', hardSets: { hips: -2 }, minutes: 0, load: 0, runMetres: 0 }
		]);
		// Never again swaps it in Lower B too.
		const never = adjustment({ ...op, scope: 'never_again' });
		expect(describeProposal(never, CONTEXT).impact).toEqual([
			{ weekStart: '2026-11-09', hardSets: { hips: -4 }, minutes: 0, load: 0, runMetres: 0 }
		]);
		const run = adjustment({
			op: 'adjust_run_segment',
			sessionLineage: RUN,
			position: 2,
			repeats: 8
		});
		expect(describeProposal(run, CONTEXT).impact).toEqual([
			// Its recovery shares the repeat group: 2 more 400 m and 2 more 1:30.
			{ weekStart: '2026-11-09', hardSets: {}, minutes: 7, load: 49, runMetres: 800 }
		]);
		const move = adjustment({ op: 'move', sessionLineage: SESSION, toDate: '2026-11-14' });
		expect(describeProposal(move, CONTEXT).impact).toEqual([]);
	});

	it('never changes the context it is given', () => {
		const before = structuredClone(CONTEXT.weeks);
		describeProposal(fixture('program_adjustment'), CONTEXT);
		describeProposal(fixture('session_substitution'), CONTEXT);
		expect(CONTEXT.weeks).toEqual(before);
	});

	it('words the impact a line a week, in the owner’s distance unit', () => {
		const impact = [
			{
				weekStart: '2026-11-09',
				hardSets: { quads: -2, hips: 0.5 },
				minutes: -40,
				load: -320,
				runMetres: 1609.344
			}
		];
		expect(describeImpact(impact, { distanceUnit: 'km' })).toEqual([
			'Week of Mon 9 Nov: Glutes & hips +0.5 hard sets, Quads −2 hard sets, −40 min, load −320, running +1.61 km'
		]);
		expect(describeImpact(impact, { distanceUnit: 'mi' })[0]).toMatch(/running \+1 mi$/);
	});
});

describe('a replan', () => {
	it('is its preview’s changes: each row under its week, the impact and the summary lines', () => {
		const changes = replanChanges('kg');
		const { rows, impact } = describeProposal(fixture('replan'), CONTEXT);
		expect(rows).toEqual(
			changes.weeks.flatMap((w) =>
				w.rows.map((r) => ({
					area: 'session',
					label: `Week of 16 Nov · ${r.label}`,
					before: r.before,
					after: r.after,
					date: r.date,
					link: null
				}))
			)
		);
		expect(rows).toEqual([
			expect.objectContaining({
				label: 'Week of 16 Nov · Lower A, Back squat',
				before: '3 × 5, 90 kg',
				after: '2 × 5, 90 kg',
				date: '2026-11-16'
			})
		]);
		expect(impact).toEqual(changes.impact);
		expect(summaryLines(fixture('replan'), CONTEXT)).toEqual(changes.summaryLines);
	});

	it('words its rows in the owner’s units, the same every time', () => {
		const lb = { ...CONTEXT, unit: 'lb' as const, replan: replanChanges('lb') };
		const rows = rowsOf(fixture('replan'), lb);
		expect([rows[0]!.before, rows[0]!.after]).toEqual(['3 × 5, 200 lb', '2 × 5, 200 lb']);
		expect(rowsOf(fixture('replan'), lb)).toEqual(rows);
		expect(rowsOf(fixture('replan'))).not.toEqual(rows);
	});

	it('needs its changes: a replan with none is a RangeError', () => {
		const { replan: _replan, ...without } = CONTEXT;
		expect(() => describeProposal(fixture('replan'), without)).toThrow(RangeError);
		expect(() => summaryLines(fixture('replan'), without)).toThrow(RangeError);
	});
});

describe('summaryLines', () => {
	it.each(PROPOSAL_KINDS)(
		'gives the %s up to 3 lines, the first non-empty and at most 200 characters',
		(kind) => {
			const lines = summaryLines(fixture(kind), CONTEXT);
			expect(lines.length).toBeGreaterThan(0);
			expect(lines.length).toBeLessThanOrEqual(3);
			expect(lines[0]!.trim()).not.toBe('');
			for (const line of lines) expect(line.length).toBeLessThanOrEqual(SUMMARY_LINE_MAX);
			expect(summaryLines(fixture(kind), CONTEXT)).toEqual(lines);
		}
	);

	it('leads with the first change and counts the rest, then the impact', () => {
		expect(
			summaryLines(
				adjustment(
					{ op: 'skip', sessionLineage: SESSION },
					{ op: 'move', sessionLineage: RUN, toDate: '2026-11-14' }
				),
				CONTEXT
			)
		).toEqual([
			'Lower A: Mon 9 Nov, Morning → Skipped (+1 more change)',
			`Week of Mon 9 Nov: Glutes & hips −2 hard sets, Quads −4 hard sets, −40 min, load −320`
		]);
		expect(summaryLines(fixture('goal_update'), CONTEXT)).toEqual([
			'New goal: Squat 140 kg (+2 more changes)',
			'Fight in March: Active → Paused',
			'Goal priority: 1. Fight in March → 1. Fight in March'
		]);
	});

	it('cuts a long first line at a word, within 200 characters', () => {
		const title = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
		const context = {
			...CONTEXT,
			weeks: [{ ...WEEK, sessions: [{ ...WEEK.sessions[0]!, title }] }]
		};
		const [first] = summaryLines(adjustment({ op: 'skip', sessionLineage: SESSION }), context);
		expect(first!.length).toBeLessThanOrEqual(SUMMARY_LINE_MAX);
		expect(first).toMatch(/^word0 word1 .* word\d+…$/);
	});
});
