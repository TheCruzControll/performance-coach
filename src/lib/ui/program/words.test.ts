import { describe, expect, it } from 'vitest';
import type { SessionStatus, SessionType } from '#lib/domain/training/vocabulary.ts';
import {
	cardView,
	dayName,
	longDate,
	sessionLine,
	shortDate,
	statusWords,
	stripDay,
	type CardSession,
	type StripDay
} from './words';

const day = (date: string, weekday: StripDay['weekday'], ...statuses: SessionStatus[]) => ({
	date,
	weekday,
	sessions: statuses.map((status) => ({ type: 'strength' as SessionType, status }))
});

describe('dayName', () => {
	it('names the day and month from the calendar string, and counts its sessions', () => {
		expect(dayName(day('2026-11-02', 'mon', 'planned'), null)).toBe('Monday 2 November, 1 session');
		expect(dayName(day('2027-01-01', 'fri', 'planned', 'planned'), null)).toBe(
			'Friday 1 January, 2 sessions'
		);
		expect(dayName(day('2026-12-31', 'thu'), null)).toBe('Thursday 31 December, no sessions');
	});

	it('marks today only when the server says so, whatever the device clock reads', () => {
		const wednesday = day('2026-11-04', 'wed', 'planned');
		expect(dayName(wednesday, '2026-11-04')).toBe('Wednesday 4 November, today, 1 session');
		expect(dayName(wednesday, '2026-11-05')).toBe('Wednesday 4 November, 1 session');
	});

	it('says how many sessions are done and skipped; moved and planned ones only count', () => {
		const tuesday = day('2026-11-03', 'tue', 'completed', 'skipped', 'moved', 'completed');
		expect(dayName(tuesday, null)).toBe('Tuesday 3 November, 4 sessions, 2 done, 1 skipped');
	});
});

describe('longDate and shortDate', () => {
	it('read a calendar string in words, whatever the device clock or zone says', () => {
		expect(longDate('2026-11-09')).toBe('Monday 9 November');
		expect(longDate('2027-01-01')).toBe('Friday 1 January');
		expect(shortDate('2026-11-09')).toBe('Mon 9 Nov');
		expect(shortDate('2026-09-30')).toBe('Wed 30 Sep');
		expect(shortDate('2028-02-29')).toBe('Tue 29 Feb');
	});
});

const session = (over: Partial<CardSession>): CardSession => ({
	title: 'Lower body',
	type: 'strength',
	customDiscipline: null,
	estMinutes: 60,
	intensity: 'hard',
	timeOfDay: 'evening',
	status: 'planned',
	movedFrom: null,
	...over
});

describe('sessionLine', () => {
	it('reads type · minutes · intensity · time of day in words', () => {
		expect(sessionLine(session({}))).toBe('Strength · 60 min · Hard · Evening');
		expect(
			sessionLine(session({ type: 'interval_run', estMinutes: 45, intensity: 'very_hard' }))
		).toBe('Intervals · 45 min · Very hard · Evening');
	});

	it('leaves the time of day out when it is unknown or varies', () => {
		expect(sessionLine(session({ timeOfDay: null }))).toBe('Strength · 60 min · Hard');
		expect(sessionLine(session({ type: 'muay_thai', timeOfDay: 'varies' }))).toBe(
			'Muay Thai · 60 min · Hard'
		);
	});

	it("names a custom session's own discipline, and says Custom only without one", () => {
		const custom = session({ type: 'custom', customDiscipline: 'Climbing', intensity: 'moderate' });
		expect(sessionLine(custom)).toBe('Climbing · 60 min · Moderate · Evening');
		expect(sessionLine({ ...custom, customDiscipline: null })).toBe(
			'Custom · 60 min · Moderate · Evening'
		);
	});
});

describe('statusWords', () => {
	it('shows nothing while planned, and the status in words otherwise', () => {
		expect(statusWords(session({}))).toBeNull();
		expect(statusWords(session({ status: 'skipped' }))).toBe('Skipped');
		expect(statusWords(session({ status: 'completed' }))).toBe('Done');
	});

	it('names the weekday a moved session left, from its calendar date', () => {
		expect(statusWords(session({ status: 'moved', movedFrom: '2026-11-02' }))).toBe(
			'Moved from Mon'
		);
		expect(statusWords(session({ status: 'moved', movedFrom: '2026-11-08' }))).toBe(
			'Moved from Sun'
		);
		expect(statusWords(session({ status: 'moved' }))).toBe('Moved');
	});
});

describe('stripDay and cardView', () => {
	it('compose every word the strip and the card lay out, so neither ships the vocabulary', () => {
		expect(stripDay(day('2026-11-04', 'wed', 'planned', 'skipped'), '2026-11-04')).toEqual({
			date: '2026-11-04',
			name: 'Wednesday 4 November, today, 2 sessions, 1 skipped',
			letter: 'W',
			short: 'Wed',
			dots: [
				{ tone: 'strength', skipped: false },
				{ tone: 'strength', skipped: true }
			]
		});
		expect(
			cardView(session({ type: 'easy_run', status: 'moved', movedFrom: '2026-11-02' }))
		).toEqual({
			title: 'Lower body',
			status: 'moved',
			line: 'Easy run · 60 min · Hard · Evening',
			statusWords: 'Moved from Mon',
			tone: 'running'
		});
	});
});
