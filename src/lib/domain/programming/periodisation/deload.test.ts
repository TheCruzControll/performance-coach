import { describe, expect, it } from 'vitest';
import { staticRuleKeys } from '../../../../../scripts/rule-keys';
import { METRICS } from '../../analytics/metrics';
import * as strength from '../../analytics/strength';
import { classifyTrend } from '../../analytics/trend';
import type { TrendResult } from '../../analytics/trend';
import { addDays, mondayOf } from '../../calendar';
import type { IsoDate } from '../../calendar';
import { CATALOGUE, catalogueByKey } from '../../exercises/index';
import type { ExperienceLevel } from '../../profile/catalog';
import type { BlockPlan, SessionPlan, WeekPlan } from '../../training/types';
import type { WeekKind } from '../../training/vocabulary';
import { DecisionLog } from '../decisions';
import { firstDraft, STAGES } from '../generate';
import { buildProgrammingInput } from '../index';
import type { ProgrammingInput } from '../input';
import type { GenerateOptions } from '../stage';
import { loadModel } from '../load/fatigue';
import type { ModelPlanned } from '../load/fatigue';
import { fromLogged } from '../load/from-facts';
import { composeWeeklyReview } from '../review/weekly';
import type { ReviewExercise } from '../review/weekly';
import { CADENCE, GUARDS, TARGETS, TRIGGERS } from '../rules/deload';
import { RULE_BY_ID } from '../rules/registry/index';
import { MUAY_THAI } from '../rules/running';
import { SCENARIO_START } from '../scenarios';
import { deloadNeed, deloadSessions, deloadWeek, scheduledDeloads } from './deload';
import type { CalendarWeek, DeloadNeedInput, LiftTrend } from './deload';
import { HISTORIES } from './histories';
import type { FactHistory } from './histories';
import { M7_SCENARIOS, m7Day } from './scenarios';

const TARGET = m7Day(2, 0);
const week = (n: number, kind: WeekKind): CalendarWeek => ({
	startsOn: addDays(TARGET, 7 * n),
	kind
});
const CALENDAR = [-2, -1, 0, 1, 2].map((n) => week(n, 'accumulation'));
const trend = (verdict: 'down' | 'flat'): TrendResult =>
	(verdict === 'down'
		? { verdict: 'real_trend', direction: 'down', good: false }
		: { verdict: 'normal_variation' }) as TrendResult;
const lifts = (down: number): LiftTrend[] =>
	['Back squat', 'Bench press', 'Deadlift'].map((name, i) => ({
		name,
		trend: trend(i < down ? 'down' : 'flat')
	}));
const need = (over: Partial<DeloadNeedInput> = {}) =>
	deloadNeed({
		fatigue: { level: 'none', reasons: [] },
		trends: { lifts: lifts(0) },
		overload: null,
		calendar: CALENDAR,
		targetWeek: TARGET,
		...over
	});
const watch = { level: 'watch', reasons: ['You have slept 6 hours a night'] } as const;
const high = {
	level: 'high',
	reasons: ['You have been sore (4 of 5)', 'You have slept 5.9 hours a night']
} as const;

describe('scheduledDeloads', () => {
	const loading = (n: number) =>
		Array.from({ length: n }, () => ({ kind: 'accumulation' as const }));

	it.each([
		['new', [5, 11]],
		['novice', [4, 9]],
		['intermediate', [4, 9]],
		['advanced', [3, 7, 11]]
	] as [ExperienceLevel, number[]][])(
		'deloads a %s lifter after its cadence of loading weeks, and at the block’s end',
		(level, deloads) => {
			expect(CADENCE.weeks[level]).toBe({ new: 5, novice: 4, intermediate: 4, advanced: 3 }[level]);
			expect(scheduledDeloads(loading(12), level)).toEqual(deloads);
		}
	);

	it('counts a planned light week as the rest, and plans none beside it', () => {
		expect(
			scheduledDeloads([...loading(3), { kind: 'taper' }, { kind: 'event' }], 'advanced')
		).toEqual([]);
		expect(
			scheduledDeloads([...loading(4), { kind: 'taper' }, ...loading(4)], 'intermediate')
		).toEqual([8]);
		// One loading week before a block's end has nothing to absorb; two do.
		expect(scheduledDeloads(loading(2), 'advanced')).toEqual([]);
		expect(scheduledDeloads(loading(3), 'advanced')).toEqual([2]);
	});
});

describe('deloadNeed: the triggers', () => {
	it('deloads on high fatigue, naming M6’s reasons', () => {
		const result = need({ fatigue: high });
		expect(result).toMatchObject({ action: 'deload', week: TARGET, ruleKey: 'deload.triggers' });
		expect(result.reasons).toEqual(high.reasons);
		expect(result.evidence).toMatchObject({ trigger: 'fatigue_high', fatigue: 'high' });
		expect(result.blockedBy).toBeNull();
	});

	it('deloads on watch with 2 main lifts really declining, and not on 1', () => {
		const two = need({ fatigue: watch, trends: { lifts: lifts(2) } });
		expect(two.action).toBe('deload');
		expect(two.evidence).toMatchObject({ trigger: 'watch_decline', decliningLifts: 2 });
		expect(two.reasons).toContain('Back squat and Bench press: estimated 1RM really declining');
		expect(need({ fatigue: watch, trends: { lifts: lifts(1) } }).action).toBe('none');
	});

	it('deloads on watch with easy runs 3 % slower at the same effort, and not at 2 %', () => {
		const slower = need({
			fatigue: watch,
			trends: { lifts: lifts(0), easyPace: { before: 330, recent: 340 } }
		});
		expect(slower.action).toBe('deload');
		expect(slower.reasons).toContain('Easy runs 3 % slower at the same effort');
		const slight = { before: 330, recent: 336 };
		expect(need({ fatigue: watch, trends: { lifts: lifts(0), easyPace: slight } }).action).toBe(
			'none'
		);
		// 2.96 % shows as 3 % but is under the threshold; a zero pace before is no signal.
		for (const easyPace of [
			{ before: 2500, recent: 2574 },
			{ before: 0, recent: 340 }
		]) {
			const out = need({ fatigue: watch, trends: { lifts: lifts(0), easyPace } });
			expect(out.action).toBe('none');
			expect(Object.values(out.evidence)).not.toContain(Infinity);
		}
	});

	it('does not deload on watch alone, nor on a decline with no fatigue, and says why', () => {
		const alone = need({ fatigue: watch });
		expect(alone.action).toBe('none');
		expect(alone.reasons.at(-1)).toMatch(/^Fatigue is at watch with no real decline/);
		expect(need({ trends: { lifts: lifts(3) } }).action).toBe('none');
		expect(need().reasons).toEqual([
			'Fatigue is low, and no system overloaded on 5 of the last 7 days: no deload needed.'
		]);
	});

	const hardRuns = (from: IsoDate) =>
		Array.from(
			{ length: 7 },
			(_, d) =>
				({
					kind: 'run',
					date: addDays(from, d),
					timeOfDay: null,
					orderInDay: 1,
					type: 'long_run',
					title: `Long run ${d}`,
					discipline: 'running',
					intensity: 'hard',
					estMinutes: 90,
					source: 'generator',
					targetRpe: 7,
					segments: [{ kind: 'long' }]
				}) as ModelPlanned
		);

	it('deloads on a system overloaded 5 of the last 7 days, without M1’s ratio', () => {
		const days = loadModel({
			planned: hardRuns(TARGET),
			logged: [],
			from: TARGET,
			to: addDays(TARGET, 6),
			today: TARGET
		});
		expect(days.at(-1)!.systems.lower.ratio).toBeNull();
		const result = need({ overload: { days, today: addDays(TARGET, 6) } });
		expect(result.action).toBe('deload');
		expect(result.evidence).toMatchObject({
			trigger: 'overload',
			overloadedSystem: 'Lower body',
			overloadedDays: 6
		});
		expect(result.reasons).toEqual(['Lower body overloaded on 6 of the last 7 days']);
		// Four of those days are not enough.
		expect(need({ overload: { days: days.slice(0, 5), today: addDays(TARGET, 4) } }).action).toBe(
			'none'
		);
	});

	it('deloads on a system overloaded 5 of the last 7 days, with M1’s ratio', () => {
		const h = HISTORIES.overreachingRun();
		const next = addDays(h.lastWeek, 7);
		const days = loadModel({
			planned: hardRuns(next),
			logged: fromLogged({ ...h, timeZone: 'UTC' }),
			from: h.firstWeek,
			to: addDays(next, 6),
			today: next
		});
		expect(days.at(-1)!.systems.lower.ratio).not.toBeNull();
		const result = need({ overload: { days, today: addDays(next, 6) } });
		expect(result.action).toBe('deload');
		expect(result.evidence.trigger).toBe('overload');
		expect(result.evidence.overloadedDays).toBeGreaterThanOrEqual(TRIGGERS.overload.overloadedDays);
	});
});

describe('deloadNeed: the guards', () => {
	const withWeek = (n: number, kind: WeekKind) =>
		CALENDAR.map((w) => (w.startsOn === addDays(TARGET, 7 * n) ? { ...w, kind } : w));

	it('does nothing more to a week already light', () => {
		const result = need({ fatigue: high, calendar: withWeek(0, 'taper') });
		expect(result).toMatchObject({ action: 'already_light', ruleKey: 'deload.guards' });
		expect(result.blockedBy).toEqual({ guard: 'light_week', week: week(0, 'taper') });
		expect(result.reasons.at(-1)).toBe('The week is already a taper week, so it is light already.');
	});

	it.each([
		[1, 'taper', 'A taper week is planned the week after'],
		[2, 'taper', 'A taper week is planned 2 weeks after'],
		[1, 'deload', 'A deload week is planned the week after'],
		[2, 'deload', 'A deload week is planned 2 weeks after']
	] as [number, WeekKind, string][])(
		'holds for a %s-week-later %s, easing the target week instead',
		(n, kind, text) => {
			const result = need({ fatigue: high, calendar: withWeek(n, kind) });
			expect(result.action).toBe('hold_for_planned');
			expect(result.blockedBy).toEqual({ guard: 'planned_light', week: week(n, kind) });
			expect(result.reasons.at(-1)).toMatch(new RegExp(`^${text}`));
		}
	);

	it('looks only two weeks ahead', () => {
		const later = [...CALENDAR, week(3, 'taper')];
		expect(need({ fatigue: high, calendar: later }).action).toBe('deload');
	});

	it('only reduces volume within 14 days of the last deload', () => {
		for (const n of [-1, -2]) {
			const result = need({ fatigue: high, calendar: withWeek(n, 'deload') });
			expect(result.action).toBe('reduce_volume');
			expect(result.blockedBy).toEqual({ guard: 'recent_deload', week: week(n, 'deload') });
		}
		// A deload three weeks before ended 15 days before the target week.
		const longer = [week(-3, 'deload'), ...CALENDAR];
		expect(need({ fatigue: high, calendar: longer }).action).toBe('deload');
		expect(GUARDS.recentDeloadDays).toBe(14);
	});

	it('may deload a cutback week, light for running only', () => {
		expect(need({ fatigue: high, calendar: withWeek(0, 'cutback') }).action).toBe('deload');
	});
});

// ---- S7, through M6's own functions -----------------------------------------------------------

const exercisesOf = (h: FactHistory) =>
	new Map<string, ReviewExercise>(
		[...new Set(h.sets.map((s) => s.exercise))].map((key) => {
			const entry = catalogueByKey.get(key)!;
			return [key, { ...entry, name: entry.name }];
		})
	);

describe('the declining history (S7)', () => {
	it('gives a deload naming each signal', () => {
		const h = HISTORIES.declining();
		const exercises = exercisesOf(h);
		const { fatigue } = composeWeeklyReview({
			weekStartsOn: h.lastWeek,
			today: addDays(h.lastWeek, 7),
			timeZone: h.timeZone,
			unit: 'kg',
			distanceUnit: 'km',
			week: { kind: 'accumulation', sessions: [] },
			next: { state: 'planned', kind: 'accumulation' },
			completedLineages: new Set(h.workouts.flatMap((w) => w.plannedLineage ?? [])),
			workouts: h.workouts,
			sets: h.sets,
			runs: h.runs,
			recovery: h.recovery,
			prescriptions: h.prescriptions,
			exercises,
			targets: { band: null, volumeFactor: 1, planned: null, label: 'No target' },
			digest: { facts: [], workouts: [] }
		}).snapshot;
		// Each main lift's weekly best e1RM, judged by M6's trend classifier.
		const trends = strength.keyLifts(h.sets, exercises).map(({ exercise }) => {
			const best = new Map<IsoDate, number>();
			for (const p of strength.e1rmSeries(
				h.sets.filter((s) => s.exercise === exercise),
				exercises.get(exercise)!,
				h.timeZone
			))
				best.set(mondayOf(p.on), Math.max(best.get(mondayOf(p.on)) ?? 0, p.value));
			const points = [...best].map(([at, value]) => ({ at, value, inProgress: false }));
			return {
				name: exercises.get(exercise)!.name,
				trend: classifyTrend(points, { direction: METRICS.e1rm.direction, mpc: METRICS.e1rm.mpc })
			};
		});
		const days = loadModel({
			planned: [],
			logged: fromLogged({ ...h, timeZone: 'UTC' }),
			from: h.firstWeek,
			to: addDays(h.lastWeek, 6),
			today: addDays(h.lastWeek, 7)
		});
		const result = deloadNeed({
			fatigue,
			trends: { lifts: trends },
			overload: { days, today: addDays(h.lastWeek, 6) },
			calendar: [{ startsOn: h.lastWeek, kind: 'accumulation' }],
			targetWeek: addDays(h.lastWeek, 7)
		});
		expect(result.action).toBe('deload');
		expect(result.reasons).toEqual([
			'You have been sore (4 of 5)',
			'You have slept 5.9 hours a night',
			'The same loads feel 0.7 RPE harder',
			'2 lifts are declining while feeling harder',
			'Bench press and Back squat: estimated 1RM really declining'
		]);
		expect(result.evidence).toMatchObject({ trigger: 'fatigue_high', decliningLifts: 2 });
	});
});

// ---- The deload week ----------------------------------------------------------------------------

describe('deloadWeek', () => {
	it('cuts sets 40 % and runs 30 %, caps RPE at 6 and loads 10 % under the week’s own', () => {
		expect(
			deloadWeek({ rpeCap: 8.5, volumeFactor: 1.1, loadStep: 0.025, runVolumeFactor: 1.3 })
		).toEqual({
			rpeCap: 6,
			volumeFactor: 0.66,
			loadStep: -0.0775,
			runVolumeFactor: 0.91
		});
	});

	it('eases every block-type target: main lifts, sets per group, the long run and sparring', () => {
		const out = deloadWeek({
			rpeCap: 9,
			volumeFactor: 1,
			loadStep: 0,
			runVolumeFactor: 1,
			mainLifts: { repsMin: 3, repsMax: 5, topRpe: 9, setsFactor: 0.8 },
			setsPerGroup: { min: 12, max: 16, step: 2 },
			running: { longRunMetres: 20_000, raceSpecific: 'threshold', cutback: false },
			combat: { sessions: 3, hardSparring: 2, sparringRounds: 10, conditioningRounds: 10 },
			maintenance: ['runs']
		});
		expect(out).toMatchObject({
			mainLifts: { repsMin: 3, repsMax: 5, topRpe: 6, setsFactor: 0.48 },
			setsPerGroup: { min: 7, max: 10, step: 0 },
			running: { longRunMetres: 14_000, raceSpecific: null, cutback: false },
			combat: { sessions: 3, hardSparring: 0, sparringRounds: 0, conditioningRounds: 6 },
			maintenance: ['runs']
		});
	});

	it('reads a cutback week by its kind, as deloadSessions does', () => {
		const cutback = { rpeCap: 8, volumeFactor: 1, loadStep: 0, runVolumeFactor: 0.8 };
		// At 80 %, a cutback comes down only to the deload's 70 % of a full week.
		expect(deloadWeek(cutback, TARGETS, 'cutback').runVolumeFactor).toBe(0.7);
	});

	it('reads M3’s deload week live', () => {
		expect(TARGETS).toMatchObject({ setsFactor: 0.6, rpeCap: 6, loadFactor: 0.9, runFactor: 0.7 });
	});
});

// ---- deloadSessions -----------------------------------------------------------------------------

/** M3's blocks for `input`: its stages from a draft with no season, prepare left out. */
function m3Blocks(input: ProgrammingInput, options: GenerateOptions): BlockPlan[] {
	const context = { input, options, log: new DecisionLog() };
	let draft = firstDraft({ input, periodisation: null });
	// M3's stages: the schedule stage (generator-schedule) is M7's.
	for (const stage of STAGES.filter((s) => s.name !== 'schedule'))
		draft = stage.run(draft, context);
	return draft.blocks;
}

/**
 * Week 2 of S1's first block: strength, runs with a tempo, and two Muay Thai classes. It is the
 * week M3's stages plan with no season (generator-season changes the generated week), so these
 * tests pin deloadSessions and nothing else.
 */
function s1Week(): WeekPlan {
	const input = buildProgrammingInput(M7_SCENARIOS.multiGoal(), { catalogue: CATALOGUE });
	const [block] = m3Blocks(input, { startsOn: SCENARIO_START, firstPlannedDay: SCENARIO_START });
	const week = structuredClone(block!.weeks[1]!);
	// One absolute load, and one Muay Thai session of the plan's own: sparring.
	const lift = week.sessions.find((s) => s.kind === 'strength')!;
	lift.exercises[0]!.sets[0] = {
		...lift.exercises[0]!.sets[0]!,
		loadKind: 'absolute',
		loadValue: 102.5,
		loadUnit: 'kg'
	};
	const cls = week.sessions.find((s) => s.kind === 'other')!;
	week.sessions.push({
		...structuredClone(cls),
		date: addDays(week.startsOn, 5),
		orderInDay: 2,
		title: MUAY_THAI.sparring.title,
		intensity: MUAY_THAI.sparring.intensity,
		source: 'generator',
		commitmentRef: null,
		details: {
			...cls.details,
			kind: 'sparring',
			metrics: [{ key: 'rounds', label: 'Rounds', unit: null, value: MUAY_THAI.sparring.rounds }]
		}
	});
	return week;
}

/** A session's shape: what a deload never changes. */
const shape = (s: SessionPlan) => ({
	date: s.date,
	orderInDay: s.orderInDay,
	kind: s.kind,
	source: s.source,
	rows:
		s.kind === 'strength'
			? s.exercises.map((e) => [e.exercise, e.sets.map((l) => l.role)])
			: s.kind === 'run'
				? s.segments.map((g) => [g.repeatGroup, g.repeats])
				: []
});

describe('deloadSessions', () => {
	const all = () => true;

	it('keeps the sessions, days, exercises and set rows, changing their values', () => {
		const week = s1Week();
		const out = deloadSessions(week, TARGETS, all);
		expect(out.map(shape)).toEqual(week.sessions.map(shape));
		for (const [i, s] of out.entries()) {
			expect(s.targetRpe).toBeLessThanOrEqual(6);
			expect(s.estLoad).toBe(s.estMinutes * s.targetRpe);
			if (s.kind !== 'strength') continue;
			const before = week.sessions[i] as typeof s;
			s.exercises.forEach((e, x) =>
				e.sets.forEach((line, k) => {
					const was = before.exercises[x]!.sets[k]!;
					expect(line.sets).toBe(Math.max(1, Math.round(was.sets * 0.6)));
					expect(line.targetRpe).toBe(Math.min(was.targetRpe!, 6));
				})
			);
		}
	});

	it('lightens loads 10 %, down to the plates, absolute and relative', () => {
		const week = s1Week();
		const out = deloadSessions(week, TARGETS, all);
		const lines = out.flatMap((s) =>
			s.kind === 'strength' ? s.exercises.flatMap((e) => e.sets) : []
		);
		expect(lines.find((l) => l.loadKind === 'absolute')).toMatchObject({
			loadValue: 90,
			loadUnit: 'kg'
		});
		// Front squat's 0.799 and 0.7 of its e1RM: × 0.9, down to 2.5 %.
		expect(lines.filter((l) => l.loadKind === 'from_e1rm').map((l) => l.loadValue)).toEqual([
			0.7, 0.625
		]);
	});

	it('runs 30 % shorter, with the tempo made easy at E pace in zone 2', () => {
		const week = s1Week();
		const out = deloadSessions(week, TARGETS, all);
		const tempo = out.find((s) => s.date === addDays(week.startsOn, 4) && s.kind === 'run')!;
		expect(tempo).toMatchObject({ type: 'easy_run', title: 'Easy run', intensity: 'easy' });
		if (tempo.kind !== 'run') throw new Error('a run');
		expect(
			tempo.segments.map((g) => [g.kind, g.durationSeconds, g.hrZone, g.paceMinSecondsPerKm])
		).toEqual([
			['warm_up', 420, 2, 324],
			['easy', 840, 2, 324],
			['cool_down', 420, 2, 324]
		]);
		const easy = out.find((s) => s.type === 'easy_run' && s.date === week.startsOn)!;
		if (easy.kind !== 'run') throw new Error('a run');
		expect(easy.segments[0]!.distanceMetres).toBe(8100);
		// With the owner's paces, an eased segment runs at their E.
		const paced = deloadSessions(week, TARGETS, all, {
			paces: { E: [300, 340], M: [270, 280], T: [255, 262], I: [235, 240], R: [220, 225] }
		}).find((s) => s.date === addDays(week.startsOn, 4) && s.kind === 'run');
		if (paced?.kind !== 'run') throw new Error('a run');
		expect(paced.segments[1]).toMatchObject({ paceMinSecondsPerKm: 300, paceMaxSecondsPerKm: 340 });
	});

	it('makes the plan’s Muay Thai technique and its sparring pads; a class keeps its slot at RPE 6', () => {
		const week = s1Week();
		const out = deloadSessions(week, TARGETS, all);
		const others = out.filter((s) => s.kind === 'other');
		expect(
			others.map((s) => [
				s.date,
				s.source,
				s.timeOfDay,
				s.targetRpe,
				s.details.kind,
				s.details.targetRpe
			])
		).toEqual([
			[addDays(week.startsOn, 1), 'commitment', 'evening', 6, 'class', 6],
			[addDays(week.startsOn, 3), 'commitment', 'evening', 6, 'class', 6],
			[addDays(week.startsOn, 5), 'generator', 'evening', 6, 'pad_work', 6]
		]);
		// The plan's session is retitled with its new format, and its rounds follow.
		expect([others[2]!.title, others[2]!.details.metrics[0]!.value]).toEqual([
			MUAY_THAI.pad_work.title,
			MUAY_THAI.pad_work.rounds
		]);
		const technique = {
			...structuredClone(others[2]!),
			details: { ...others[2]!.details, kind: 'pad_work' as const }
		};
		const [made] = deloadSessions({ ...week, sessions: [technique] }, TARGETS, all);
		expect(made?.kind === 'other' && made.details.kind).toBe('technical');
	});

	it('keeps a commitment run’s length and pace, capping only its effort', () => {
		const week = s1Week();
		const run = week.sessions.find(
			(s) => s.kind === 'run' && s.segments.some((g) => g.kind === 'tempo')
		)!;
		const club = { ...structuredClone(run), source: 'commitment' as const };
		const [out] = deloadSessions({ ...week, sessions: [club] }, TARGETS, all);
		if (out?.kind !== 'run' || club.kind !== 'run') throw new Error('a run');
		expect([out.estMinutes, out.type, out.title, out.targetRpe]).toEqual([
			club.estMinutes,
			club.type,
			club.title,
			Math.min(club.targetRpe, 6)
		]);
		expect(out.segments).toEqual(
			club.segments.map((g) => ({
				...g,
				targetRpe: g.targetRpe === null ? null : Math.min(g.targetRpe, 6)
			}))
		);
	});

	it('leaves every session outside ahead byte-identical', () => {
		const week = s1Week();
		const today = addDays(week.startsOn, 3);
		const out = deloadSessions(week, TARGETS, (s) => s.date >= today);
		week.sessions.forEach((s, i) => {
			if (s.date < today) expect(JSON.stringify(out[i])).toBe(JSON.stringify(s));
			else expect(out[i]).not.toEqual(s);
		});
	});

	it('keeps a cutback week’s lower mileage', () => {
		const week = s1Week();
		const runs = (sessions: SessionPlan[]) =>
			sessions.flatMap((s) =>
				s.kind === 'run' ? s.segments.map((g) => g.distanceMetres ?? g.durationSeconds) : []
			);
		const cutback = { ...week, kind: 'cutback' as const };
		// At 80 %, a cutback comes down only to the deload's 70 % of a full week.
		expect(runs(deloadSessions(cutback, TARGETS, all))).toEqual([10100, 540, 1050, 540, 10100]);
		// A cutback already under it keeps its mileage; its tempo is still made easy.
		const deep = deloadSessions(cutback, { ...TARGETS, cutbackShare: 0.6 }, all);
		expect(runs(deep)).toEqual(runs(week.sessions));
		expect(deep.some((s) => s.kind === 'run' && s.segments.some((g) => g.kind === 'tempo'))).toBe(
			false
		);
	});
});

describe('the deload rules', () => {
	it(
		'registers each constant live, and every key deloadNeed cites resolves in this area',
		{ timeout: 60_000 },
		() => {
			const live = (id: string) => {
				const rule = RULE_BY_ID.get(id);
				return rule?.kind === 'constant' ? rule.values : undefined;
			};
			expect(live('deload.cadence')).toBe(CADENCE);
			expect(live('deload.targets')).toBe(TARGETS);
			expect(live('deload.triggers')).toBe(TRIGGERS);
			expect(live('deload.guards')).toBe(GUARDS);
			const cited = [
				...staticRuleKeys(['src/lib/domain/programming/periodisation/deload.ts'])
			].sort();
			expect(cited).toEqual(['deload.guards', 'deload.triggers']);
			for (const key of cited) expect(RULE_BY_ID.get(key)?.area).toBe('deload');
		}
	);
});
