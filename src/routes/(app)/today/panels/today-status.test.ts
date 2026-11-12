import { describe, expect, it } from 'vitest';
import { todayStatus, type StatusWeek } from './today-status';

const card = (title: string, status = 'planned') => ({
	title,
	status,
	line: `${title} · 60 min · Moderate`
});

const WEEK: StatusWeek = {
	label: 'Week 3',
	today: '2026-11-11',
	days: [
		{ date: '2026-11-09', rest: null, cards: [card('Lower body', 'completed')] },
		{ date: '2026-11-10', rest: null, cards: [card('Easy run', 'skipped')] },
		{ date: '2026-11-11', rest: null, cards: [card('Full body'), card('Muay Thai class')] },
		{
			date: '2026-11-12',
			rest: 'Recovery is part of the plan. Next: Tempo run, Friday.',
			cards: []
		},
		{ date: '2026-11-13', rest: null, cards: [card('Tempo run')] }
	]
};

describe('Today’s Status Display', () => {
	it('names today’s session with its line, the week done against planned, and the connection', () => {
		expect(todayStatus(WEEK, true)).toEqual({
			label: 'Today’s session',
			line: 'Week 3',
			big: 'Full body',
			name: true,
			dim: 'Full body · 60 min · Moderate · and 1 more',
			// The skipped run counts neither way: 1 done of the 4 still meant to happen.
			bar: {
				label: 'Sessions done this week',
				start: 'This week',
				end: '1 of 4 done',
				progress: 0.25
			},
			foot: { icon: 'check', text: 'Plan up to date' }
		});
	});

	it('leads with the session still to do once one is done, and says when offline', () => {
		const week: StatusWeek = {
			...WEEK,
			days: WEEK.days.map((d) =>
				d.date === WEEK.today
					? { ...d, cards: [card('Full body', 'completed'), card('Muay Thai class')] }
					: d
			)
		};
		const status = todayStatus(week, false)!;
		expect(status.big).toBe('Muay Thai class');
		expect(status.bar?.end).toBe('2 of 4 done');
		expect(status.foot).toEqual({
			icon: 'wifi-off',
			text: 'Offline · the plan from your last visit'
		});
	});

	it('says a rest day in its own words, and has no display before the program starts', () => {
		const rest = todayStatus({ ...WEEK, today: '2026-11-12' }, true)!;
		expect(rest.big).toBe('Rest day');
		expect(rest.dim).toBe('Recovery is part of the plan. Next: Tempo run, Friday.');
		expect(todayStatus({ ...WEEK, today: null }, true)).toBeNull();
		const empty = todayStatus(
			{
				label: 'Week 1',
				today: '2026-11-11',
				days: [{ date: '2026-11-11', rest: null, cards: [] }]
			},
			true
		)!;
		expect(empty.bar).toBeNull();
	});

	it('says the changes waiting to sync, as the resume bar does, not "Plan up to date"', () => {
		expect(todayStatus(WEEK, true, { state: 'retrying', seconds: 4, pending: 2 })!.foot).toEqual({
			icon: 'refresh',
			text: '2 changes waiting to sync'
		});
		expect(todayStatus(WEEK, false, { state: 'offline', pending: 1 })!.foot).toEqual({
			icon: 'wifi-off',
			text: 'Offline · 1 change waiting to sync'
		});
		expect(todayStatus(WEEK, true, { state: 'synced' })!.foot?.text).toBe('Plan up to date');
	});
});
