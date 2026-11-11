import { describe, expect, it } from 'vitest';
import { EMPTY_TILES, NOTHING_YET, weekView, type WeekFigures } from './week-words';

/** A Wednesday. */
const WEDNESDAY = '2026-11-11';

const figures = (over: Partial<WeekFigures> = {}): WeekFigures => ({
	week: { through: WEDNESDAY },
	units: { distance: 'km' },
	logged: true,
	sessions: { value: 3, lastWeek: 2 },
	load: { value: 1249.6, lastWeek: 380 },
	distance: { value: 8240, lastWeek: 5000 },
	...over
});

const values = (view: ReturnType<typeof weekView>) =>
	view.tiles.map((t) => [t.label, t.value, t.unit ?? null]);

describe('Today’s This week in words', () => {
	it('shows each figure of the week so far, and the same days of last week in one line', () => {
		const view = weekView(figures());
		expect(values(view)).toEqual([
			['Sessions', '3', null],
			['Training load', '1,250', null],
			['Distance', '8.2', 'km']
		]);
		expect(view.against).toBe('By Wednesday last week: 2 sessions, training load 380, 5 km.');
	});

	it('reads an empty week as 0 once anything is logged, never no data yet', () => {
		const view = weekView(
			figures({
				sessions: { value: null, lastWeek: 1 },
				load: { value: null, lastWeek: 315 },
				distance: { value: null, lastWeek: null }
			})
		);
		expect(view.tiles.map((t) => t.value)).toEqual(['0', '0', '0']);
		// One session agrees with its number.
		expect(view.against).toBe('By Wednesday last week: 1 session, training load 315, 0 km.');
	});

	it('says when nothing was logged by the same day last week', () => {
		const view = weekView(
			figures({
				sessions: { value: 1, lastWeek: null },
				load: { value: 300, lastWeek: null },
				distance: { value: null, lastWeek: null }
			})
		);
		expect(view.against).toBe('Nothing logged by Wednesday last week.');
	});

	it('shows distance in the profile’s unit', () => {
		const view = weekView(
			figures({ units: { distance: 'mi' }, distance: { value: 16093.44, lastWeek: 8046.72 } })
		);
		expect(view.tiles[2]).toMatchObject({ value: '10', unit: 'mi' });
		expect(view.against).toMatch(/, 5 mi\.$/);
	});

	it('never invents a load for sessions logged without minutes or an RPE, and says what it needs', () => {
		const view = weekView(
			figures({ sessions: { value: 2, lastWeek: 1 }, load: { value: null, lastWeek: null } })
		);
		expect(view.tiles[1]).toMatchObject({ value: null, caption: 'Needs an RPE' });
		expect(view.against).toBe('By Wednesday last week: 1 session, 5 km.');
	});

	it('before the first session, every tile reads no data yet', () => {
		const view = weekView(figures({ logged: false }));
		expect(view.tiles).toEqual(EMPTY_TILES);
		expect(view.against).toBe(NOTHING_YET);
	});
});
