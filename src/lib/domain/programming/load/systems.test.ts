import { describe, expect, it } from 'vitest';
import { dailyLoads, sessionLoads } from '../../analytics/workload';
import type { LoggedSession } from '../../analytics/workload';
import { CATALOGUE } from '../../exercises/index';
import { sessionLoadOf } from '../../training/metrics';
import type { RunSegment } from '../../training/types';
import { OTHER_SESSION_KINDS, SESSION_TYPES, sessionTone } from '../../training/vocabulary';
import type { OtherSessionKind, SessionType } from '../../training/vocabulary';
import { SYSTEMS } from '../evaluate/types';
import type { LoadSystem } from '../evaluate/types';
import { buildProgrammingInput, generateProgram } from '../index';
import { factTime, HISTORIES, workingLine, workoutFact } from '../periodisation/histories';
import { DEFAULT_RPE, SYSTEM_SHARES } from '../rules/load';
import { RULE_BY_ID } from '../rules/registry/index';
import { SCENARIO_START, SCENARIOS } from '../scenarios';
import { fromPlanned, sumByDay, systemLoads } from './systems';
import type { LoadSession, PlannedSession } from './systems';

const DAY = '2026-11-09';

const plannedBase = {
	date: DAY,
	timeOfDay: null,
	orderInDay: 1,
	title: 'Session',
	intensity: 'hard',
	estMinutes: 60,
	source: 'generator',
	targetRpe: 8
} as const;

const lift = (key: string, sets: number, rpe: number) => ({
	exercise: { key },
	sets: [workingLine(sets, 5, rpe)]
});

const strength = (exercises: ReturnType<typeof lift>[], over: Partial<PlannedSession> = {}) =>
	({
		...plannedBase,
		kind: 'strength',
		type: 'strength',
		discipline: 'strength',
		exercises,
		...over
	}) as PlannedSession;

const segment = (kind: RunSegment['kind'], distanceMetres: number | null = null) => ({
	kind,
	repeatGroup: null,
	repeats: null,
	distanceMetres,
	durationSeconds: null,
	paceMinSecondsPerKm: null,
	paceMaxSecondsPerKm: null,
	hrZone: null,
	targetRpe: null
});

const run = (
	type: SessionType,
	segments: ReturnType<typeof segment>[],
	over: Partial<PlannedSession> = {}
) =>
	({
		...plannedBase,
		kind: 'run',
		type,
		discipline: 'running',
		intensity: 'moderate',
		segments,
		...over
	}) as PlannedSession;

const other = (type: SessionType, format: OtherSessionKind, over: Partial<PlannedSession> = {}) =>
	({
		...plannedBase,
		kind: 'other',
		type,
		discipline: type === 'muay_thai' ? 'muay_thai' : 'custom',
		details: { kind: format, durationMinutes: 60, targetRpe: 8, metrics: [], notes: null },
		...over
	}) as PlannedSession;

const loadsOf = (session: PlannedSession) => systemLoads(fromPlanned(session));
const sumOf = (record: Readonly<Record<LoadSystem, number>>) =>
	SYSTEMS.reduce((total, system) => total + record[system], 0);

/** Shares as weights over their sum, the way rules/load.ts states them. */
const normalised = (weights: Partial<Record<LoadSystem, number>>) => {
	const total = Object.values(weights).reduce((a, b) => a + b, 0);
	return Object.fromEntries(SYSTEMS.map((s) => [s, (weights[s] ?? 0) / total]));
};

const expectShares = (actual: Record<LoadSystem, number>, expected: Record<string, number>) => {
	for (const system of SYSTEMS) expect(actual[system], system).toBeCloseTo(expected[system]!, 12);
};

describe('a session’s split across the five systems', () => {
	it('a heavy squat day loads lower and CNS, not upper; a bench day loads upper', () => {
		const squat = loadsOf(strength([lift('back_squat', 5, 8.5)]));
		expect(squat.status).toBe('planned');
		expect(squat.basis).toBe(60 * 8);
		// Weights: lower 1 (every hard set), CNS 1 × 0.5 (every hard set heavy).
		expectShares(squat.shares, normalised({ lower: 1, cns: 0.5 }));
		expect(squat.loads!.upper).toBe(0);
		expect(squat.loads!.lower).toBeCloseTo(320, 9);
		expect(squat.loads!.cns).toBeCloseTo(160, 9);

		const bench = loadsOf(strength([lift('bench_press', 4, 7)]));
		expectShares(bench.shares, normalised({ upper: 1 }));
		expect(bench.loads!.lower).toBe(0);
		expect(bench.loads!.upper).toBe(480);
	});

	it('splits a mixed day by where its hard sets are, and only heavy compound sets reach CNS', () => {
		const day = fromPlanned(
			strength([lift('back_squat', 3, 8), lift('bench_press', 3, 7), lift('lying_leg_curl', 2, 7)])
		);
		expect(day.kind === 'strength' && day.sets).toEqual({
			lower: { hard: 5, heavy: 3 },
			upper: { hard: 3, heavy: 0 }
		});
		expectShares(systemLoads(day).shares, normalised({ lower: 5 / 8, upper: 3 / 8, cns: 3 / 16 }));
	});

	it('a long run loads aerobic, with lower-body impact, and so does any run of 90 minutes', () => {
		const long = fromPlanned(run('long_run', [segment('long', 25_000)]));
		expect(long).toMatchObject({ kind: 'run', long: true, intervals: false, metres: 25_000 });
		const shares = normalised({ aerobic: 1, lower: 0.3 });
		expectShares(systemLoads(long).shares, shares);
		const longEasy = loadsOf(run('easy_run', [segment('easy')], { estMinutes: 95 }));
		expectShares(longEasy.shares, shares);
		const easy = loadsOf(run('easy_run', [segment('easy')]));
		expectShares(easy.shares, normalised({ aerobic: 1, lower: 0.15 }));
		expect(easy.loads!.cns).toBe(0);
	});

	it('intervals add CNS, an interval segment in any run included; sparring loads combat and CNS', () => {
		const intervals = loadsOf(run('interval_run', [segment('interval', 800)]));
		expectShares(intervals.shares, normalised({ aerobic: 1, lower: 0.35, cns: 0.3 }));
		const fartlek = loadsOf(run('easy_run', [segment('easy'), segment('interval')]));
		expectShares(fartlek.shares, intervals.shares);

		const sparring = loadsOf(other('muay_thai', 'sparring'));
		expectShares(sparring.shares, normalised({ combat: 1, lower: 0.2, cns: 0.5 }));
		const pads = loadsOf(other('muay_thai', 'pad_work'));
		expectShares(pads.shares, normalised({ combat: 1, lower: 0.2, cns: 0.2 }));
		const technical = loadsOf(other('muay_thai', 'technical'));
		expectShares(technical.shares, normalised({ combat: 1, lower: 0.2 }));
		expect(technical.loads!.cns).toBe(0);
	});

	it('mobility loads no system, though its sRPE is counted; a strength class splits its load', () => {
		const mobility = loadsOf(other('mobility', 'mobility', { targetRpe: 3 }));
		expect(mobility.basis).toBe(180);
		expect(mobility.loads).toEqual(Object.fromEntries(SYSTEMS.map((s) => [s, 0])));
		expect(sumOf(mobility.shares)).toBe(0);

		const strengthClass = loadsOf(other('strength_class', 'class'));
		expectShares(strengthClass.shares, { lower: 0.4, upper: 0.4, cns: 0.2, aerobic: 0, combat: 0 });
		const conditioning = loadsOf(other('conditioning', 'conditioning'));
		expectShares(conditioning.shares, normalised({ aerobic: 0.6, cns: 0.3 }));
		const custom = loadsOf(other('custom', 'custom'));
		expectShares(custom.shares, normalised({ aerobic: 0.5 }));
	});

	it('a strength session whose sets name no region splits evenly between lower and upper', () => {
		const unknown = loadsOf(strength([lift('my_own_lift', 4, 8)]));
		expectShares(unknown.shares, normalised({ lower: 1, upper: 1 }));
	});
});

/** One session of each type, of the kind it is planned as. */
const ofType = (type: SessionType): PlannedSession => {
	if (['strength', 'hypertrophy', 'power'].includes(type))
		return strength([lift('back_squat', 3, 8), lift('bench_press', 3, 7)], { type });
	if (sessionTone(type) === 'running') return run(type, [segment('easy')]);
	return other(type, type === 'muay_thai' ? 'sparring' : 'class');
};

describe('every session type', () => {
	it('has a share rule with its reason, and a default RPE', () => {
		expect(Object.keys(SYSTEM_SHARES).sort()).toEqual([...SESSION_TYPES].sort());
		expect(Object.keys(DEFAULT_RPE).sort()).toEqual([...SESSION_TYPES].sort());
		for (const type of SESSION_TYPES) {
			expect(SYSTEM_SHARES[type].why.length, type).toBeGreaterThan(20);
			expect(DEFAULT_RPE[type], type).toBeGreaterThanOrEqual(1);
			expect(DEFAULT_RPE[type], type).toBeLessThanOrEqual(10);
		}
	});

	it.each(
		SESSION_TYPES.flatMap((type) =>
			OTHER_SESSION_KINDS.map((format): [SessionType, OtherSessionKind] => [type, format])
		)
	)('%s (%s): its shares add to 1, and its loads to its basis', (type, format) => {
		const session = ofType(type).kind === 'other' ? other(type, format) : ofType(type);
		const result = loadsOf(session);
		if (type === 'mobility') {
			expect(sumOf(result.shares)).toBe(0);
			return;
		}
		expect(sumOf(result.shares)).toBeCloseTo(1, 12);
		expect(sumOf(result.loads!)).toBeCloseTo(result.basis!, 9);
		for (const system of SYSTEMS) expect(result.shares[system]).toBeGreaterThanOrEqual(0);
	});

	it('is registered: the shares, the default RPE and the unknown-load rule', () => {
		expect(RULE_BY_ID.get('load.system_shares')).toMatchObject({
			area: 'load',
			values: SYSTEM_SHARES
		});
		expect(RULE_BY_ID.get('load.default_rpe')).toMatchObject({ area: 'load', values: DEFAULT_RPE });
		expect(RULE_BY_ID.get('load.unknown')).toMatchObject({ area: 'load', kind: 'behaviour' });
	});
});

// ---- Logged sessions, on M6's basis ----------------------------------------------------------

/** A logged session as from-facts will give it: M6's sessionLoads minutes and RPE for the fact. */
function logged(fact: LoggedSession): LoadSession {
	const [m6] = sessionLoads([fact], 'UTC');
	const base = {
		date: m6!.date,
		timeOfDay: null,
		orderInDay: 1,
		type: fact.sessionType,
		title: fact.title,
		discipline: 'strength',
		intensity: null,
		minutes: m6!.minutes,
		rpe: m6!.rpe,
		source: 'logged'
	} as const;
	if (fact.run) return { ...base, kind: 'run', metres: null, intervals: false, long: false };
	if (fact.other) return { ...base, kind: 'other', format: fact.other.kind, rounds: null };
	const none = { hard: 0, heavy: 0 };
	return { ...base, kind: 'strength', sets: { lower: none, upper: none } };
}

const unknownFacts = (): LoggedSession[] => [
	workoutFact({
		id: 'no-rpe',
		sessionType: 'strength',
		startedAt: factTime(DAY),
		sessionRpe: null
	}),
	workoutFact({
		id: 'no-duration',
		sessionType: 'conditioning',
		startedAt: factTime(DAY, 90),
		durationSeconds: null
	}),
	workoutFact({
		id: 'neither',
		sessionType: 'easy_run',
		startedAt: factTime(DAY, 180),
		durationSeconds: null,
		sessionRpe: null,
		run: { durationSeconds: null, rpe: null }
	})
];

const allFacts = (): LoggedSession[] => [
	...Object.values(HISTORIES).flatMap((history) => history().workouts),
	workoutFact({
		id: 'pads',
		sessionType: 'muay_thai',
		startedAt: factTime('2026-11-10'),
		durationSeconds: null,
		sessionRpe: null,
		other: { kind: 'pad_work', durationMinutes: 45, rpe: 7, metrics: [] }
	}),
	...unknownFacts()
];

describe('a logged session', () => {
	it('has M6’s sessionLoads for the same fact as its basis, the run’s and other record’s RPE included', () => {
		const facts = allFacts();
		const m6 = sessionLoads(facts, 'UTC');
		expect(m6.some((l) => l.rpeFrom === 'run')).toBe(true);
		expect(m6.some((l) => l.rpeFrom === 'other')).toBe(true);
		facts.forEach((fact, n) => {
			const result = systemLoads(logged(fact));
			expect(result.basis, fact.id).toBe(m6[n]!.load);
			expect(result.status, fact.id).toBe(m6[n]!.load === null ? 'unknown' : 'logged');
		});
	});

	it('is unknown, never 0, when M6 calls its load unknown, and says what it lacks', () => {
		const [noRpe, noDuration, neither] = unknownFacts().map((f) => systemLoads(logged(f)));
		for (const result of [noRpe!, noDuration!, neither!]) {
			expect(result).toMatchObject({ status: 'unknown', loads: null, basis: null });
		}
		expect(noRpe!.why.at(-1)).toMatch(/^It has no RPE, so its load is unknown/);
		expect(noDuration!.why.at(-1)).toMatch(/^It has no duration, so its load is unknown/);
		expect(neither!.why.at(-1)).toBe(
			'It has no RPE or duration, so its load is unknown: counted and named, never taken as 0.'
		);
	});

	it('sums by day as M6’s dailyLoads does, the unknown counted and left out of the total', () => {
		const facts = allFacts();
		const m6 = sessionLoads(facts, 'UTC');
		const dates = m6.map((l) => l.date).sort();
		const theirs = dailyLoads(m6, dates[0]!, dates.at(-1)!).filter((d) => d.sessions > 0);
		const ours = sumByDay(facts.map(logged));
		expect(ours.map((d) => d.date)).toEqual(theirs.map((d) => d.date));
		ours.forEach((day, n) => {
			expect(day.unknown, day.date).toBe(theirs[n]!.unknown);
			const load = theirs[n]!.load;
			if (load === null) expect(day.total, day.date).toBeNull();
			else expect(day.total, day.date).toBeCloseTo(load, 9);
			expect(day.estimated).toBe(0);
		});
		const unknownDay = ours.find((d) => d.date === DAY)!;
		expect(unknownDay.unknown).toBe(3);
	});

	it('leaves a day of only unknown loads with no total, as M6 does, never 0', () => {
		const facts = unknownFacts();
		const [theirs] = dailyLoads(sessionLoads(facts, 'UTC'), DAY, DAY);
		const [ours] = sumByDay(facts.map(logged));
		expect(theirs).toMatchObject({ load: null, unknown: 3 });
		expect(ours).toMatchObject({ date: DAY, total: theirs!.load, unknown: 3 });
	});
});

// ---- Planned sessions ------------------------------------------------------------------------

describe('a planned session', () => {
	it('with no target RPE is estimated at the default RPE, flagged, and kept apart', () => {
		const { targetRpe: _, ...noTarget } = run('tempo_run', [segment('tempo')]) as PlannedSession & {
			targetRpe?: number;
		};
		const result = loadsOf(noTarget as PlannedSession);
		expect(result).toMatchObject({ status: 'estimated', rpe: DEFAULT_RPE.tempo_run });
		expect(result.basis).toBe(60 * DEFAULT_RPE.tempo_run);
		expect(result.why.at(-1)).toMatch(/no target RPE, so its load is estimated at RPE 7/);

		const withTarget = run('tempo_run', [segment('tempo')], { date: DAY, orderInDay: 2 });
		const [day] = sumByDay([fromPlanned(noTarget as PlannedSession), fromPlanned(withTarget)]);
		expect(day).toMatchObject({ estimated: 60 * DEFAULT_RPE.tempo_run, total: 480, unknown: 0 });
		expect(sumOf(day!.bySystem)).toBeCloseTo(480, 9);
	});

	it('maps every M3 scenario’s planned sessions without error, at their estimated load', () => {
		for (const key of Object.keys(SCENARIOS) as (keyof typeof SCENARIOS)[]) {
			const input = buildProgrammingInput(SCENARIOS[key](), { catalogue: CATALOGUE });
			const plan = generateProgram(input, {
				startsOn: SCENARIO_START,
				firstPlannedDay: SCENARIO_START
			});
			const sessions = plan.blocks.flatMap((b) => b.weeks.flatMap((w) => w.sessions));
			expect(sessions.length, key).toBeGreaterThan(0);
			for (const session of sessions) {
				const result = systemLoads(fromPlanned(session));
				expect(result.status, `${key} ${session.title}`).toBe('planned');
				expect(result.basis).toBe(sessionLoadOf(session));
				if (session.type === 'mobility') expect(sumOf(result.shares)).toBe(0);
				else expect(sumOf(result.shares)).toBeCloseTo(1, 12);
			}
			const days = sumByDay(sessions.map((s) => fromPlanned(s)));
			for (const day of days)
				expect(sumOf(day.bySystem)).toBeLessThanOrEqual((day.total ?? 0) + 1e-9);
		}
	});
});

describe('the result', () => {
	it('is the same for any input order', () => {
		const sessions = [
			fromPlanned(strength([lift('back_squat', 5, 8.5)], { title: 'Lower A' })),
			fromPlanned(run('easy_run', [segment('easy')], { orderInDay: 2, title: 'Easy' })),
			fromPlanned(run('long_run', [segment('long')], { date: '2026-11-14', title: 'Long' })),
			fromPlanned(other('muay_thai', 'sparring', { date: '2026-11-10', title: 'Sparring' })),
			fromPlanned(other('mobility', 'mobility', { date: '2026-11-10', orderInDay: 2 })),
			...unknownFacts().map(logged)
		];
		const expected = sumByDay(sessions);
		expect(expected.map((d) => d.date)).toEqual(['2026-11-09', '2026-11-10', '2026-11-14']);
		const orders = [
			[...sessions].reverse(),
			[...sessions.slice(3), ...sessions.slice(0, 3)],
			[
				sessions[4]!,
				sessions[1]!,
				sessions[6]!,
				sessions[0]!,
				sessions[7]!,
				sessions[3]!,
				sessions[2]!,
				sessions[5]!
			]
		];
		for (const order of orders) expect(sumByDay(order)).toEqual(expected);
		expect(sessions.map(systemLoads)).toEqual([...sessions].reverse().map(systemLoads).reverse());
	});
});
