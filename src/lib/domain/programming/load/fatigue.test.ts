import { afterEach, describe, expect, it } from 'vitest';
import { periodWindow } from '../../analytics/periods';
import { dailyLoads, sessionLoads, weeklyLoad } from '../../analytics/workload';
import { addDays, daysBetween } from '../../calendar';
import type { IsoDate } from '../../calendar';
import { acuteChronicRatio } from '../../load';
import { SYSTEMS } from '../evaluate/types';
import type { LoadSystem } from '../evaluate/types';
import { factTime, HISTORIES, workingLine, workoutFact } from '../periodisation/histories';
import type { FactHistory } from '../periodisation/histories';
import { PRD_WEEKS, weekDay } from '../periodisation/weeks';
import { HALF_LIVES, HISTORY, RATIO, RESIDUAL } from '../rules/fatigue';
import { RULE_BY_ID } from '../rules/registry/index';
import { SCENARIO_START } from '../scenarios';
import { loadModel, overloadedDays, readinessOn, weekSummary } from './fatigue';
import type { FatigueDay, ModelLogged, ModelPlanned } from './fatigue';
import { fromLogged } from './from-facts';
import { fromPlanned, sumByDay, systemLoads } from './systems';

const logs = (h: FactHistory) => fromLogged({ ...h, timeZone: 'UTC' });
const sunday = (h: FactHistory) => addDays(h.lastWeek, 6);

/** A history's days, from its first Monday to `to` (its last Sunday by default), nothing planned. */
function historyModel(h: FactHistory, planned: ModelPlanned[] = [], to = sunday(h)) {
	return loadModel({
		planned,
		logged: logs(h),
		from: h.firstWeek,
		to,
		today: addDays(sunday(h), 1)
	});
}

const levelsOf = (days: readonly FatigueDay[], system: LoadSystem) =>
	days.map((d) => d.systems[system].level);

const plannedStrength = (date: IsoDate, key: string, sets: number, setRpe: number, over = {}) =>
	({
		kind: 'strength',
		date,
		timeOfDay: null,
		orderInDay: 1,
		type: 'strength',
		title: `${key} ${date}`,
		discipline: 'strength',
		intensity: 'hard',
		estMinutes: 60,
		source: 'generator',
		targetRpe: 8,
		exercises: [{ exercise: { key }, sets: [workingLine(sets, 5, setRpe)] }],
		...over
	}) as ModelPlanned;

const pads = (date: IsoDate, rpe: number, minutes = 60) =>
	({
		kind: 'other',
		date,
		timeOfDay: 'evening',
		orderInDay: 1,
		type: 'muay_thai',
		title: 'Muay Thai pads',
		discipline: 'muay_thai',
		intensity: 'hard',
		estMinutes: minutes,
		source: 'commitment',
		targetRpe: rpe,
		details: { kind: 'pad_work' }
	}) as ModelPlanned;

describe('the ratio', () => {
	it('is M1’s acuteChronicRatio over each system’s own series, and null under 28 days', () => {
		const h = HISTORIES.steady();
		const days = historyModel(h);
		const byDay = new Map(sumByDay(logs(h)).map((d) => [d.date, d.bySystem]));
		const start = h.firstWeek;
		for (const system of SYSTEMS) {
			const series: number[] = [];
			days.forEach((day, i) => {
				series.push(byDay.get(day.date)?.[system] ?? 0);
				const m1 = acuteChronicRatio(series, 7, 28);
				expect(day.systems[system].ratio, `${system} ${day.date}`).toBe(m1?.ratio ?? null);
				if (daysBetween(start, day.date) + 1 < 28) expect(day.systems[system].ratio).toBeNull();
				if (i === 27 && system !== 'combat') expect(day.systems[system].ratio).not.toBeNull();
			});
		}
		expect(RATIO).toMatchObject({ acuteDays: 7, chronicDays: 28 });
	});
});

describe('a short history (20 days)', () => {
	const h = HISTORIES.shortHistory();
	const week = PRD_WEEKS.clean_hybrid_week();
	const days = loadModel({
		planned: week,
		logged: logs(h),
		from: h.firstWeek,
		to: addDays(SCENARIO_START, 6),
		today: SCENARIO_START
	});

	it('has no ratio, through day 27, so its levels come from the residual alone', () => {
		const first = logs(h)
			.map((s) => s.date)
			.sort()[0]!;
		const history = days.filter((d) => d.date >= first);
		expect(history.length).toBe(27);
		for (const day of history) for (const s of SYSTEMS) expect(day.systems[s].ratio).toBeNull();
		// Days 14 to 27 of the history included.
		expect(daysBetween(first, history.at(-1)!.date) + 1).toBe(27);
	});

	it('judges each system against the plan’s hardest session that week', () => {
		const loads = week.map((s) => systemLoads(fromPlanned(s)).loads!);
		for (const s of SYSTEMS) {
			const hardest = Math.max(...loads.map((l) => l[s]));
			for (const day of days) expect(day.systems[s].typical).toBe(hardest || null);
		}
		for (const day of days) {
			for (const s of SYSTEMS) {
				const { residual, typical, level } = day.systems[s];
				const times = residual / typical!;
				const expected =
					times > RESIDUAL.overloaded
						? 'overloaded'
						: times > RESIDUAL.elevated
							? 'elevated'
							: 'fresh';
				expect(level, `${s} ${day.date}`).toBe(expected);
			}
		}
		// Not every day reads fresh: the levels are judged, not defaulted.
		expect(days.some((d) => SYSTEMS.some((s) => d.systems[s].level !== 'fresh'))).toBe(true);
	});

	it('never divides by zero: with no plan, or a plan that never loads a system, it reads fresh', () => {
		const none = loadModel({
			planned: [],
			logged: logs(h),
			from: h.firstWeek,
			to: sunday(h),
			today: addDays(sunday(h), 1)
		});
		const upperOnly = loadModel({
			planned: [plannedStrength(SCENARIO_START, 'bench_press', 4, 7)],
			logged: logs(h),
			from: h.firstWeek,
			to: SCENARIO_START,
			today: SCENARIO_START
		});
		for (const day of [...none, ...upperOnly]) {
			for (const s of SYSTEMS) {
				const system = day.systems[s];
				// The plan's typical hard session stands for every day before 28 days of history.
				if (s === 'upper' && upperOnly.includes(day)) {
					expect(system.typical).toBe(480);
				} else {
					expect(system.typical, `${s} ${day.date}`).toBeNull();
					expect(system.level).toBe('fresh');
				}
				for (const value of Object.values(system)) {
					if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
				}
			}
		}
		expect(readinessOn(none, sunday(h), 'lower').reasons).toEqual([
			'Lower body has no typical hard session to judge its fatigue against yet.'
		]);
	});
});

describe('a projection past 28 days', () => {
	it('keeps judging against the plan with no logs, and against the logs up to today', () => {
		const daily = (start: IsoDate) =>
			Array.from({ length: 35 }, (_, i) => ({
				...pads(addDays(start, i), 7),
				title: `pads ${i}`
			}));
		const planOnly = loadModel({
			planned: daily(SCENARIO_START),
			logged: [],
			from: SCENARIO_START,
			to: addDays(SCENARIO_START, 34),
			today: SCENARIO_START
		});
		// Daily pads stack combat's residual past 3 × a session, and it stays so past day 28.
		const session = planOnly[0]!.systems.combat.residual;
		for (const day of planOnly.slice(4)) {
			expect(day.systems.combat.typical, day.date).toBe(session);
			expect(day.systems.combat.level, day.date).toBe('overloaded');
		}
		const h = HISTORIES.steady();
		const today = addDays(sunday(h), 1);
		const ahead = loadModel({
			planned: daily(today),
			logged: logs(h),
			from: h.firstWeek,
			to: addDays(today, 34),
			today
		});
		const typical = ahead.find((d) => d.date === today)!.systems.combat.typical;
		expect(typical).not.toBeNull();
		expect(ahead.at(-1)!.systems.combat).toMatchObject({ typical, level: 'overloaded' });
	});
});

describe('the residual', () => {
	it('halves after one half-life', () => {
		const bench = plannedStrength(SCENARIO_START, 'bench_press', 4, 7);
		const load = systemLoads(fromPlanned(bench)).loads!.upper;
		const days = loadModel({
			planned: [bench],
			logged: [],
			from: SCENARIO_START,
			to: addDays(SCENARIO_START, 4),
			today: SCENARIO_START
		});
		expect(load).toBe(480);
		expect(HALF_LIVES.upper.days).toBe(2);
		expect(days.map((d) => d.systems.upper.residual)).toEqual(
			[480, 480 / Math.SQRT2, 240, 240 / Math.SQRT2, 120].map((n) => expect.closeTo(n, 9))
		);
	});

	it('stacks two hard lower days', () => {
		// Leg press at RPE 7: every hard set lower body, none heavy, so all 480 AU is lower.
		const legs = (date: IsoDate) => plannedStrength(date, 'leg_press', 4, 7, { title: date });
		const days = loadModel({
			planned: [legs(SCENARIO_START), legs(addDays(SCENARIO_START, 1))],
			logged: [],
			from: SCENARIO_START,
			to: addDays(SCENARIO_START, 1),
			today: SCENARIO_START
		});
		// 480 + 480 × 2^(-1 / 2.5): 480 + 363.77 by hand.
		expect(days[0]!.systems.lower.residual).toBe(480);
		expect(days[1]!.systems.lower.residual).toBeCloseTo(843.77, 2);
	});
});

const allFacts = () => {
	const h = HISTORIES.steady();
	const extra = [
		workoutFact({
			id: 'no-rpe',
			sessionType: 'strength',
			startedAt: factTime(h.firstWeek, 120),
			sessionRpe: null
		}),
		workoutFact({
			id: 'neither',
			sessionType: 'conditioning',
			startedAt: factTime(addDays(h.firstWeek, 2)),
			durationSeconds: null,
			sessionRpe: null
		})
	];
	return { ...h, workouts: [...h.workouts, ...extra, ...HISTORIES.declining().workouts] };
};

describe('logged totals', () => {
	it('are M6’s dailyLoads for the same facts, with the same unknown days', () => {
		const h = allFacts();
		const m6 = dailyLoads(sessionLoads(h.workouts, 'UTC'), h.firstWeek, sunday(h));
		const days = historyModel(h);
		expect(days.map((d) => d.date)).toEqual(m6.map((d) => d.date));
		days.forEach((day, i) => {
			const theirs = m6[i]!;
			if (theirs.load === null) expect(day.total, day.date).toBeNull();
			else expect(day.total, day.date).toBeCloseTo(theirs.load, 9);
			expect(day.unknown.length, day.date).toBe(theirs.unknown);
		});
		expect(days[2]!).toMatchObject({ total: null, unknown: ['neither'] });
		expect(days[0]!.unknown).toEqual(['no-rpe']);
	});

	it('total a week of only unknown loads and rest days as null, as M6 does', () => {
		const today = '2026-11-04';
		const monday = '2026-10-26';
		const workouts = [
			workoutFact({ id: 'unrated', sessionType: 'strength', startedAt: factTime(monday) })
		].map((w) => ({ ...w, sessionRpe: null }));
		const m6 = weeklyLoad(sessionLoads(workouts, 'UTC'), periodWindow(today, '4w', null));
		const week = (logged: ModelLogged[]) =>
			weekSummary(loadModel({ planned: [], logged, from: monday, to: addDays(monday, 6), today }));
		expect(m6.weeks.at(-1)).toMatchObject({ weekStart: monday, load: null });
		expect(week(fromLogged({ workouts, sets: [], runs: [], timeZone: 'UTC' })).total).toBeNull();
		expect(week([]).total).toBe(0);
	});
});

describe('planned and logged together', () => {
	const monday = SCENARIO_START;
	const tuesday = addDays(monday, 1);
	const done = { ...plannedStrength(monday, 'back_squat', 4, 8), lineage: 'squat-mon' };
	const missed = { ...plannedStrength(tuesday, 'deadlift', 3, 8), lineage: 'dl-tue' };
	const skipped = {
		...plannedStrength(addDays(monday, 3), 'leg_press', 4, 7),
		lineage: 'lp-thu',
		status: 'skipped' as const
	};
	const { targetRpe: _, ...noTarget } = pads(addDays(monday, 4), 7);
	const estimated = { ...(noTarget as ModelPlanned), lineage: 'pads-fri' };
	const logged = fromLogged({
		workouts: [
			workoutFact({
				id: 'w-mon',
				sessionType: 'strength',
				startedAt: factTime(monday),
				plannedLineage: 'squat-mon',
				sessionRpe: 9
			})
		],
		sets: [],
		runs: [],
		timeZone: 'UTC'
	});
	const days = loadModel({
		planned: [done, missed, skipped, estimated],
		logged,
		from: monday,
		to: addDays(monday, 6),
		today: addDays(monday, 2)
	});
	const sum = (day: FatigueDay, key: 'logged' | 'planned' | 'estimated') =>
		SYSTEMS.reduce((t, s) => t + day.systems[s][key], 0);

	it('counts a completed planned session once, as logged', () => {
		expect(days[0]).toMatchObject({ source: 'logged', total: 540, missed: [] });
		expect(sum(days[0]!, 'logged')).toBeCloseTo(540, 9);
		expect(sum(days[0]!, 'planned')).toBe(0);
	});

	it('counts an unlogged past session 0 and names it missed; a skipped one never counts', () => {
		expect(days[1]).toMatchObject({ source: 'missed', total: 0, missed: [missed.title] });
		expect(sum(days[1]!, 'planned') + sum(days[1]!, 'logged')).toBe(0);
		expect(days[3]).toMatchObject({ source: null, total: 0, missed: [] });
		expect(sum(days[3]!, 'planned')).toBe(0);
	});

	it('keeps estimated load in its own series, never in a logged total', () => {
		expect(days[4]).toMatchObject({ source: 'planned', total: 0, estimated: 60 * 7 });
		expect(sum(days[4]!, 'estimated')).toBeCloseTo(420, 9);
		expect(sum(days[4]!, 'planned') + sum(days[4]!, 'logged')).toBe(0);
		// It still tires the body: the residual projects it.
		expect(days[4]!.systems.combat.residual).toBeGreaterThan(days[3]!.systems.combat.residual);
		const summary = weekSummary(days);
		expect(summary).toMatchObject({
			total: 540,
			estimated: 420,
			missed: [missed.title],
			unknown: []
		});
	});

	it('counts today’s planned session until it is logged, and a mixed day as mixed', () => {
		const today = addDays(monday, 2);
		const extra = { ...plannedStrength(today, 'bench_press', 3, 7), lineage: 'bench-wed' };
		const unplanned = fromLogged({
			workouts: [workoutFact({ id: 'run', sessionType: 'easy_run', startedAt: factTime(today) })],
			sets: [],
			runs: [],
			timeZone: 'UTC'
		});
		const [day] = loadModel({ planned: [extra], logged: unplanned, from: today, to: today, today });
		expect(day).toMatchObject({ source: 'mixed', total: 420 });
		expect(sum(day!, 'planned')).toBeCloseTo(480, 9);
	});
});

describe('the PRD histories', () => {
	it('hardCampWeek: Monday’s hard sparring leaves Tuesday’s lower body and combat elevated or above (S10)', () => {
		const h = HISTORIES.hardCampWeek(1);
		const tuesday = addDays(h.firstWeek, 1);
		// The camp week's plan: heavy squats on Tuesday (PRD §5's Lower A), the usual pads on Thursday.
		const lowerA = { ...PRD_WEEKS.squat_before_sparring()[0]!, date: tuesday };
		const days = loadModel({
			planned: [lowerA, pads(weekDay(3), 6)],
			logged: logs(h),
			from: h.firstWeek,
			to: sunday(h),
			today: tuesday
		});
		const day = days.find((d) => d.date === tuesday)!;
		// Lower: the squats (327 AU at their estimated RPE 7, the week's hardest) plus the 72 AU
		// sparring left, 1.22 ×. Combat: sparring's 476 AU halved over 2 days is 337 after one,
		// against the usual pads' 257, 1.31 ×.
		expect(['elevated', 'overloaded']).toContain(day.systems.lower.level);
		expect(['elevated', 'overloaded']).toContain(day.systems.combat.level);
		expect(day.systems.combat.ratio).toBeNull();
		// Monday itself: 90 minutes at RPE 9 overloads combat on the day.
		expect(days[0]!.systems.combat.level).toBe('overloaded');
	});

	it('declining overloads the nervous system: harder sets at the same loads', () => {
		const h = HISTORIES.declining();
		const days = historyModel(h);
		const window = { from: addDays(h.lastWeek, -14), to: sunday(h) };
		expect(overloadedDays(days, 'cns', window).length).toBeGreaterThan(0);
		for (const s of ['lower', 'upper', 'aerobic', 'combat'] as const)
			expect(overloadedDays(days, s, window), s).toEqual([]);
	});

	it('overreachingRun overloads the aerobic system and the legs', () => {
		const h = HISTORIES.overreachingRun();
		const days = historyModel(h);
		const window = { from: addDays(h.lastWeek, -7), to: sunday(h) };
		const aerobic = overloadedDays(days, 'aerobic', window);
		expect(aerobic).toContain(addDays(h.lastWeek, 5));
		expect(overloadedDays(days, 'lower', window).length).toBeGreaterThan(0);
		// Its first four weeks of 40 km are steady.
		const base = { from: h.firstWeek, to: addDays(h.firstWeek, 27) };
		for (const s of SYSTEMS) expect(overloadedDays(days, s, base), s).toEqual([]);
	});

	// "Fresh" is readiness: a steady week's hard days end elevated (lower 1.53 ×, above RESIDUAL's
	// 1.2 ×, which hardCampWeek's 1.22 × Tuesday needs), but every day starts fresh.
	it('steady stays fresh: never overloaded, and fresh at the start of every day', () => {
		const h = HISTORIES.steady();
		const days = historyModel(h, [], addDays(sunday(h), 1));
		for (const s of SYSTEMS) {
			expect(levelsOf(days, s), s).not.toContain('overloaded');
			for (const day of days)
				expect(readinessOn(days, day.date, s).level, `${s} ${day.date}`).toBe('fresh');
		}
		expect(
			Object.values(weekSummary(days.slice(-8, -1)).systems).map((x) => x.worst)
		).not.toContain('overloaded');
	});
});

describe('readinessOn', () => {
	it('reads the fatigue carried in from the day before, with its reasons', () => {
		const h = HISTORIES.declining();
		const days = historyModel(h);
		const monday = addDays(h.lastWeek, -7);
		const tuesday = addDays(monday, 1);
		const before = days.find((d) => d.date === monday)!.systems.cns;
		const ready = readinessOn(days, tuesday, 'cns');
		expect(ready.residual).toBeCloseTo(before.residual * 2 ** (-1 / HALF_LIVES.cns.days), 9);
		expect(ready.ratio).toBe(before.ratio);
		expect(ready.level).toBe('overloaded');
		expect(ready.reasons[0]).toMatch(/^Nervous system carries \d+\.\d × its typical hard session/);
		expect(readinessOn(days, h.firstWeek, 'cns').residual).toBe(0);
		expect(() => readinessOn(days, '2030-01-01', 'cns')).toThrow(RangeError);
	});

	it('lets the ratio raise a system by one level only while it carries a hard session', () => {
		const rules = { ratio: RATIO, residual: RESIDUAL };
		const h = HISTORIES.steady();
		const days = historyModel(h);
		// Thursday's pads: one weekly session spikes combat's ratio to about 1.8 every week.
		const thursday = days.find((d) => d.date === addDays(h.lastWeek, 3))!.systems.combat;
		expect(thursday.ratio!).toBeGreaterThan(RATIO.overloaded);
		expect(thursday.residual / thursday.typical!).toBeLessThan(RESIDUAL.elevated);
		expect(thursday.level).toBe('elevated');
		expect(readinessOn(days, addDays(h.lastWeek, 4), 'combat', rules).level).toBe('fresh');
	});
});

describe('the model', () => {
	const original = process.env.TZ;
	afterEach(() => {
		process.env.TZ = original;
	});

	it('is deterministic and date-only: the same output in any process time zone', () => {
		const run = () => {
			const h = HISTORIES.declining();
			return JSON.stringify(
				historyModel(h, PRD_WEEKS.clean_hybrid_week(), addDays(SCENARIO_START, 6))
			);
		};
		const outputs = ['UTC', 'Pacific/Kiritimati', 'America/Los_Angeles', 'Asia/Kolkata'].map(
			(tz) => {
				process.env.TZ = tz;
				return run();
			}
		);
		expect(new Set(outputs).size).toBe(1);
		expect(run()).toBe(outputs[0]);
	});

	it('refuses a range that ends before it starts', () => {
		expect(() =>
			loadModel({
				planned: [],
				logged: [],
				from: SCENARIO_START,
				to: '2026-01-01',
				today: SCENARIO_START
			})
		).toThrow(RangeError);
	});

	it('is registered: half-lives, ratio, residual, history and the planned-or-logged rule', () => {
		expect(RULE_BY_ID.get('fatigue.half_lives')).toMatchObject({
			area: 'fatigue',
			values: HALF_LIVES
		});
		expect(RULE_BY_ID.get('fatigue.ratio')).toMatchObject({ area: 'fatigue', values: RATIO });
		expect(RULE_BY_ID.get('fatigue.residual')).toMatchObject({ area: 'fatigue', values: RESIDUAL });
		expect(RULE_BY_ID.get('fatigue.history')).toMatchObject({ area: 'fatigue', values: HISTORY });
		expect(RULE_BY_ID.get('fatigue.model')).toMatchObject({ area: 'fatigue', kind: 'behaviour' });
	});
});
