/**
 * results.ts: PRD §5's strength, running and fatigue rules as scenarios, each named after its
 * sentence. Exposures are built the way the reviews build them: logged sets matched to their
 * prescription line by analytics/prescribed.ts, then summed up per session.
 */
import { describe, expect, it } from 'vitest';
import { addDays } from '../calendar';
import type { IsoDate } from '../calendar';
import { exposure, matchPrescription } from '../analytics/prescribed';
import type { ActualSet, Exposure } from '../analytics/prescribed';
import { classifyTrend } from '../analytics/trend';
import { loadForTarget } from '../e1rm';
import { decisionPlanSchema } from '../training/schemas';
import type { SetPrescription } from '../training/types';
import { validate } from '../validation';
import { DecisionLog } from './decisions';
import { adaptRunning, decideFromResults, fatigueLevel, rpeCreep } from './results';
import type { ResultContext, ResultTarget } from './results';
import { RESULT_RULES } from './rules/results';

const KG: ResultContext = { unit: 'kg' };
const DAYS: IsoDate[] = ['2026-10-05', '2026-10-12', '2026-10-19'];

/** A working line: `sets` × 5 at RPE 8, 100 kg unless told otherwise. */
const line = (more: Partial<SetPrescription> = {}): SetPrescription => ({
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
	restSeconds: null,
	tempo: null,
	notes: null,
	...more
});

const bench = (more: Partial<SetPrescription> = {}): ResultTarget => ({
	name: 'Bench press',
	line: line(more),
	loadType: 'external',
	pattern: 'horizontal_push'
});
const squat = (more: Partial<SetPrescription> = {}): ResultTarget => ({
	...bench(more),
	name: 'Back squat',
	pattern: 'squat'
});

interface Logged {
	/** Each working set's RPE; null for a set logged without one. */
	rpes: (number | null)[];
	/** Reps missed on the first set. */
	missed?: number;
	/** Sets of the line left undone. */
	undone?: number;
	kg?: number;
}

/** One session of `target`'s line on `day`, logged as `logged` says. */
function session(target: ResultTarget, day: IsoDate, logged: Logged): Exposure {
	const lines = [target.line];
	const done = target.line.sets - (logged.undone ?? 0);
	const sets = Array.from({ length: done }, (_, i): ActualSet => ({
		plannedLineage: 'lineage-1',
		exerciseId: 'ex-1',
		setIndex: i + 1,
		reps:
			target.line.repsMin === null
				? null
				: target.line.repsMin - (i === 0 ? (logged.missed ?? 0) : 0),
		seconds: target.line.seconds,
		metres: null,
		weight: logged.kg ?? target.line.loadValue,
		assistance: null,
		unit: 'kg',
		rpe: logged.rpes[i] ?? null,
		missedReps: i === 0 ? (logged.missed ?? 0) : 0,
		isWarmup: false,
		isExtra: false,
		isSkipped: false
	}));
	const planned = { lineage: 'lineage-1', exerciseId: 'ex-1', lines };
	return exposure(matchPrescription(planned, sets, { unit: 'kg' }), day);
}

/** Sessions of `target` on consecutive weeks, all three sets at each RPE given. */
const sessions = (target: ResultTarget, ...each: (Logged | number | null)[]) =>
	each.map((logged, i) =>
		session(
			target,
			DAYS[i] ?? addDays(DAYS[0]!, 7 * i),
			typeof logged === 'object' && logged !== null ? logged : { rpes: [logged, logged, logged] }
		)
	);

/** A real e1RM decline: 8 weekly points falling 2 kg a week. */
const declining = classifyTrend(
	Array.from({ length: 8 }, (_, i) => ({
		at: addDays('2026-08-03', 7 * i),
		value: 150 - 2 * i,
		inProgress: false
	})),
	{ direction: 'up' }
);

describe('Strength: below target RPE consistently → consider adding load', () => {
	it('3 sessions about 1 under target: +2.5 kg on a 100 kg bench, +5 lb on an lb line', () => {
		const kg = decideFromResults(sessions(bench(), 7, 7, 7), bench(), null, KG);
		expect(kg).toMatchObject({ action: 'add_load', field: 'load', from: 100, to: 102.5, pct: 2.5 });
		expect(kg).toMatchObject({ ruleKey: 'results.below', significant: false, confidence: 'high' });
		expect(kg.line.loadValue).toBe(102.5);
		expect(kg.why).toBe(
			'Bench press felt about an RPE or more easier than prescribed in 3 of the last 3 sessions, so it goes up.'
		);
		expect(kg.evidence).toMatchObject({
			exposures: 3,
			withRpe: 3,
			meanDeviation: -1,
			from: 100,
			to: 102.5
		});

		const lb = bench({ loadValue: 200, loadUnit: 'lb' });
		expect(decideFromResults(sessions(lb, 7, 7, 7), lb, null, { unit: 'lb' })).toMatchObject({
			action: 'add_load',
			from: 200,
			to: 205
		});
	});

	it('a lower-body lift takes +5 % only when all three sessions agree; two of three take +2.5 %', () => {
		const all = decideFromResults(sessions(squat(), 7, 7, 7), squat(), null, KG);
		expect(all).toMatchObject({
			to: 105,
			pct: 5,
			ruleKey: 'results.below_lower',
			significant: true
		});
		const two = decideFromResults(sessions(squat(), 7, 8, 7), squat(), null, KG);
		expect(two).toMatchObject({ to: 102.5, ruleKey: 'results.below', significant: false });
	});

	it('below once → hold: one easy session among two on target is noise', () => {
		const once = decideFromResults(sessions(bench(), 7, 8, 8.5), bench(), null, KG);
		expect(once).toMatchObject({ action: 'hold', ruleKey: 'results.noisy', to: null });
		expect(once.line).toEqual(bench().line);
	});

	it('moves a share of a 1RM as the load it gives, never past M1’s table for its reps', () => {
		const share = bench({
			loadKind: 'percent_1rm',
			loadValue: 0.75,
			loadUnit: null,
			loadBasis: 'measured',
			reference1rm: 140,
			reference1rmUnit: 'kg'
		});
		const up = decideFromResults(sessions(share, 7, 7, 7), share, null, KG);
		// 105 kg × 1.025 → 107.5 kg on the 2.5 kg plates: 76.79 % of 140.
		expect(up).toMatchObject({ action: 'add_load', from: 0.75, to: 0.7679, pct: 2.39 });
		// 5 @ RPE 8 is 81.1 % on M1's table: a share there cannot go up.
		const top = bench({ ...share.line, loadValue: 0.811 });
		expect(decideFromResults(sessions(top, 7, 7, 7), top, null, KG)).toMatchObject({
			action: 'hold',
			ruleKey: 'results.below.at_limit'
		});
	});

	it('moves an RPE-based line half an RPE, with the load M1’s loadForTarget gives', () => {
		const rpe = bench({ loadKind: 'rpe_based', loadValue: null, loadUnit: null });
		const up = decideFromResults(sessions(rpe, 7, 7, 7), rpe, null, { unit: 'kg', e1rmKg: 120 });
		expect(up).toMatchObject({ action: 'add_load', field: 'rpe', from: 8, to: 8.5, pct: null });
		expect(up.evidence.suggestedKg).toBe(Math.round(loadForTarget(120, 5, 8.5)! * 10) / 10);
		const capped = decideFromResults(sessions(rpe, 7, 7, 7), rpe, null, { unit: 'kg', rpeCap: 8 });
		expect(capped).toMatchObject({ action: 'hold', ruleKey: 'results.below.at_limit' });
		// The cap blocks increases only: a target above it still comes down.
		const hard = sessions(rpe, { rpes: [9, 9], undone: 1 }, 9, 8);
		expect(decideFromResults(hard, rpe, null, { unit: 'kg', rpeCap: 7 })).toMatchObject({
			action: 'reduce_load',
			field: 'rpe',
			to: 7.5
		});
	});
});

describe('Strength: above target → reduce load or volume', () => {
	it('above twice, every rep done → a set fewer at the same load', () => {
		const out = decideFromResults(sessions(bench(), 9, 9, 8), bench(), null, KG);
		expect(out).toMatchObject({
			action: 'reduce_volume',
			field: 'sets',
			from: 3,
			to: 2,
			ruleKey: 'results.above_sets'
		});
		expect(out.line.loadValue).toBe(100);
	});

	it('above twice with a set left undone → −2.5 %; above in all three → −5 %', () => {
		const twice = sessions(bench(), { rpes: [9, 9], undone: 1 }, 8, 9);
		expect(decideFromResults(twice, bench(), null, KG)).toMatchObject({
			action: 'reduce_load',
			to: 97.5,
			pct: -2.5,
			ruleKey: 'results.above'
		});
		const all = sessions(bench(), { rpes: [9, 9], undone: 1 }, 9, 9);
		expect(decideFromResults(all, bench(), null, KG)).toMatchObject({
			to: 95,
			pct: -5,
			ruleKey: 'results.above_all',
			significant: true
		});
	});
});

describe('Strength: missed reps → account for it', () => {
	it('missed reps once → hold; in two of three → −5 %', () => {
		const once = sessions(bench(), { rpes: [8, 8, 8], missed: 1 }, 8, 7.5);
		expect(decideFromResults(once, bench(), null, KG)).toMatchObject({
			action: 'hold',
			ruleKey: 'results.missed_once'
		});
		// Missed reps outrank an easy RPE: no load goes up on a session that missed reps.
		const easy = sessions(bench(), { rpes: [7, 7, 7], missed: 1 }, 7, 7);
		expect(decideFromResults(easy, bench(), null, KG)).toMatchObject({
			action: 'hold',
			ruleKey: 'results.missed_once'
		});
		const twice = sessions(bench(), { rpes: [8, 8, 8], missed: 2 }, 8, {
			rpes: [8, 8, 8],
			missed: 1
		});
		expect(decideFromResults(twice, bench(), null, KG)).toMatchObject({
			action: 'reduce_load',
			to: 95,
			ruleKey: 'results.missed_repeat',
			significant: true
		});
	});
});

describe('Strength: declining performance → consider fatigue', () => {
	it('a real e1RM decline with rising RPE: no increase, accessories −1 set, a fatigue flag', () => {
		expect(declining).toMatchObject({ verdict: 'real_trend', direction: 'down' });
		const rising = sessions(bench(), 6.5, 7, 8);
		const out = decideFromResults(rising, bench(), declining, KG);
		expect(out).toMatchObject({
			action: 'hold',
			ruleKey: 'results.decline',
			fatigue: true,
			accessorySets: -1
		});
		expect(out.evidence.trend).toBe('real_trend');
		// The same sessions with no decline go up.
		expect(decideFromResults(rising, bench(), null, KG)).toMatchObject({
			action: 'add_load',
			fatigue: false,
			accessorySets: 0
		});
	});

	it('a decline blocks increases only: missed reps in all three still bring the load down', () => {
		const failing = sessions(
			bench(),
			{ rpes: [7.5, 7.5, 7.5], missed: 1 },
			{ rpes: [8, 8, 8], missed: 1 },
			{ rpes: [8.5, 8.5, 8.5], missed: 1 }
		);
		const out = decideFromResults(failing, bench(), declining, KG);
		expect(out).toMatchObject({
			action: 'reduce_load',
			to: 95,
			ruleKey: 'results.missed_repeat',
			fatigue: true,
			accessorySets: -1
		});
		expect(out.why).not.toMatch(/bigger step/);
	});

	it('a decline without rising RPE is no fatigue flag, but still blocks a significant change', () => {
		const out = decideFromResults(sessions(squat(), 7, 7, 7), squat(), declining, KG);
		expect(out).toMatchObject({
			action: 'add_load',
			to: 102.5,
			significant: false,
			fatigue: false
		});
		expect(out.why).toMatch(/ A bigger step waits for 3 sessions and no real decline\.$/);
	});
});

describe('Strength: use multiple sessions before significant changes', () => {
	it('a single exposure → no change, however easy it was', () => {
		const out = decideFromResults(sessions(squat(), 6), squat(), null, KG);
		expect(out).toMatchObject({ action: 'hold', ruleKey: 'results.single', confidence: 'low' });
		expect(decideFromResults([], squat(), null, KG).why).toBe(
			'Back squat has no session to judge yet, and nothing changes on one session.'
		);
	});

	it('significant changes wait for 3 exposures: missed reps in both of two → −2.5 %, not −5 %', () => {
		const two = sessions(bench(), { rpes: [8, 8, 8], missed: 1 }, { rpes: [8, 8, 8], missed: 1 });
		const out = decideFromResults(two, bench(), null, KG);
		expect(out).toMatchObject({ to: 97.5, pct: -2.5, significant: false, confidence: 'medium' });
		expect(out.why).toMatch(/ A bigger step waits for 3 sessions\.$/);
	});

	it('a step that rounds to a significant one waits too: one plate off 40 kg is −6.25 %', () => {
		const light = bench({ loadValue: 40 });
		const missed = { rpes: [8, 8, 8], missed: 1 };
		expect(decideFromResults(sessions(light, missed, missed), light, null, KG)).toMatchObject({
			action: 'hold',
			ruleKey: 'results.missed_repeat.at_limit'
		});
		expect(decideFromResults(sessions(light, missed, missed, 8), light, null, KG)).toMatchObject({
			action: 'reduce_load',
			to: 37.5,
			pct: -6.25,
			significant: true
		});
	});

	it('at most +5 % or −10 % a week, whatever the table says', () => {
		const rules = { ...RESULT_RULES, belowLower: 8, aboveAll: -15 };
		expect(
			decideFromResults(sessions(squat(), 7, 7, 7), squat(), null, { ...KG, rules })
		).toMatchObject({ to: 105, pct: 5 });
		const heavy = sessions(bench(), { rpes: [9, 9], undone: 1 }, 9, 9);
		expect(decideFromResults(heavy, bench(), null, { ...KG, rules })).toMatchObject({
			to: 90,
			pct: -10
		});
	});

	it('a light lift takes its single smallest step past the weekly cap: 30 kg up, 20 kg down', () => {
		const press = bench({ loadValue: 30 });
		const up = decideFromResults(sessions(press, 7, 7, 7), press, null, KG);
		expect(up).toMatchObject({ action: 'add_load', to: 32.5, pct: 8.33, significant: true });
		expect(up.why).toMatch(
			/ Its smallest step, 8\.33 %, is more than the weekly 5 %, which a light lift takes\.$/
		);
		const curl = bench({ loadValue: 20 });
		const missed = { rpes: [8, 8, 8], missed: 1 };
		expect(decideFromResults(sessions(curl, missed, missed, missed), curl, null, KG)).toMatchObject(
			{ action: 'reduce_load', to: 17.5, pct: -12.5 }
		);
		// One plate on 15 kg is 16.7 %, past rules/results.ts's smallestStepPct: it holds.
		const raise = bench({ loadValue: 15 });
		const held = decideFromResults(sessions(raise, 7, 7, 7), raise, null, KG);
		expect(held).toMatchObject({ action: 'hold', ruleKey: 'results.below.at_limit' });
		expect(held.why).toMatch(/ No step fits this week's limits, so it holds\.$/);
	});
});

describe('Strength: around target and without RPE', () => {
	it('within ±0.5 → the planned progression; noisy around target → hold', () => {
		expect(decideFromResults(sessions(bench(), 8, 8.5, 7.5), bench(), null, KG)).toMatchObject({
			action: 'planned',
			ruleKey: 'results.on_target'
		});
		expect(decideFromResults(sessions(bench(), 8.5, 7, 9), bench(), null, KG)).toMatchObject({
			action: 'hold',
			ruleKey: 'results.noisy'
		});
	});

	it('no RPE → reps against target: every set hit in two of three goes up, fewer holds', () => {
		const hit = sessions(bench(), null, { rpes: [], undone: 1 }, null);
		expect(decideFromResults(hit, bench(), null, KG)).toMatchObject({
			action: 'add_load',
			to: 102.5,
			ruleKey: 'results.reps_hit',
			confidence: 'low'
		});
		const short = sessions(bench(), null, { rpes: [], undone: 1 }, { rpes: [], undone: 2 });
		expect(decideFromResults(short, bench(), null, KG)).toMatchObject({
			action: 'hold',
			ruleKey: 'results.no_rpe'
		});
	});
});

describe('Bodyweight and timed lines', () => {
	const pullUp: ResultTarget = {
		name: 'Pull-up',
		line: line({ loadKind: 'rpe_based', loadValue: null, loadUnit: null, repsMin: 6, repsMax: 8 }),
		loadType: 'bodyweight',
		pattern: 'vertical_pull',
		repCeiling: 12
	};

	it('bodyweight → +1 rep, then a set once the reps reach the exercise’s ceiling', () => {
		const out = decideFromResults(sessions(pullUp, 7, 7, 7), pullUp, null, KG);
		expect(out).toMatchObject({ action: 'add_reps', field: 'reps', from: 8, to: 9 });
		expect([out.line.repsMin, out.line.repsMax, out.line.targetRpe]).toEqual([7, 9, 8]);
		const top = { ...pullUp, line: { ...pullUp.line, repsMin: 10, repsMax: 12 } };
		expect(decideFromResults(sessions(top, 7, 7, 7), top, null, KG)).toMatchObject({
			action: 'add_sets',
			from: 3,
			to: 4
		});
		const down = decideFromResults(
			sessions(pullUp, { rpes: [9, 9], undone: 1 }, 9, 9),
			pullUp,
			null,
			KG
		);
		expect(down).toMatchObject({ action: 'reduce_volume', field: 'sets', to: 2 });
	});

	it('a seconds line progresses its seconds', () => {
		const plank: ResultTarget = {
			name: 'Plank',
			line: line({
				loadKind: 'rpe_based',
				loadValue: null,
				loadUnit: null,
				repsMin: null,
				repsMax: null,
				seconds: 30
			}),
			loadType: 'bodyweight',
			pattern: 'anti_extension'
		};
		const out = decideFromResults(sessions(plank, 7, 7, 7), plank, null, KG);
		expect(out).toMatchObject({ action: 'add_reps', field: 'seconds', from: 30, to: 35 });
		expect(out.line.seconds).toBe(35);
	});
});

describe('every outcome', () => {
	it('is deterministic and independent of the exposures’ order', () => {
		const list = sessions(bench(), 7, 7.5, 7);
		const once = decideFromResults(list, bench(), null, KG);
		expect(decideFromResults([...list].reverse(), bench(), null, KG)).toEqual(once);
		expect(decideFromResults(list, bench(), null, KG)).toEqual(once);
	});

	it('renders as a complete results_progression decision the plan accepts', () => {
		const out = decideFromResults(sessions(bench(), 7, 7, 7), bench(), null, KG);
		const decision = new DecisionLog().add('results_progression', out.ruleKey, [], {
			...out.evidence,
			exercise: 'Bench press',
			change: '102.5 kg',
			reason: out.why
		});
		expect(decision.summary).toBe('Bench press: 102.5 kg');
		expect(validate(decisionPlanSchema, decision)).toEqual({ ok: true, data: decision });
	});

	it('reads RPE creep at the same load only', () => {
		expect(rpeCreep(sessions(bench(), 7, 7.5, 8))).toBe(1);
		expect(rpeCreep(sessions(bench(), 7, { rpes: [9, 9, 9], kg: 105 }))).toBeNull();
	});
});

describe('Running: progressive mileage', () => {
	const week = { planned: 36_000, previousPlanned: 32_000, actual: 30_000, adherencePct: 100 };

	it('caps the week at +10 % over the last completed week', () => {
		expect(adaptRunning(week, null).weekly).toMatchObject({
			action: 'reduce_volume',
			to: 33_000,
			ruleKey: 'results.run.weekly_cap'
		});
		expect(adaptRunning({ ...week, planned: 32_500 }, null).weekly).toMatchObject({
			action: 'planned',
			to: 32_500
		});
	});

	it('no distance last week is no base to cap: the plan decides, unless sessions due were missed', () => {
		const none = { ...week, actual: 0, adherencePct: null };
		expect(adaptRunning(none, null).weekly).toMatchObject({ action: 'planned', to: 36_000 });
		expect(adaptRunning({ ...none, adherencePct: 0 }, null).weekly).toMatchObject({
			action: 'hold',
			to: 32_000
		});
	});

	it('holds the volume when adherence is under 70 %', () => {
		const out = adaptRunning({ ...week, actual: 31_000, adherencePct: 60 }, null).weekly;
		expect(out).toMatchObject({
			action: 'hold',
			to: 32_000,
			ruleKey: 'results.run.adherence_hold'
		});
		expect(out.why).toBe(
			"You completed 60 % of last week's sessions, under 70 %, so the volume holds at 32 km."
		);
	});

	it('steps the long run up only after a completed long run at or under its target RPE', () => {
		const long = (last: { completed: boolean; rpe: number | null }) =>
			adaptRunning(week, { planned: 18_000, last: { prescribed: 16_000, targetRpe: 6, ...last } })
				.longRun;
		expect(long({ completed: true, rpe: 6 })).toMatchObject({ action: 'planned', to: 18_000 });
		expect(long({ completed: true, rpe: 7 })).toMatchObject({
			action: 'hold',
			to: 16_000,
			ruleKey: 'results.long_run.hold'
		});
		const unrated = long({ completed: true, rpe: null });
		expect(unrated).toMatchObject({
			action: 'hold',
			to: 16_000,
			ruleKey: 'results.long_run.no_rpe'
		});
		expect(unrated?.why).toBe(
			'The last long run of 16 km has no RPE to check against its target, so it stays there before it steps up.'
		);
		expect(long({ completed: false, rpe: null })).toMatchObject({
			action: 'hold',
			to: 16_000,
			ruleKey: 'results.long_run.repeat'
		});
	});

	it('a missed long run never overrides a shorter planned one (a deload or taper)', () => {
		const last = { prescribed: 20_000, completed: false, rpe: null, targetRpe: 6 };
		expect(adaptRunning(week, { planned: 10_000, last }).longRun).toMatchObject({
			action: 'planned',
			to: 10_000,
			ruleKey: 'results.long_run.planned'
		});
	});
});

describe('Fatigue', () => {
	it('fatigue high → deload recommended; one signal → watch; none → none', () => {
		const high = fatigueLevel({ acwr: 1.6, sleepHours: 6 });
		expect(high).toMatchObject({ level: 'high', deload: true });
		expect(high.reasons.map((r) => r.signal)).toEqual(['acwr', 'sleepHours']);
		expect(high.reasons[1]!.text).toBe('You have slept 6 hours a night');
		expect(fatigueLevel({ soreness: 4 })).toMatchObject({ level: 'watch', deload: false });
		expect(fatigueLevel({})).toEqual({ level: 'none', reasons: [], deload: false });
	});

	it('meets each threshold exactly as rules/results.ts states it', () => {
		const edge = {
			acwr: 1.5,
			monotony: 2,
			soreness: 3.9,
			sleepHours: 6.5,
			rpeCreep: 0.4,
			liftsMissingReps: 1,
			decliningLifts: 0
		};
		expect(fatigueLevel(edge).level).toBe('none');
		const over = {
			acwr: 1.51,
			monotony: 2.01,
			soreness: 4,
			sleepHours: 6.4,
			rpeCreep: 0.5,
			liftsMissingReps: 2,
			decliningLifts: 1
		};
		expect(fatigueLevel(over).reasons).toHaveLength(7);
	});
});
