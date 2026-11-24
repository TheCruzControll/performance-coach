import { describe, expect, it } from 'vitest';
import {
	blockEndWords,
	bridgeLead,
	coachLine,
	completeLead,
	doneLabel,
	doneLine,
	dotMark,
	goalEnd,
	kindWord,
	lineLabel,
	minutesWords,
	restLine,
	skippedLine,
	startsTitle,
	whenLine,
	whenWords,
	type DaySession
} from './day-words';

/** Wednesday 18 November 2026. */
const TODAY = '2026-11-18';

const s = (o: Partial<DaySession> = {}): DaySession => ({
	lineage: 'a',
	title: 'Full body',
	kind: 'strength',
	type: 'strength',
	customDiscipline: null,
	estMinutes: 60,
	timeOfDay: 'morning',
	status: 'planned',
	movedFrom: null,
	source: 'generator',
	line: 'Squat · Bench · Row',
	date: TODAY,
	...o
});

const plain = { baseline: false, first: false, weekKind: null };

describe('when a session is', () => {
	it('says when, what kind and how long', () => {
		expect(whenLine(s(), TODAY)).toBe('This morning · strength · about 60 min');
		expect(
			whenLine(
				s({ kind: 'run', type: 'interval_run', estMinutes: 40, timeOfDay: 'evening' }),
				TODAY
			)
		).toBe('This evening · run · about 40 min');
		expect(whenLine(s(), TODAY, true)).toBe('Your first session · strength · about 60 min');
		expect(
			whenLine(
				s({
					kind: 'other',
					type: 'muay_thai',
					estMinutes: 90,
					timeOfDay: 'evening',
					source: 'commitment',
					date: '2026-11-19'
				}),
				TODAY
			)
		).toBe('Tomorrow evening · class · 90 min');
		expect(whenLine(s({ timeOfDay: null, date: '2026-11-21' }), TODAY)).toBe(
			'Saturday · strength · about 60 min'
		);
	});

	it('names the part of the day, today, tomorrow or on its weekday', () => {
		expect(whenWords('2026-11-18', TODAY, 'early_morning')).toBe('Early this morning');
		expect(whenWords('2026-11-18', TODAY, 'midday')).toBe('At midday');
		expect(whenWords('2026-11-19', TODAY, 'early_morning')).toBe('Early tomorrow morning');
		expect(whenWords('2026-11-21', TODAY, 'afternoon')).toBe('Saturday afternoon');
		expect(whenWords('2026-11-18', TODAY, 'varies')).toBe('Today');
	});

	it('names the kind in a word', () => {
		const kind = (o: Partial<DaySession>) => kindWord(s(o));
		expect(kind({})).toBe('strength');
		expect(kind({ kind: 'run', type: 'easy_run' })).toBe('run');
		expect(kind({ kind: 'other', type: 'muay_thai' })).toBe('class');
		expect(kind({ kind: 'other', type: 'strength_class' })).toBe('class');
		expect(kind({ kind: 'other', type: 'conditioning' })).toBe('conditioning');
		expect(kind({ kind: 'other', type: 'strength_conditioning' })).toBe('conditioning');
		expect(kind({ kind: 'other', type: 'mobility' })).toBe('mobility');
		expect(kind({ kind: 'other', type: 'custom', customDiscipline: 'Climbing' })).toBe('climbing');
		expect(kind({ kind: 'other', type: 'custom', customDiscipline: null })).toBe('session');
	});
});

describe('the coach’s sentence', () => {
	it('is chosen: moved, then baseline, then the week’s kind, then the session’s words', () => {
		expect(coachLine(s({ movedFrom: '2026-11-21' }), plain)).toBe('You moved this from Saturday.');
		expect(coachLine(s(), { baseline: true, first: true, weekKind: null })).toBe(
			'Start light today. I’ll set your weights from how these sets feel.'
		);
		expect(coachLine(s(), { baseline: true, first: false, weekKind: null })).toBe(
			'Baseline week. Finish every set with two reps still in you.'
		);
		expect(
			coachLine(s({ kind: 'run', type: 'easy_run' }), {
				baseline: true,
				first: false,
				weekKind: null
			})
		).toBe('Baseline week. Go at the effort shown.');
		expect(
			coachLine(s(), {
				baseline: false,
				first: false,
				weekKind: { label: 'Deload week', why: 'lighter loads so you recover before Peak' }
			})
		).toBe('Deload week. Lighter loads so you recover before Peak.');
		expect(coachLine(s(), plain)).toBe('Squat · Bench · Row.');
	});

	it('says nothing rather than a lone full stop when the session has no words', () => {
		expect(coachLine(s({ line: '' }), plain)).toBeNull();
	});
});

describe('a day with nothing to start', () => {
	it('a rest day counts what is done this week', () => {
		expect(restLine(0)).toBe('Nothing planned. Recovery is part of the plan.');
		expect(restLine(1)).toBe('Nothing planned. One session done this week, so let it land.');
		expect(restLine(4)).toBe('Nothing planned. Four sessions done this week, so let them land.');
	});

	it('a skipped day names what was skipped', () => {
		expect(skippedLine(['Long run'])).toBe('Long run. The rest of the week stays as it is.');
		expect(skippedLine(['Tempo run', 'Upper body'])).toBe(
			'Tempo run and Upper body. The rest of the week stays as it is.'
		);
	});

	it('a done day says how long, once every length is known', () => {
		expect(minutesWords(58)).toBe('58 min');
		expect(minutesWords(60)).toBe('1 h');
		expect(minutesWords(88)).toBe('1 h 28 min');
		expect(minutesWords(125)).toBe('2 h 5 min');
		expect(doneLine([{ ...s(), seconds: 3480 }], TODAY)).toBe('This morning · Full body · 58 min');
		expect(
			doneLine(
				[
					{ ...s(), seconds: 3480 },
					{ ...s({ title: 'Easy run', timeOfDay: 'evening' }), seconds: 1800 }
				],
				TODAY
			)
		).toBe('Two sessions · 1 h 28 min');
		expect(doneLine([{ ...s(), seconds: null }], TODAY)).toBe('This morning · Full body');
	});
});

describe('the lines and the states', () => {
	it('labels a line by when its session is', () => {
		expect(lineLabel('2026-11-18', TODAY)).toBe('Later');
		expect(lineLabel('2026-11-19', TODAY)).toBe('Tomorrow');
		expect(lineLabel('2026-11-23', TODAY)).toBe('Monday');
		expect(lineLabel('2026-11-25', TODAY)).toBe('Wed 25 Nov');
		expect(doneLabel(s())).toBe('Morning');
		expect(doneLabel(s({ timeOfDay: null }))).toBe('Wed');
	});

	it('names the start, the bridge and the end of the planned weeks', () => {
		expect(startsTitle('2026-11-23', TODAY)).toBe('Monday');
		expect(startsTitle('2026-11-30', TODAY)).toBe('Monday 30 November');
		expect(bridgeLead('Peak', '2027-01-04')).toBe(
			'Between blocks · Peak starts Monday 4 January. Nothing is planned until then, so train as you like.'
		);
		expect(bridgeLead(null, '2027-01-04')).toBe(
			'Between blocks · Your next block starts Monday 4 January. Nothing is planned until then, so train as you like.'
		);
		expect(completeLead(14, '2026-11-02', '2027-02-07')).toBe(
			'All 14 weeks trained · You trained 2 November to 7 February. I plan the next block from how this one went.'
		);
		expect(completeLead(6, '2026-11-02', '2026-12-13')).toMatch(/^All six weeks trained · /);
		expect(completeLead(1, '2026-10-26', '2026-11-01')).toMatch(
			/^One week trained · You trained 26 October to 1 November\./
		);
	});

	it('says a block’s end: its weeks and name, then the block after it', () => {
		expect(blockEndWords({ weeks: 6, name: 'Build', next: 'Peak' })).toEqual({
			title: 'Done',
			when: 'Six weeks of Build',
			coach: 'Let’s look at what it built, then I’ll set up Peak with you.'
		});
		const counted = blockEndWords({ weeks: 6, name: 'Build', done: 33, planned: 36, next: null });
		expect(counted.when).toBe('Six weeks of Build · 33 of 36 sessions');
		expect(counted.coach).toBe(
			'Let’s look at what it built, then I’ll plan what comes next with you.'
		);
		expect(blockEndWords({ weeks: 1, name: 'Base', next: null }).when).toBe('One week of Base');
		expect(blockEndWords({ weeks: 14, name: 'Base', next: null }).when).toBe('14 weeks of Base');
	});

	it('counts the weeks to the top goal’s date', () => {
		expect(goalEnd('2027-04-14', TODAY)).toBe('21 weeks to go');
		expect(goalEnd('2026-11-24', TODAY)).toBe('Less than a week to go');
		expect(goalEnd('2026-11-25', TODAY)).toBe('1 week to go');
		expect(goalEnd('2026-11-01', TODAY)).toBeNull();
		expect(goalEnd(null, TODAY)).toBeNull();
	});

	it('marks each day of the week', () => {
		const past = '2026-11-16';
		const future = '2026-11-20';
		expect(dotMark([], past, TODAY)).toBe('rest');
		expect(dotMark(['completed'], past, TODAY)).toBe('done');
		expect(dotMark(['completed'], TODAY, TODAY)).toBe('today-done');
		expect(dotMark(['skipped'], past, TODAY)).toBe('skipped');
		expect(dotMark(['completed', 'skipped'], past, TODAY)).toBe('done');
		expect(dotMark(['planned'], TODAY, TODAY)).toBe('today');
		expect(dotMark(['completed', 'planned'], TODAY, TODAY)).toBe('today');
		expect(dotMark(['planned'], future, TODAY)).toBe('planned');
		expect(dotMark(['moved'], future, TODAY)).toBe('planned');
	});
});
