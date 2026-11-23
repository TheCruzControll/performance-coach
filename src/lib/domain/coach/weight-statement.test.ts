import { describe, expect, it } from 'vitest';
import { parseWeightStatement, type WeightStatement } from './weight-statement';

/** The weights a message states, as the parser reads them, without the quote. */
const stated = (text: string) =>
	parseWeightStatement(text).map(({ quote: _quote, ...rest }) => rest);

describe('parseWeightStatement', () => {
	it('reads a weigh-in the owner gives with a day', () => {
		expect(stated('I weighed 82.4 this morning')).toEqual([
			{ value: 82.4, unit: null, day: 'today' }
		]);
		expect(stated('82.4 this morning')).toEqual([{ value: 82.4, unit: null, day: 'today' }]);
	});

	it('reads a comma decimal with its unit, a bare weigh-in', () => {
		expect(stated('82,4kg')).toEqual([{ value: 82.4, unit: 'kg', day: null }]);
	});

	it('reads yesterday’s weight in the unit the owner wrote', () => {
		expect(stated('yesterday I was 180 lb')).toEqual([
			{ value: 180, unit: 'lb', day: 'yesterday' }
		]);
	});

	it('reads a weight after a cue such as “I’m at” or “my weight is”', () => {
		expect(stated('I’m at 82.4 kg')).toEqual([{ value: 82.4, unit: 'kg', day: null }]);
		expect(stated('my weight is 82')).toEqual([{ value: 82, unit: null, day: null }]);
	});

	it('keeps the sentence the weight came from as the quote', () => {
		const [found] = parseWeightStatement('Long session. I weighed 82.4 this morning.');
		expect(found).toEqual({
			value: 82.4,
			unit: null,
			day: 'today',
			quote: 'I weighed 82.4 this morning.'
		} satisfies WeightStatement);
	});

	it('reads each weight the message states, in order', () => {
		expect(stated('I weighed 82.4 this morning. Yesterday I was 83.1 kg')).toEqual([
			{ value: 82.4, unit: null, day: 'today' },
			{ value: 83.1, unit: 'kg', day: 'yesterday' }
		]);
	});

	it('states nothing for a question', () => {
		expect(stated('is 82 good?')).toEqual([]);
		expect(stated('Am I 82.4 kg?')).toEqual([]);
	});

	it('states nothing for a hypothetical', () => {
		expect(stated('if I were 80, would I look leaner?')).toEqual([]);
		expect(stated('if I were 80…')).toEqual([]);
	});

	it('states nothing for someone else’s weight', () => {
		expect(stated('my partner weighs 60')).toEqual([]);
		expect(stated('my partner weighs 60 and I weigh 82.4 this morning')).toEqual([
			{ value: 82.4, unit: null, day: 'today' }
		]);
	});

	it('states nothing for a goal or a plan', () => {
		expect(stated("I'd weigh 80 by June")).toEqual([]);
		expect(stated('I want to weigh 80 by June')).toEqual([]);
	});

	it('states nothing for a number that is not a body weight', () => {
		expect(stated('I did 3 sets at 80kg')).toEqual([]);
		expect(stated("I'm doing 80kg squats")).toEqual([]);
		expect(stated('80kg')).toEqual([]);
	});

	it('states nothing for a weight the owner denies', () => {
		expect(stated("I didn't weigh 82.4 this morning")).toEqual([]);
		expect(stated("I'm not 82.4 kg")).toEqual([]);
	});

	it('states nothing when the message has no weight', () => {
		expect(stated('How did my session go?')).toEqual([]);
		expect(stated('')).toEqual([]);
	});

	it('states nothing for words after the weight in its clause', () => {
		expect(stated("I'm at 100 kg on squat now")).toEqual([]);
		expect(stated("I'm at 120 for deadlift")).toEqual([]);
		expect(stated("I'm 100 kg bench")).toEqual([]);
		expect(stated("I'm 180 cm")).toEqual([]);
		expect(stated("I'm 35 years old")).toEqual([]);
		expect(stated("I'm 30")).toEqual([]);
	});

	it('states a weight followed only by its day, “now”, “on the scale” or punctuation', () => {
		expect(stated('I weighed 82.4 on the scale')).toEqual([{ value: 82.4, unit: null, day: null }]);
		expect(stated('I’m at 82.4 kg now.')).toEqual([{ value: 82.4, unit: 'kg', day: 'today' }]);
		expect(stated('I weighed 82.4 this morning, down from 83')).toEqual([
			{ value: 82.4, unit: null, day: 'today' }
		]);
	});

	it('states nothing for a weight with a time that is not today or yesterday', () => {
		expect(stated('I was 85 last year')).toEqual([]);
		expect(stated('I was 95 kg when I started')).toEqual([]);
		expect(stated('I was 90 two years ago')).toEqual([]);
		expect(stated('I weighed 82.4 last week')).toEqual([]);
		expect(stated('I weighed 82.4 on Monday')).toEqual([]);
	});

	it('states nothing for a hypothetical anywhere in its sentence', () => {
		expect(stated("Suppose I cut, I'm at 78")).toEqual([]);
	});

	it('states nothing for a bare number with no unit and no day', () => {
		expect(stated('82.5')).toEqual([]);
		expect(stated('100')).toEqual([]);
		expect(stated('82.4 this morning')).toEqual([{ value: 82.4, unit: null, day: 'today' }]);
		expect(stated('82.4kg')).toEqual([{ value: 82.4, unit: 'kg', day: null }]);
	});

	it('states nothing for “and I” after another person’s subject', () => {
		expect(stated('my wife and I weigh 140')).toEqual([]);
	});

	it('reads each clause’s own day, so a sentence naming both days gives each its weight', () => {
		expect(stated('I was 82.4 yesterday but 82.0 today')).toEqual([
			{ value: 82.4, unit: null, day: 'yesterday' },
			{ value: 82, unit: null, day: 'today' }
		]);
	});

	it('states nothing for a clause with no day of its own when the sentence names both days', () => {
		expect(stated('Yesterday I was 82.4 kg, and I weighed 82, not today.')).toEqual([
			{ value: 82.4, unit: 'kg', day: 'yesterday' }
		]);
	});

	it('states nothing for a sentence about a past time, a doubt or either day', () => {
		expect(stated('Two years ago I was 95 kg')).toEqual([]);
		expect(stated('Last month I was 90 kg')).toEqual([]);
		expect(stated('In 2020 I weighed 90 kg')).toEqual([]);
		expect(stated('On Monday I weighed 82.4 kg')).toEqual([]);
		expect(stated('When I started I was 95 kg')).toEqual([]);
		expect(stated('Back in college I weighed 70 kg')).toEqual([]);
		expect(stated('Last week I was 83 kg, today I’m 82.4 kg')).toEqual([]);
		expect(stated('When I started the program I weighed 95 kg, and today I’m 82.4 kg')).toEqual([]);
		expect(stated('I weighed 82.4 kg, last Monday')).toEqual([]);
		expect(stated('I weighed 90 kg, 2 years ago')).toEqual([]);
		expect(stated('I weighed 90 kg, before the diet')).toEqual([]);
		expect(stated('I wish I was 78 kg')).toEqual([]);
		expect(stated('I don’t think I’m 82 kg')).toEqual([]);
		expect(stated('I thought I was 82 kg')).toEqual([]);
		expect(stated('I was told I’m 82 kg')).toEqual([]);
		expect(stated('I weighed 82 today or yesterday')).toEqual([]);
	});

	it('still states a weigh-in that names today, this morning, now or yesterday', () => {
		expect(stated('I weighed 82.4 this morning')).toEqual([
			{ value: 82.4, unit: null, day: 'today' }
		]);
		expect(stated('82.4kg')).toEqual([{ value: 82.4, unit: 'kg', day: null }]);
		expect(stated('I’m 82.4 kg, aiming for 78')).toEqual([{ value: 82.4, unit: 'kg', day: null }]);
		expect(stated('weighed in at 82.4 kg yesterday')).toEqual([
			{ value: 82.4, unit: 'kg', day: 'yesterday' }
		]);
		expect(stated('my weight is 82')).toEqual([{ value: 82, unit: null, day: null }]);
	});

	it('reads a weight with its own day when the sentence holds several weights', () => {
		expect(stated('I was 84 kg, but 82.0 today')).toEqual([
			{ value: 82, unit: null, day: 'today' }
		]);
		expect(stated('I was 84 kg but now 82.4')).toEqual([{ value: 82.4, unit: null, day: 'today' }]);
		expect(stated('I’m 82 kg though 80 kg yesterday')).toEqual([
			{ value: 80, unit: 'kg', day: 'yesterday' }
		]);
		expect(stated('I’m 100 kg, 120 kg yesterday')).toEqual([
			{ value: 120, unit: 'kg', day: 'yesterday' }
		]);
	});

	it('states nothing for “and I” after another person’s subject with a comma or semicolon', () => {
		expect(stated('my wife, and I weigh 82')).toEqual([]);
		expect(stated('my wife; and I weigh 82')).toEqual([]);
	});
});
