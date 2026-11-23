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
});
