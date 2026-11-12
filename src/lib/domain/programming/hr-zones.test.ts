/**
 * hr-zones: with the owner's heart rate known, the plan records their zones in bpm by the first
 * method the rates allow (threshold, then reserve, then max). Segments keep the zone numbers they
 * already carry, and a profile without heart rate plans byte for byte as before, so GENERATOR_ID
 * stays where it is.
 */
import { describe, expect, it } from 'vitest';
import { CATALOGUE } from '../exercises/index';
import type { HeartRate, TrainingProfile } from '../profile/types';
import type { ProgramPlan } from '../training/types';
import { generateProgram } from './generate';
import { buildProgrammingInput } from './input';
import { M7_SCENARIOS } from './periodisation/scenarios';
import type { M7ScenarioKey } from './periodisation/scenarios';
import { fnv1a64 } from './random';
import { SCENARIO_START, SCENARIOS } from './scenarios';

const OPTIONS = { startsOn: SCENARIO_START, firstPlannedDay: SCENARIO_START };
const planOf = (profile: TrainingProfile) =>
	generateProgram(buildProgrammingInput(profile, { catalogue: CATALOGUE }), OPTIONS);
const zonesIn = (plan: ProgramPlan) => plan.decisions.filter((d) => d.kind === 'hr_zones_set');

/** runnerLifter (a marathon in week 16, strength beside it) with `heartRate` told. */
function runnerWith(heartRate: Partial<HeartRate>): TrainingProfile {
	const profile = M7_SCENARIOS.runnerLifter();
	profile.running!.heartRate = { max: null, resting: null, threshold: null, ...heartRate };
	return profile;
}

/**
 * Each M7 scenario's plan from SCENARIO_START, hashed on the commit before hr-zones: none has a
 * heart rate, so none may change. M3's scenarios are pinned the same way by generate.test.ts's
 * GOLDEN_SEASON, which this slice leaves as it was.
 */
const BEFORE: Record<M7ScenarioKey, string> = {
	multiGoal: '75a0a86ea385a0d6',
	hybridSwap: 'e3e31a334cbb5df3',
	marathonTaper: '025d5d072cb39df0',
	hypertrophyBlock: '0b455d6d52c7bd48',
	meetPrep: '09ffad7e8c05d4f6',
	runnerLifter: 'b5ef77a731995a0b',
	longSeason: '34805d400ddcb8db',
	offSeason: '4274dde39db372e3',
	allPaused: 'fcb2ef7a008cc9a5',
	journeyHybrid: 'f09e9a1e6fd15d26'
};

describe('every M3 and M7 scenario, none with a heart rate', () => {
	it('tells no heart rate in any scenario profile', () => {
		const profiles = [...Object.values(SCENARIOS), ...Object.values(M7_SCENARIOS)].map((make) =>
			make()
		);
		for (const profile of profiles) expect(profile.running?.heartRate).toBeUndefined();
	});

	it.each(Object.keys(BEFORE) as M7ScenarioKey[])(
		'%s: the plan is byte for byte the one from before hr-zones, with no zones decision',
		(key) => {
			const plan = planOf(M7_SCENARIOS[key]());
			expect(zonesIn(plan)).toEqual([]);
			expect(fnv1a64(JSON.stringify(plan))).toBe(BEFORE[key]);
		},
		60_000
	);
});

describe('heart-rate zones in the plan', () => {
	it('uses heart-rate reserve (Karvonen) from max and resting: zone 2 of 190 and 50 is 134–148 bpm', () => {
		const [decision, ...more] = zonesIn(planOf(runnerWith({ max: 190, resting: 50 })));
		expect(more).toEqual([]);
		expect(decision).toMatchObject({
			ruleKey: 'paces.hr_methods',
			decidedBy: 'rules',
			refs: [],
			summary: 'Heart-rate zones from your max and resting heart rate',
			evidence: { method: 'reserve', basis: 'max of 190 and resting 50' }
		});
		expect(decision!.why).toMatch(
			/^Zone 1 is 120–134 bpm, zone 2 134–148, zone 3 148–162, zone 4 162–176 and zone 5 176–190, from your max of 190 and resting 50\. Heart-rate reserve \(Karvonen\)/
		);
	});

	it('uses a share of max with max alone', () => {
		const [decision] = zonesIn(planOf(runnerWith({ max: 200 })));
		expect(decision).toMatchObject({
			summary: 'Heart-rate zones from your max heart rate',
			evidence: {
				method: 'max',
				basis: 'max of 200',
				zones:
					'Zone 1 is 100–120 bpm, zone 2 120–140, zone 3 140–160, zone 4 160–180 and zone 5 180–200'
			}
		});
	});

	it('uses Friel’s threshold bands with threshold alone, and ahead of max and resting', () => {
		const [alone] = zonesIn(planOf(runnerWith({ threshold: 170 })));
		expect(alone).toMatchObject({
			summary: 'Heart-rate zones from your threshold heart rate',
			evidence: {
				method: 'threshold',
				basis: 'threshold of 170',
				zones:
					'Zone 1 is 111–145 bpm, zone 2 145–153, zone 3 153–162, zone 4 162–170 and zone 5 170–180'
			}
		});
		const [all] = zonesIn(planOf(runnerWith({ max: 190, resting: 50, threshold: 170 })));
		expect(all?.evidence).toMatchObject({ method: 'threshold', basis: 'threshold of 170' });
	});

	it('gives zones alone, with no decision, without a heart rate or with rates that cannot all be right', () => {
		expect(zonesIn(planOf(M7_SCENARIOS.runnerLifter()))).toEqual([]);
		expect(zonesIn(planOf(runnerWith({})))).toEqual([]);
		expect(zonesIn(planOf(runnerWith({ max: 150, resting: 160 })))).toEqual([]);
	});

	it('changes nothing else: every segment keeps the zone number it already carried', () => {
		const without = planOf(M7_SCENARIOS.runnerLifter());
		const told = planOf(runnerWith({ max: 190, resting: 50 }));
		expect(told.blocks).toEqual(without.blocks);
		expect(told.decisions.filter((d) => d.kind !== 'hr_zones_set')).toEqual(without.decisions);
		const zones = told.blocks.flatMap((b) =>
			b.weeks.flatMap((w) =>
				w.sessions.flatMap((s) => (s.kind === 'run' ? s.segments.map((g) => g.hrZone) : []))
			)
		);
		expect(zones.length).toBeGreaterThan(0);
		expect(zones.every((z) => z !== null && z >= 1 && z <= 5)).toBe(true);
	});

	it.each<[string, Partial<HeartRate>]>([
		['reserve', { max: 190, resting: 50 }],
		['max', { max: 183 }],
		['threshold', { threshold: 167 }],
		['threshold under a low max', { max: 172, threshold: 168 }]
	])('gives contiguous, ordered zones by %s', (_, rates) => {
		const [decision] = zonesIn(planOf(runnerWith(rates)));
		const text = String(decision!.evidence.zones);
		const zones = [...text.matchAll(/(\d+)–(\d+)/g)].map(([, low, high]) => [+low!, +high!]);
		expect(zones).toHaveLength(5);
		zones.forEach(([low, high], i) => {
			expect(low, `zone ${i + 1}`).toBeLessThanOrEqual(high!);
			if (i > 0) expect(low, `zone ${i + 1} starts where ${i} ends`).toBe(zones[i - 1]![1]);
		});
		if (rates.max) expect(zones[4]![1]).toBeLessThanOrEqual(rates.max);
	});

	it('is deterministic: the same heart rates give the same plan, whatever their key order', () => {
		const first = JSON.stringify(planOf(runnerWith({ max: 190, resting: 50, threshold: 170 })));
		const reordered = M7_SCENARIOS.runnerLifter();
		reordered.running!.heartRate = { threshold: 170, resting: 50, max: 190 };
		expect(JSON.stringify(planOf(reordered))).toBe(first);
		expect(JSON.stringify(planOf(runnerWith({ max: 190, resting: 50, threshold: 170 })))).toBe(
			first
		);
	});
});
