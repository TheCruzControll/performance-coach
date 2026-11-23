/**
 * proposeAgain's pure half (services/periodisation/propose.ts): a deload whose week has passed is
 * asked for again in the week holding today, and any other directive is asked for as it was. The
 * service itself runs on Postgres (tests/integration/coach/propose-again.test.ts).
 */
import { describe, expect, it } from 'vitest';
import type { ReplanDirective } from '../../../domain/training/replan';
import { movedToThisWeek } from './propose';

const deload = (week: string): ReplanDirective => ({
	kind: 'deload',
	week,
	trigger: 'owner',
	reasons: ['Legs heavy since the weekend']
});

describe('movedToThisWeek', () => {
	it('moves a deload whose week has passed to the Monday of the week holding today', () => {
		// Wednesday 18 Nov 2026: the week of 9 Nov has passed, this week began on Monday 16 Nov.
		expect(movedToThisWeek(deload('2026-11-09'), '2026-11-18')).toEqual(deload('2026-11-16'));
	});

	it('takes the Monday of a Sunday’s week, which still holds the day', () => {
		// Sunday 22 Nov 2026 belongs to the week that began on Monday 16 Nov.
		expect(movedToThisWeek(deload('2026-11-09'), '2026-11-22')).toEqual(deload('2026-11-16'));
	});

	it('keeps a deload whose week holds today or is still ahead as it is', () => {
		for (const week of ['2026-11-16', '2026-11-23']) {
			const directive = deload(week);
			expect(movedToThisWeek(directive, '2026-11-18')).toBe(directive);
		}
	});

	it('keeps every other directive as it is', () => {
		const priorities: ReplanDirective = { kind: 'priorities', cause: 'reorder' };
		const block: ReplanDirective = { kind: 'block', phase: 'maintenance', weeks: 4 };
		expect(movedToThisWeek(priorities, '2026-11-18')).toBe(priorities);
		expect(movedToThisWeek(block, '2026-11-18')).toBe(block);
	});
});
