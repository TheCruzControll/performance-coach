import { describe, expect, it } from 'vitest';
import type { SessionStatus } from '#lib/domain/training/vocabulary.ts';
import {
	headsUps,
	inWords,
	weekLines,
	weekNote,
	weekPosition,
	weekStatus,
	weekTitle,
	type LineDay,
	type WeekNoteParts
} from './week-lines';

// The week of Monday 16 November 2026; 'today' is Saturday 21.
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const s = (title: string, status: SessionStatus = 'planned', estMinutes = 60) => ({
	lineage: title.toLowerCase().replace(/ /g, '-'),
	title,
	status,
	estMinutes
});
const week = (...days: ReturnType<typeof s>[][]): LineDay[] =>
	WEEKDAYS.map((weekday, i) => ({
		date: `2026-11-${String(16 + i).padStart(2, '0')}`,
		weekday,
		sessions: days[i] ?? []
	}));
const TODAY = '2026-11-21';
const PAPER = week(
	[s('Lower body', 'completed')],
	[s('Intervals', 'completed')],
	[s('Full body', 'completed')],
	[s('Muay Thai class', 'completed', 90)],
	[],
	[s('Long run', 'planned', 45)],
	[s('Upper body', 'planned', 50)]
);

describe('weekLines', () => {
	it('reads Paper’s week: ticks before today, Today by name, lengths ahead, Rest', () => {
		const lines = weekLines(PAPER, TODAY);
		expect(lines.map((l) => [l.day, l.title, l.when, l.end])).toEqual([
			['Mon', 'Lower body', 'past', { done: true }],
			['Tue', 'Intervals', 'past', { done: true }],
			['Wed', 'Full body', 'past', { done: true }],
			['Thu', 'Muay Thai class', 'past', { done: true }],
			['Fri', 'Rest', 'past', null],
			['Today', 'Long run', 'today', { text: '45 min' }],
			['Sun', 'Upper body', 'ahead', { text: '50 min' }]
		]);
		expect(lines[0]!.session).toEqual({ lineage: 'lower-body', status: 'completed' });
		expect(lines[4]!.session).toBeUndefined();
		expect(lines[0]!.name).toBe('Monday 16 November, Lower body, done');
		expect(lines[4]!.name).toBe('Friday 20 November, rest');
		expect(lines[6]!.name).toBe('Sunday 22 November, Upper body, 50 min');
	});

	it('says Skipped, and gives a day’s second session its own line with the day left blank', () => {
		const lines = weekLines(
			week([s('Tempo run', 'skipped')], [s('Squat'), s('Easy run', 'planned', 30)]),
			TODAY
		);
		expect(lines[0]!.end).toEqual({ text: 'Skipped' });
		expect(lines[0]!.name).toBe('Monday 16 November, Tempo run, skipped');
		expect(lines.slice(1, 3).map((l) => [l.day, l.title, l.date])).toEqual([
			['Tue', 'Squat', '2026-11-17'],
			['', 'Easy run', '2026-11-17']
		]);
		expect(lines).toHaveLength(8);
	});
});

describe('weekTitle', () => {
	it('names the weeks around today, and any other by number', () => {
		expect(weekTitle('2026-11-16', TODAY, 3)).toBe('This week');
		expect(weekTitle('2026-11-09', TODAY, 2)).toBe('Last week');
		expect(weekTitle('2026-11-23', TODAY, 4)).toBe('Next week');
		expect(weekTitle('2026-11-30', TODAY, 5)).toBe('Week 5');
		expect(weekTitle('2026-11-02', TODAY, 1)).toBe('Week 1');
	});
});

describe('weekStatus', () => {
	it('counts what is done in words', () => {
		expect(weekStatus(PAPER, TODAY)).toBe('Four of six done');
		expect(weekStatus(PAPER, '2026-11-30')).toBe('Four of six done');
	});

	it('says a week ahead starts on its Monday, or on the program’s first day', () => {
		expect(weekStatus(PAPER, '2026-11-15')).toBe('Starts Monday 16 November');
		expect(weekStatus(PAPER, '2026-11-15', '2026-11-18')).toBe('Starts Wednesday 18 November');
		expect(weekStatus(PAPER, '2026-11-15', '2026-11-09')).toBe('Starts Monday 16 November');
	});

	it('counts the week’s sessions before any is done, says when all are, and a past week’s none', () => {
		const none = week([s('A')], [s('B')]);
		expect(weekStatus(none, '2026-11-16')).toBe('Two sessions this week');
		expect(weekStatus(week([s('A')]), '2026-11-16')).toBe('One session this week');
		expect(weekStatus(none, '2026-11-23')).toBe('None of two done');
		expect(weekStatus(week([s('A', 'completed')], [s('B', 'completed')]), TODAY)).toBe(
			'All two done'
		);
		expect(weekStatus(week([s('A', 'completed')]), TODAY)).toBe('Done');
		expect(weekStatus(week(), TODAY)).toBe('Nothing planned');
	});

	it('writes numbers past twelve as digits', () => {
		expect(inWords(12)).toBe('twelve');
		expect(inWords(13)).toBe('13');
	});
});

describe('weekNote', () => {
	const none: WeekNoteParts = {
		summary: null,
		findings: 0,
		review: false,
		kind: null,
		baseline: false,
		replan: false,
		why: false
	};

	it('says the findings first, and opens the note', () => {
		expect(
			weekNote({
				...none,
				summary: '2 heads-ups this week',
				findings: 2,
				review: true,
				baseline: true
			})
		).toEqual({ text: '2 heads-ups this week', opens: true });
	});

	it('then a review’s changes, the week’s kind, week 1’s brief and a re-plan', () => {
		const clean = { ...none, summary: 'No clashes this week' };
		expect(weekNote({ ...clean, review: true, kind: 'Deload week' })).toEqual({
			text: 'Updated from your weekly review',
			opens: true
		});
		expect(weekNote({ ...clean, kind: 'Deload week', baseline: true })).toEqual({
			text: 'Deload week',
			opens: true
		});
		expect(weekNote({ ...clean, baseline: true })).toEqual({
			text: 'What week 1 is for',
			opens: true
		});
		expect(weekNote({ ...none, replan: true })).toEqual({
			text: 'Your coach suggests a new plan',
			opens: true
		});
	});

	it('keeps a clean summary as a plain line, which opens only when a day says why', () => {
		expect(weekNote({ ...none, summary: 'No clashes this week' })).toEqual({
			text: 'No clashes this week',
			opens: false
		});
		expect(weekNote({ ...none, summary: 'No clashes this week', why: true })).toEqual({
			text: 'No clashes this week',
			opens: true
		});
		expect(weekNote({ ...none, why: true })).toEqual({
			text: 'Why each day holds its session',
			opens: true
		});
		expect(weekNote(none)).toBeNull();
	});
});

describe('headsUps', () => {
	it('lists each finding once, in the week’s order', () => {
		const a = { text: 'Heads-up · Heavy legs before intervals', why: 'x' };
		const b = { text: 'Trade-off · Two sessions on Sunday', why: 'y' };
		expect(
			headsUps({ squat: a, intervals: a, long: b }, ['long', 'squat', 'intervals', 'rest'])
		).toEqual([b, a]);
	});
});

describe('weekPosition', () => {
	it('puts the week first and its block after', () => {
		expect(weekPosition(3, 14, 'Build')).toBe('Week 3 of 14 · Build');
		expect(weekPosition(9, null, 'Peak')).toBe('Week 9 · Peak');
		expect(weekPosition(20, null, null)).toBe('Week 20');
	});
});
