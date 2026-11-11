/**
 * The cycle review as the screen shows it (cycle-data.ts), from a hand-built stored snapshot and
 * progression: the sections in screen order, each lift's estimated 1RM line in the profile's unit
 * with its first, last and change in kg, weekly distance, the ACWR's caveat, planned against
 * achieved hard sets per group, the effectiveness table leading to Keep or Rotate, adherence with
 * the deload need first, and the hero, out-of-date notice, earlier cycles and History link.
 */
import { describe, expect, it } from 'vitest';
import { METRICS } from '#lib/domain/analytics/metrics.ts';
import type { Finding } from '#lib/domain/programming/review/brief.ts';
import type { CycleReviewSnapshot } from '#lib/domain/programming/review/cycle-snapshot.ts';
import type { CycleReviewView } from '#lib/server/services/reviews/index.ts';
import { cycleReviewData, cycleSections, cycleTitle } from './cycle-data.ts';
import type { ReviewRow } from './load.ts';

const ID = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
const SQUAT = '11111111-1111-4111-8111-111111111111';
const CURL = '22222222-2222-4222-8222-222222222222';
const FROM = '2026-10-26';
const TO = '2026-11-22';

const fig = (label: string, value: number | null, words: string) => ({
	label,
	value,
	unit: null,
	kind: 'calculated' as const,
	words
});

function finding(id: string, label: string, words: string, parts: Partial<Finding> = {}): Finding {
	return {
		id,
		section: id.split(':')[0] as Finding['section'],
		label,
		figures: [],
		verdict: { level: 'neutral', words },
		window: { from: FROM, to: TO, label: 'The block, 4 weeks' },
		metricId: null,
		sources: [],
		...parts
	};
}

const FINDINGS: Finding[] = [
	finding('adherence', 'Planned against completed', '22 of 24 sessions done · On plan', {
		figures: [fig('Adherence', 91.7, '92%')],
		verdict: { level: 'good', words: '22 of 24 sessions done · On plan' }
	}),
	finding('verdicts:strength', 'Strength progression', '1 of 1 main lift progressed'),
	finding('verdicts:mileage', 'Weekly distance', 'Within normal variation'),
	finding('effectiveness:' + SQUAT, 'Back squat (main lift)', 'Progressed: up 7.5 kg'),
	finding('effectiveness:' + CURL, 'Curl', 'Held: 0 kg change over 6 sessions. Stalled'),
	finding('fatigue:load', 'Training load', 'Within normal variation'),
	finding('fatigue:acwr', 'Acute:chronic load', 'Within the typical range'),
	finding('recovery:sleep', 'Sleep', 'Enough'),
	finding('fatigue', 'Accumulated fatigue', 'RPE crept up by 1', {
		verdict: { level: 'watch', words: 'RPE crept up by 1' }
	}),
	finding('fatigue:deload', 'Deload need', 'A deload is worth considering'),
	finding('volume:sets:quads', 'Quads hard sets', 'Within range in 2 of 2 weeks', {
		figures: [fig('Achieved', 24, '24 sets'), fig('Planned', 24, '24 sets')]
	}),
	finding('goals:g1:strength', 'Squat 140 kg', '12.5 kg to go'),
	finding('adherence:week:1', 'Week 1', '6 of 6 sessions done')
];

const SNAPSHOT = {
	version: 1,
	block: { lineage: 'l', name: 'Base', phase: 'accumulation', from: FROM, to: TO, weeks: 4 },
	computedOn: '2026-11-23',
	timeZone: 'America/Los_Angeles',
	analyticsVersion: 1,
	inputsDigest: '0123456789abcdef',
	adherence: {
		...{ planned: 24, completed: 22, skipped: 1, missed: 1, pct: 91.7 },
		verdictsWithheld: false,
		weeks: [],
		oftenMissed: []
	},
	goals: [],
	effectiveness: [
		{
			...{ exercise: SQUAT, main: true, verdict: 'progressed', exposures: 8 },
			...{ firstKg: 120, lastKg: 127.5, stalled: false }
		},
		{
			...{ exercise: CURL, main: false, verdict: 'held', exposures: 6 },
			...{ firstKg: 30, lastKg: 30, stalled: true }
		}
	],
	volume: [
		{ weekStartsOn: FROM, group: 'quads', planned: 12, achieved: 10, target: [10, 20] },
		{ weekStartsOn: '2026-11-02', group: 'quads', planned: 12, achieved: 14, target: [10, 20] }
	],
	fatigue: { level: 'watch', reasons: ['RPE crept up by 1'], deloadPlanned: false },
	deloadNeed: { verdict: 'consider', reasons: ['Fatigue is watch: 1 signal'] },
	previous: null,
	next: null,
	brief: {
		kind: 'cycle',
		from: FROM,
		to: TO,
		summary: 'Base: 22 of 24 sessions done.',
		findings: FINDINGS
	}
} as unknown as CycleReviewSnapshot;

function view(parts: Partial<CycleReviewView> = {}): CycleReviewView {
	return {
		review: { id: ID, summary: 'Base: 22 of 24 sessions done.' },
		legacy: false,
		snapshot: SNAPSHOT,
		sections: [],
		proposal: null,
		decision: { state: 'none' },
		stale: false,
		laterChanges: 0,
		analyticsOutdated: false,
		writeUp: { state: 'none' },
		previews: [],
		progression: {
			lifts: [
				{
					exercise: SQUAT,
					points: [
						{ on: FROM, kg: 120 },
						{ on: '2026-11-19', kg: 127.5 }
					]
				},
				{ exercise: CURL, points: [{ on: '2026-10-28', kg: 30 }] }
			],
			distance: [
				{ weekStartsOn: FROM, metres: 16093.44 },
				{ weekStartsOn: '2026-11-02', metres: 0 },
				{ weekStartsOn: '2026-11-09', metres: 8046.72 },
				{ weekStartsOn: '2026-11-16', metres: 32186.88 }
			],
			units: { weight: 'lb', distance: 'mi' }
		},
		...parts
	} as unknown as CycleReviewView;
}

const byId = (id: string) => cycleSections(view()).find((s) => s.id === id)!;

describe('the cycle review’s sections', () => {
	it('are in screen order', () => {
		expect(cycleSections(view()).map((s) => s.id)).toEqual([
			'goals',
			'strength',
			'endurance',
			'fatigue',
			'volume',
			'effectiveness',
			'adherence'
		]);
	});

	it('strength: an estimated 1RM line per lift in the profile’s unit, its change in kg', () => {
		const strength = byId('strength');
		expect(strength.charts!.map((c) => c.title)).toEqual([
			'Back squat estimated 1RM',
			'Curl estimated 1RM'
		]);
		const squat = strength.charts![0]!;
		expect(squat.context).toContain('Estimated');
		expect(squat.data.unit).toBe('lb');
		expect(squat.data.series[0]!.points).toEqual([
			{ value: 264.6, text: '264.6', kind: 'estimated' },
			{ value: 281.1, text: '281.1', kind: 'estimated' }
		]);
		expect(squat.summary).toBe('Up 16.5 lb from the first session to the last: 264.6 to 281.1 lb.');
		expect(squat.table.rows.map((r) => [r.label, ...r.values])).toEqual([
			['Session on Mon 26 Oct', '264.6, estimated'],
			['Session on Thu 19 Nov', '281.1, estimated']
		]);
		const item = strength.items.find((i) => i.id === `progression:${SQUAT}`)!;
		expect(item.figures).toEqual([
			{ label: 'First session', words: '264.6 lb', value: 120 },
			{ label: 'Last session', words: '281.1 lb', value: 127.5 },
			{ label: 'Change', words: '+16.5 lb', value: 7.5 }
		]);
		expect(item.words).toBe('Progressed: up 7.5 kg');
		expect(strength.verdict.words).toBe('Strength progression: 1 of 1 main lift progressed');
	});

	it('endurance: weekly distance in the profile’s unit', () => {
		const [chart] = byId('endurance').charts!;
		expect(chart!.data.series[0]!.points.map((p) => p!.value)).toEqual([10, 0, 5, 20]);
		expect(chart!.summary).toBe(
			'35 mi over the block: 10 mi in its first week, 20 mi in its last.'
		);
	});

	it('fatigue: its reasons, and the ACWR with its caveat; the deload need is not here', () => {
		const fatigue = byId('fatigue');
		expect(fatigue.items.map((i) => i.id)).toEqual([
			'fatigue:load',
			'fatigue:acwr',
			'recovery:sleep',
			'fatigue'
		]);
		expect(fatigue.items[1]!.reasons).toEqual([METRICS.acwr.caveat]);
		expect(fatigue.items[3]!.reasons).toEqual(['RPE crept up by 1']);
		expect(fatigue.verdict).toEqual({
			level: 'watch',
			words: 'Accumulated fatigue: RPE crept up by 1'
		});
	});

	it('volume: each group’s weekly mean against its range and plan', () => {
		const volume = byId('volume');
		expect(volume.chart?.body).toBe('range');
		expect(volume.chart?.data.rows).toEqual([
			{
				key: 'quads',
				label: 'Quads',
				value: { value: 12, text: '12' },
				range: [10, 20],
				planned: { value: 12, text: '12' }
			}
		]);
		expect(volume.items.map((i) => i.id)).toEqual(['volume:sets:quads']);
	});

	it('effectiveness: a table in words leading to Keep or Rotate', () => {
		const effectiveness = byId('effectiveness');
		expect(effectiveness.table!.rows.map((r) => [r.label, ...r.values])).toEqual([
			['Back squat (main lift)', 'Progressed: up 7.5 kg', 'Keep · Progressed over 8 sessions'],
			[
				'Curl',
				'Held: 0 kg change over 6 sessions. Stalled',
				'Rotate · Stalled over 6 sessions: a fresh stimulus'
			]
		]);
		expect(effectiveness.verdict).toEqual({
			level: 'watch',
			words: '1 exercise to keep, 1 to rotate'
		});
	});

	it('adherence: the deload need leads, then each week', () => {
		const adherence = byId('adherence');
		expect(adherence.items.map((i) => i.id)).toEqual(['fatigue:deload', 'adherence:week:1']);
		expect(adherence.verdict.words).toBe('Deload need: A deload is worth considering');
	});

	it('goals: a card each, or what to do with none', () => {
		expect(byId('goals').items.map((i) => [i.label, i.words])).toEqual([
			['Squat 140 kg', '12.5 kg to go']
		]);
		const none = { ...SNAPSHOT, brief: { ...SNAPSHOT.brief, findings: [] } };
		const goals = cycleSections(view({ snapshot: none })).find((s) => s.id === 'goals')!;
		expect(goals.verdict.words).toMatch(/^No active goals/);
	});

	it('a block that left the current version has no charts, only its stored findings', () => {
		const sections = cycleSections(view({ progression: null }));
		const strength = sections.find((s) => s.id === 'strength')!;
		expect(strength.charts).toBeUndefined();
		expect(strength.items.map((i) => i.id)).toEqual(['verdicts:strength']);
		expect(strength.verdict.words).toBe('Strength progression: 1 of 1 main lift progressed');
		expect(sections.map((s) => s.id)).toContain('endurance');
	});
});

describe('a cycle review as the screen shows it', () => {
	const row = (key: string, weekStartsOn: string): ReviewRow => ({
		...{ state: 'reviewed', key, weekStartsOn },
		...{ title: cycleTitle(weekStartsOn, weekStartsOn), text: 'Earlier.' }
	});
	const rows = [row(`c-${ID}`, FROM), row('c-older', '2026-09-28'), row('b-next', '2026-11-23')];

	it('the hero, its counts, earlier cycles and the version it planned', () => {
		const data = cycleReviewData(
			view({
				decision: { state: 'applied', proposalId: 'p', versionId: 'v', versionNumber: 3 }
			}),
			[],
			rows
		);
		expect(data).toMatchObject({
			kind: 'cycle',
			key: `c-${ID}`,
			title: 'Base',
			dates: 'Mon 26 Oct – Sun 22 Nov',
			adherence: { pct: 91.7, text: '92%', level: 'good' },
			stale: null,
			history: { version: 3, label: 'See version 3 in History' },
			writeUp: null
		});
		expect(data.adherence!.counts.map((c) => [c.label, c.value, c.words])).toEqual([
			['Planned', 24, '24 sessions'],
			['Completed', 22, '22 sessions'],
			['Skipped', 1, '1 session'],
			['Missed', 1, '1 session']
		]);
		expect(data.earlier.map((r) => r.key)).toEqual(['c-older']);
	});

	it('out of date: how many changes since; undecided: no History link', () => {
		const data = cycleReviewData(view({ stale: true, laterChanges: 2 }), [], rows);
		expect(data.stale?.words).toBe('Computed before 2 later changes');
		expect(data.history).toBeNull();
	});

	it('written before M6: its summary and dates alone', () => {
		const item = {
			...{ kind: 'cycle' as const, id: ID, startsOn: FROM, endsOn: TO },
			...{ revision: 1, summary: 'Old.', legacy: true }
		};
		const data = cycleReviewData(view({ legacy: true, snapshot: null }), [item], rows);
		expect(data).toMatchObject({ title: 'Cycle review', dates: 'Mon 26 Oct – Sun 22 Nov' });
		expect(data.adherence).toBeNull();
		expect(data.sections).toEqual([]);
	});
});
