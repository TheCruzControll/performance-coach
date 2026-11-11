/**
 * The weekly review's sections (sections.ts) from hand-built stored findings: screen order, the
 * verdict line a collapsed section shows, RPE against target and hard sets per group as chart
 * data with their summaries and table twins, the lines left beside each chart, fatigue's
 * reasons, and conflicts and PRs, which say so when there are none.
 */
import { describe, expect, it } from 'vitest';
import type { Finding, FindingLevel } from '#lib/domain/programming/review/brief.ts';
import type { WeeklyReviewSnapshot } from '#lib/domain/programming/review/snapshot.ts';
import { reviewSections, type SectionView } from './sections.ts';

const fig = (label: string, value: number | null, words = String(value)) => ({
	label,
	value,
	unit: null,
	kind: 'calculated' as const,
	words
});

function finding(
	id: string,
	label: string,
	level: FindingLevel,
	words: string,
	figures: Finding['figures'] = []
): Finding {
	return {
		id,
		section: (id === 'fatigue' ? 'fatigue' : id.split(':')[0]) as Finding['section'],
		label,
		figures,
		verdict: { level, words },
		window: null,
		metricId: null,
		sources: []
	};
}

const snapshot = (findings: Finding[], reasons: string[] = []) =>
	({
		fatigue: { level: reasons.length ? 'watch' : 'none', reasons },
		brief: { findings }
	}) as unknown as WeeklyReviewSnapshot;

const lift = (key: string, name: string, actual: number, target: number, level: FindingLevel) =>
	finding(`rpe:${key}`, `${name} RPE against target`, level, `${name} words`, [
		fig('Mean deviation', actual - target),
		fig('Actual', actual),
		fig('Target', target)
	]);

const group = (key: string, name: string, done: number, range: [number, number] | null) =>
	finding(`volume:sets:${key}`, `${name} hard sets`, 'good', `${name} words`, [
		fig('Done', done),
		fig('Planned', 12),
		...(range ? [fig('Target low', range[0]), fig('Target high', range[1])] : [])
	]);

const AVERAGE = finding('rpe:average', 'Average RPE', 'good', 'About right', [fig('Mean', 7.8)]);
const TONNAGE = finding('volume:tonnage', 'Tonnage', 'neutral', 'Σ weight × reps', [
	fig('This week', 6200, '6,200 kg'),
	fig('The week before', 5900, '5,900 kg')
]);
const MILEAGE = finding('running:mileage', 'Distance', 'good', '20 km of 21 km planned');
const LONG = finding(
	'running:long_run',
	'Long run',
	'watch',
	'30 % longer than the long run before'
);
const THAI = finding('muay_thai:load', 'Muay Thai load', 'neutral', '2 sessions, 1 hard', [
	fig('Sessions', 2, '2 sessions'),
	fig('Time', 10800, '3 h'),
	fig('Rounds', 6, '6 rounds')
]);
const FATIGUE = finding(
	'fatigue',
	'Fatigue',
	'watch',
	'Soreness is high. Sleep is short. A deload is worth considering'
);
const SLEEP = finding('recovery:sleep', 'Sleep', 'good', 'Enough sleep');
const CONFLICT = finding(
	'conflicts:1:long_run_after_sparring',
	'Long run the day after hard sparring',
	'watch',
	'Sparring on Friday, then the long run on Saturday. Both load the legs.'
);
const PR = finding('prs:w1:bench_press:e1rm', 'Bench press: Estimated 1RM', 'good', 'A new record');

const ALL = [
	AVERAGE,
	lift('back_squat', 'Back squat', 8, 8, 'good'),
	lift('bench_press', 'Bench press', 7, 8, 'watch'),
	TONNAGE,
	group('chest', 'Chest', 14, [10, 20]),
	group('quads', 'Quads', 22, [10, 20]),
	group('neck', 'Neck', 2, null),
	MILEAGE,
	LONG,
	THAI,
	FATIGUE,
	SLEEP,
	CONFLICT,
	PR
];

const byId = (sections: SectionView[], id: SectionView['id']) => sections.find((s) => s.id === id)!;

describe('the review sections', () => {
	it('in screen order, each with its title', () => {
		expect(reviewSections(snapshot(ALL)).map((s) => [s.id, s.title])).toEqual([
			['rpe', 'RPE against target'],
			['volume', 'Volume and intensity'],
			['running', 'Running'],
			['muay_thai', 'Muay Thai'],
			['recovery', 'Recovery and fatigue'],
			['conflicts', 'Conflicting demands'],
			['prs', 'Personal records']
		]);
	});

	it('the verdict line: the first finding to watch, otherwise the lead finding', () => {
		const sections = reviewSections(snapshot(ALL, ['Soreness is high', 'Sleep is short']));
		expect(byId(sections, 'running').verdict).toEqual({
			level: 'watch',
			words: 'Long run: 30 % longer than the long run before'
		});
		expect(byId(sections, 'muay_thai').verdict).toEqual({
			level: 'neutral',
			words: 'Muay Thai load: 2 sessions, 1 hard'
		});
		expect(byId(sections, 'rpe').verdict.words).toBe(
			'Bench press RPE against target: Bench press words'
		);
		expect(byId(sections, 'conflicts').verdict).toEqual({
			level: 'watch',
			words: '1 conflict: Long run the day after hard sparring'
		});
		expect(byId(sections, 'prs').verdict.words).toBe('1 new record: Bench press: Estimated 1RM');
	});

	it('RPE against target as diverging bars, the lifts to watch listed with why', () => {
		const rpe = byId(reviewSections(snapshot(ALL)), 'rpe');
		expect(rpe.chart).toMatchObject({
			body: 'diverging',
			title: 'RPE against target',
			summary: 'Bench press: Easier than prescribed.',
			data: {
				rows: [
					{ key: 'back_squat', label: 'Back squat', actual: 8, target: 8 },
					{ key: 'bench_press', label: 'Bench press', actual: 7, target: 8 }
				]
			}
		});
		expect(rpe.chart!.table.rows.map((r) => [r.label, ...r.values])).toEqual([
			['Back squat', '8', '8', '0', 'On target'],
			['Bench press', '7', '8', '−1', 'Easier']
		]);
		// The squat, on target, is in the chart alone; the average and the bench keep their lines.
		expect(rpe.items.map((i) => i.id)).toEqual(['rpe:average', 'rpe:bench_press']);
	});

	it('every lift on target says so; with no lift compared there is no chart', () => {
		const even = reviewSections(snapshot([lift('back_squat', 'Back squat', 8.3, 8, 'good')]));
		expect(byId(even, 'rpe').chart!.summary).toBe('Every lift was on its target RPE.');
		// A lift with no RPE against a target is not charted, so it keeps its line.
		const unrated = finding(
			'rpe:deadlift',
			'Deadlift RPE against target',
			'not_enough_data',
			'No RPE',
			[fig('Mean deviation', null), fig('Actual', null), fig('Target', null)]
		);
		const mixed = byId(
			reviewSections(snapshot([lift('back_squat', 'Back squat', 8, 8, 'good'), unrated])),
			'rpe'
		);
		expect(mixed.chart!.data.rows).toHaveLength(1);
		expect(mixed.items.map((i) => i.id)).toEqual(['rpe:deadlift']);
		const none = byId(reviewSections(snapshot([AVERAGE])), 'rpe');
		expect(none.chart).toBeNull();
		expect(none.items.map((i) => i.id)).toEqual(['rpe:average']);
	});

	it('hard sets per group as range bars against the range and the plan; a group with no range is a line', () => {
		const volume = byId(reviewSections(snapshot(ALL)), 'volume');
		expect(volume.chart).toMatchObject({
			body: 'range',
			title: 'Hard sets by muscle group',
			summary: '1 of 2 groups within range; above range: Quads.',
			data: {
				unit: 'sets',
				rows: [
					{
						key: 'chest',
						label: 'Chest',
						value: { value: 14, text: '14' },
						range: [10, 20],
						planned: { value: 12, text: '12' }
					},
					expect.objectContaining({ key: 'quads', range: [10, 20] })
				]
			}
		});
		expect(volume.chart!.table.rows.map((r) => [r.label, ...r.values])).toEqual([
			['Quads', '22', '10–20', '12', 'Above range'],
			['Chest', '14', '10–20', '12', 'Within range']
		]);
		expect(volume.items.map((i) => i.id)).toEqual(['volume:tonnage', 'volume:sets:neck']);
		expect(volume.items[0]!.figures).toEqual([
			{ label: 'This week', words: '6,200 kg', value: 6200 },
			{ label: 'The week before', words: '5,900 kg', value: 5900 }
		]);
	});

	it('a charted group to watch keeps its line, which says why', () => {
		const above = group('quads', 'Quads', 22, [6, 12]);
		above.verdict = { level: 'watch', words: 'Above the target range: 6–12 (10–20 × 0.6)' };
		const groups = [group('chest', 'Chest', 8, [6, 12]), above];
		const volume = byId(reviewSections(snapshot(groups)), 'volume');
		expect(volume.chart!.data.rows.map((r) => r.key).sort()).toEqual(['chest', 'quads']);
		expect(volume.items.map((i) => [i.id, i.words])).toEqual([
			['volume:sets:quads', 'Above the target range: 6–12 (10–20 × 0.6)']
		]);
	});

	it('fatigue lists its reasons apart from its advice', () => {
		const reasons = ['Soreness is high', 'Sleep is short'];
		const recovery = byId(reviewSections(snapshot(ALL, reasons)), 'recovery');
		expect(recovery.items.map((i) => [i.id, i.words, i.reasons])).toEqual([
			['fatigue', 'A deload is worth considering', reasons],
			['recovery:sleep', 'Enough sleep', []]
		]);
		const plain = finding('fatigue', 'Fatigue', 'watch', 'Soreness is high');
		const one = byId(reviewSections(snapshot([plain], ['Soreness is high'])), 'recovery');
		expect(one.items[0]).toMatchObject({
			words: '1 signal this week',
			reasons: ['Soreness is high']
		});
	});

	it('no conflicts and no PRs say so; a section with nothing else to show is left out', () => {
		const sections = reviewSections(snapshot([AVERAGE]));
		expect(sections.map((s) => s.id)).toEqual(['rpe', 'conflicts', 'prs']);
		expect(byId(sections, 'conflicts')).toMatchObject({
			verdict: { level: 'good', words: 'No sessions got in each other’s way this week' },
			items: []
		});
		expect(byId(sections, 'prs').verdict.words).toBe('No new records this week');
	});

	it('a conflict keeps its why, and more than one is counted', () => {
		const second = { ...CONFLICT, id: 'conflicts:2:x', label: 'Two hard days in a row' };
		const conflicts = byId(reviewSections(snapshot([CONFLICT, second])), 'conflicts');
		expect(conflicts.verdict.words).toBe(
			'2 conflicts: Long run the day after hard sparring and 1 more'
		);
		expect(conflicts.items[0]!.words).toBe(CONFLICT.verdict.words);
	});
});
