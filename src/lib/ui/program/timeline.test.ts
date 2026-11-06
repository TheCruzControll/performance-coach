import { describe, expect, it } from 'vitest';
import type { GoalStatus } from '#lib/domain/profile/catalog.ts';
import { timelineView, type TimelineGoal, type TimelinePlan } from './timeline';

const GOAL = 'f1a7e000-0000-4000-8000-000000000001';
const OTHER = 'f1a7e000-0000-4000-8000-000000000009';

/** A baseline week and a four-week block from Monday 2 November 2026, then a three-week outline. */
const PLAN: TimelinePlan = {
	startsOn: '2026-11-02',
	blocks: [
		{
			phase: 'baseline',
			name: 'Baseline week',
			startsOn: '2026-11-02',
			endsOn: '2026-11-08',
			outline: false,
			goalRefs: [GOAL]
		},
		{
			phase: 'accumulation',
			name: 'Accumulation',
			startsOn: '2026-11-09',
			endsOn: '2026-12-06',
			outline: false,
			goalRefs: [GOAL]
		},
		{
			phase: 'realization',
			name: 'Build to Fight night',
			startsOn: '2026-12-07',
			endsOn: '2026-12-27',
			outline: true,
			goalRefs: [GOAL]
		}
	]
};

const goal = (over: Partial<TimelineGoal> = {}): TimelineGoal => ({
	id: GOAL,
	title: 'Fight night',
	eventDate: '2026-12-26',
	status: 'active',
	...over
});

describe('timelineView', () => {
	it('lists every block with its dates and length, and its weeks numbered from week 1', () => {
		const blocks = timelineView(PLAN, { today: '2026-11-04', goals: [] });
		expect(blocks.map((b) => [b.name, b.span, b.outline])).toEqual([
			['Baseline week', 'Mon 2 Nov – Sun 8 Nov · 1 week', false],
			['Accumulation', 'Mon 9 Nov – Sun 6 Dec · 4 weeks', false],
			['Build to Fight night', 'Mon 7 Dec – Sun 27 Dec · 3 weeks', true]
		]);
		expect(blocks.map((b) => b.weeks.map((w) => w.number))).toEqual([[1], [2, 3, 4, 5], [6, 7, 8]]);
		expect(blocks[1]!.weeks[0]).toMatchObject({ dates: 'Mon 9 Nov – Sun 15 Nov', planned: true });
		expect(blocks[2]!.weeks.every((w) => !w.planned)).toBe(true);
		// Each block has its own key, whatever its name.
		expect(new Set(blocks.map((b) => b.key)).size).toBe(3);
	});

	it('names the phase only where the block’s name does not already say it', () => {
		const blocks = timelineView(PLAN, { today: '2026-11-04', goals: [] });
		expect(blocks.map((b) => b.phase)).toEqual([null, null, 'Realization / peak']);
	});

	it('marks the week that holds the owner’s today, and its block, in planned and outline weeks', () => {
		const current = (today: string) =>
			timelineView(PLAN, { today, goals: [] }).flatMap((b) =>
				b.weeks.filter((w) => w.current).map((w) => [b.name, b.current, w.number])
			);
		expect(current('2026-11-02')).toEqual([['Baseline week', true, 1]]);
		expect(current('2026-11-22')).toEqual([['Accumulation', true, 3]]);
		// The first block is complete: today is in the outline.
		expect(current('2026-12-27')).toEqual([['Build to Fight night', true, 8]]);
		// Before the start and after the end, no week holds today.
		expect(current('2026-11-01')).toEqual([]);
		expect(current('2026-12-28')).toEqual([]);
		const blocks = timelineView(PLAN, { today: '2026-11-01', goals: [] });
		expect(blocks.some((b) => b.current)).toBe(false);
	});

	it('puts a dated goal the plan serves in the week it falls in', () => {
		const blocks = timelineView(PLAN, { today: '2026-11-04', goals: [goal()] });
		const events = blocks.flatMap((b) =>
			b.weeks.flatMap((w) => w.events.map((e) => [w.number, e.title, e.date]))
		);
		expect(events).toEqual([[8, 'Fight night', 'Sat 26 Dec']]);
	});

	it('leaves out an event the plan does not lead to: another goal’s, a dropped one, one outside the plan', () => {
		const events = (goals: TimelineGoal[]) =>
			timelineView(PLAN, { today: '2026-11-04', goals }).flatMap((b) =>
				b.weeks.flatMap((w) => w.events.map((e) => e.title))
			);
		expect(events([goal({ id: OTHER })])).toEqual([]);
		expect(events([goal({ status: 'dropped' })])).toEqual([]);
		expect(events([goal({ eventDate: null })])).toEqual([]);
		expect(events([goal({ eventDate: '2026-12-28' })])).toEqual([]);
		expect(events([goal({ eventDate: '2026-11-01' })])).toEqual([]);
		// A paused or achieved goal's date is still on the plan the block was built for.
		for (const status of ['paused', 'achieved'] satisfies GoalStatus[]) {
			expect(events([goal({ status })])).toEqual(['Fight night']);
		}
		// Its first and last days are in.
		expect(events([goal({ eventDate: '2026-11-02' }), goal({ eventDate: '2026-12-27' })])).toEqual([
			'Fight night',
			'Fight night'
		]);
	});
});
