import { describe, expect, it } from 'vitest';
import { PAYLOAD_SCHEMAS } from '../../coach/proposals';
import { addDays } from '../../calendar';
import type { CycleGoal } from './cycle';
import { cycleReviewSnapshotSchema } from './cycle-snapshot';
import type { CycleReviewSnapshot } from './cycle-snapshot';
import { clampOverrides, DIRECTIVE_RULES, directivesFrom, modifiableSubset } from './directives';
import type { CycleEvaluation } from './directives';

const FROM = '2026-10-05';
const TO = addDays(FROM, 27);
const LINEAGE = '5b3c3d0e-8f5a-4a43-9a9c-2f0f6a1c0b01';
const SQUAT = 'back_squat';
const CURL = 'barbell_curl';
const LEG_EXT = 'leg_extension';

type Effectiveness = CycleReviewSnapshot['effectiveness'][number];
const lift = (exercise: string, over: Partial<Effectiveness> = {}): Effectiveness => ({
	exercise,
	main: false,
	verdict: 'progressed',
	exposures: 4,
	firstKg: 100,
	lastKg: 105,
	stalled: false,
	...over
});
const weeks = [0, 1, 2, 3].map((n) => addDays(FROM, 7 * n));

/** A healthy, well-attended block: progressed lifts, chest under range, back within. */
function snapshot(over: Partial<CycleReviewSnapshot> = {}): CycleReviewSnapshot {
	const counts = { planned: 16, completed: 15, skipped: 0, missed: 1, pct: 93.75 };
	return cycleReviewSnapshotSchema.parse({
		version: 1,
		block: {
			lineage: LINEAGE,
			name: 'Accumulation',
			phase: 'accumulation',
			from: FROM,
			to: TO,
			weeks: 4
		},
		computedOn: addDays(TO, 1),
		timeZone: 'America/Los_Angeles',
		analyticsVersion: 1,
		inputsDigest: '0123456789abcdef',
		adherence: {
			...counts,
			verdictsWithheld: false,
			weeks: weeks.map((weekStartsOn) => ({ weekStartsOn, ...counts })),
			oftenMissed: []
		},
		goals: [],
		effectiveness: [lift(SQUAT, { main: true }), lift(CURL)],
		volume: weeks.flatMap((weekStartsOn) => [
			{ weekStartsOn, group: 'chest', planned: 10, achieved: 7, target: [10, 20] },
			{ weekStartsOn, group: 'back', planned: 12, achieved: 12, target: [10, 20] }
		]),
		fatigue: { level: 'none', reasons: [], deloadPlanned: false },
		deloadNeed: { verdict: 'not_needed', reasons: [] },
		previous: null,
		next: { name: 'Intensification', phase: 'intensification', startsOn: addDays(TO, 1) },
		brief: { kind: 'cycle', from: FROM, to: TO, summary: 'A block.', findings: [] },
		...over
	}) as CycleReviewSnapshot;
}
const evaluation = (
	over: Partial<CycleReviewSnapshot> = {},
	running: CycleEvaluation['running'] = null
) => ({
	snapshot: snapshot(over),
	running
});
const OUTLINE = { phase: 'intensification' as const, weeks: 4 };
const withheld = (s = snapshot()) => ({
	...s.adherence,
	pct: 50,
	verdictsWithheld: true
});

const marathonGoal: CycleGoal = {
	id: '7d1c2b3a-0000-4000-8000-000000000001',
	title: 'Marathon',
	disciplines: ['distance_running'],
	eventType: 'Marathon',
	eventDate: '2027-01-24',
	targetPerformance: '3:30:00',
	measure: null
};

describe('directivesFrom', () => {
	it('keeps progressed lifts, with the phase and weeks from the outline', () => {
		const d = directivesFrom(evaluation(), OUTLINE, []);
		expect(d).toMatchObject({ phase: 'intensification', weeks: 4, fromOutline: true, rotate: [] });
		expect(d.keep.map((k) => k.exercise)).toEqual([SQUAT, CURL]);
		expect(d.keep[0]!.reason).toMatch(/^Progressed over 4 sessions/);
		expect(d.progression).toBe('progress');
		expect(d.rpe).toEqual(DIRECTIVE_RULES.rpe.none);
		expect(d.deload).toBe('none');
		// Chest was under its range, back within it.
		expect(d.volume).toEqual([
			{ group: 'chest', change: DIRECTIVE_RULES.volumeStep, reason: 'Under its range this block' },
			{ group: 'back', change: 0, reason: 'Within its range' }
		]);
	});

	it('rotates a stalled accessory, never a stalled main lift', () => {
		const effectiveness = [
			lift(SQUAT, { main: true, verdict: 'held', exposures: 5, stalled: true }),
			lift(LEG_EXT, { verdict: 'held', exposures: 5, stalled: true })
		];
		const d = directivesFrom(evaluation({ effectiveness }), OUTLINE, []);
		expect(d.rotate).toEqual([
			{ exercise: LEG_EXT, reason: 'Stalled over 5 sessions: a fresh stimulus' }
		]);
		expect(d.keep).toEqual([
			{ exercise: SQUAT, reason: 'Stalled over 5 sessions, kept as a main lift' }
		]);
	});

	it('regressed lifts with high fatigue: a first-week deload, less volume and no increases', () => {
		const d = directivesFrom(
			evaluation({
				effectiveness: [
					lift(SQUAT, { main: true, verdict: 'regressed', firstKg: 140, lastKg: 130 })
				],
				fatigue: { level: 'high', reasons: ['ACWR 1.6', 'Sleep 6 h'], deloadPlanned: false },
				deloadNeed: { verdict: 'needed', reasons: ['Fatigue is high: 2 signals'] }
			}),
			OUTLINE,
			[]
		);
		expect(d.deload).toBe('first');
		expect(d.volume.map((v) => v.change)).toEqual([-0.1, -0.1]);
		expect(d.rpe).toEqual(DIRECTIVE_RULES.rpe.high);
		expect(d.progression).toBe('hold');
		expect(modifiableSubset(d).constraints).toContain('Open with a deload week');
	});

	it('Fridays often missed: avoid Friday', () => {
		const s = snapshot();
		const d = directivesFrom(
			evaluation({ adherence: { ...s.adherence, oftenMissed: ['fri'] } }),
			OUTLINE,
			[]
		);
		expect(d.avoidDays).toEqual(['fri']);
		expect(modifiableSubset(d).constraints).toContain('Avoid Fridays: often missed');
	});

	it('a marathon outline: running starts from the last 3 weeks’ actual mileage, with the race pace', () => {
		const running = { weeklyMetres: [20_000, 30_000, 32_000, 34_050], longestRunMetres: 18_240 };
		const d = directivesFrom(
			evaluation({ block: { ...snapshot().block, phase: 'marathon_base' } }, running),
			{ phase: 'marathon_build', weeks: 6 },
			[marathonGoal]
		);
		// (30 + 32 + 34.05) / 3 = 32.016 km, rounded down to 100 m; never the first week's 20 km.
		expect(d.running).toEqual({
			weeklyMetres: 32_000,
			longRunMetres: 18_200,
			paces: [{ goalId: marathonGoal.id, secondsPerKm: 298.6 }]
		});
		const none = directivesFrom(evaluation(), OUTLINE, []);
		expect(none.running).toBeNull();
	});

	it('low adherence: nothing increases and nothing is rotated', () => {
		const effectiveness = [lift(LEG_EXT, { verdict: 'held', exposures: 5, stalled: true })];
		const d = directivesFrom(evaluation({ adherence: withheld(), effectiveness }), OUTLINE, []);
		expect(d.progression).toBe('hold');
		expect(d.rotate).toEqual([]);
		expect(d.volume.every((v) => v.change <= 0)).toBe(true);
		expect(d.volume[0]!.reason).toBe('Held: adherence was too low to add volume');
		const subset = modifiableSubset(d);
		expect(subset.targets.loadStep).toBe(0);
		expect(subset.emphasis).toEqual([]);
	});

	it('no outline left: the reviewed phase is repeated for the appended weeks, with a closing deload', () => {
		const d = directivesFrom(evaluation(), null, []);
		expect(d).toMatchObject({
			phase: 'accumulation',
			weeks: DIRECTIVE_RULES.appendWeeks,
			fromOutline: false,
			deload: 'last'
		});
		const peak = directivesFrom(
			evaluation({ block: { ...snapshot().block, phase: 'realization' } }),
			null,
			[]
		);
		expect(peak.phase).toBe('accumulation');
	});
});

describe('the modifiable subset', () => {
	it('parses with M5’s next_cycle schema', () => {
		const running = { weeklyMetres: [30_000, 32_000, 34_000], longestRunMetres: 18_000 };
		const cases = [
			directivesFrom(evaluation(), OUTLINE, []),
			directivesFrom(evaluation({}, running), { phase: 'marathon_taper', weeks: 3 }, [
				marathonGoal
			]),
			directivesFrom(evaluation({ adherence: withheld() }), null, []),
			// Under one rounding step of running: no start, never 0 m.
			directivesFrom(evaluation({}, { weeklyMetres: [0, 0, 250], longestRunMetres: 80 }), null, [])
		];
		for (const d of cases) {
			const parsed = PAYLOAD_SCHEMAS.next_cycle.safeParse(modifiableSubset(d));
			expect(parsed.error?.issues ?? []).toEqual([]);
		}
		expect(modifiableSubset(cases[1]!).ending).toBe('taper');
		expect(modifiableSubset(cases[2]!).ending).toBe('deload');
		expect(cases[3]!.running).toMatchObject({ weeklyMetres: null, longRunMetres: null });
	});

	it('clamps an override outside the bounds and records it', () => {
		const running = { weeklyMetres: [30_000, 30_000, 30_000], longestRunMetres: 16_000 };
		const d = directivesFrom(evaluation({}, running), OUTLINE, [marathonGoal]);
		const { subset, clamps } = clampOverrides(
			{
				weeks: 8,
				focus: 'Heavier',
				targets: { rpeCap: 10, volumeFactor: 1.5, loadStep: 0.2, runVolumeFactor: 1 },
				running: { weeklyMetres: 50_000, longRunMetres: 17_000 }
			},
			d
		);
		expect(clamps).toEqual([
			{ field: 'targets.rpeCap', asked: 10, used: 8.5 },
			{ field: 'targets.volumeFactor', asked: 1.5, used: 1.15 },
			{ field: 'targets.loadStep', asked: 0.2, used: 0.05 },
			{ field: 'running.weeklyMetres', asked: 50_000, used: 33_000 },
			{ field: 'weeks', asked: 8, used: 4 }
		]);
		expect(subset).toMatchObject({
			focus: 'Heavier',
			weeks: 4,
			running: { longRunMetres: 17_000 }
		});
		expect(PAYLOAD_SCHEMAS.next_cycle.safeParse(subset).success).toBe(true);
		// Within the bounds: nothing is clamped.
		expect(clampOverrides({ targets: { ...subset.targets, rpeCap: 7 } }, d).clamps).toEqual([]);
	});

	it('a held block allows no increase, and an appended block’s weeks stay within 3 to 16', () => {
		const d = directivesFrom(evaluation({ adherence: withheld() }), null, []);
		const base = modifiableSubset(d);
		const { clamps } = clampOverrides(
			{
				weeks: 1,
				targets: { ...base.targets, loadStep: 0.025, volumeFactor: base.targets.volumeFactor + 0.1 }
			},
			d
		);
		expect(clamps).toEqual([
			{
				field: 'targets.volumeFactor',
				asked: base.targets.volumeFactor + 0.1,
				used: base.targets.volumeFactor
			},
			{ field: 'targets.loadStep', asked: 0.025, used: 0 },
			{ field: 'weeks', asked: 1, used: DIRECTIVE_RULES.minWeeks }
		]);
	});
});
