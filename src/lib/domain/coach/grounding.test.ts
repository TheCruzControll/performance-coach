import { describe, expect, it } from 'vitest';
import { parseAnswer } from './answer.ts';
import { checkGrounding, collectEvidence } from './grounding.ts';

const history = {
	best: { value: 102.5, unit: 'kg', sources: [{ type: 'set', id: 'set-1', date: '2026-11-02' }] },
	note: { untrusted_text: 'Felt quick at 1,000 m' }
};
const week = { sessions: 3, sources: [{ type: 'version', id: '4' }] };
const evidence = collectEvidence([history, week]);
const block = (text: string) => parseAnswer(text)[0]!;

describe('collectEvidence', () => {
	it('keeps refs, dates and each document’s numbers under its own refs', () => {
		expect([...evidence.refs].sort()).toEqual(['set:set-1', 'version:4']);
		expect(evidence.dates.has('2026-11-02')).toBe(true);
		expect(evidence.numbers.get('set:set-1')).toContain('102.5 kg');
		expect(evidence.numbers.get('set:set-1')).not.toContain('102.5');
		expect(evidence.numbers.get('set:set-1')).toContain('1000 m');
		expect(evidence.numbers.get('version:4')).toContain('3');
		expect(evidence.numbers.get('version:4')).not.toContain('102.5');
	});
});

describe('checkGrounding', () => {
	it('passes a fact whose refs and numbers the evidence holds', () => {
		for (const text of [
			'[fact] Your best set was 102.5 kg [[set:set-1|Mon squat]].',
			'[fact] You ran 1,000 m [[set:set-1]] on [[date:2026-11-02]].',
			'[metric method=sessions counted] 3 sessions this week [[version:4|v4]].'
		])
			expect(checkGrounding(block(text), evidence), text).toMatchObject({ grounded: true });
	});

	it('flags an unknown ref, a number the cited document lacks, and a fact citing nothing', () => {
		expect(checkGrounding(block('[fact] A record [[workout:w-9|PR]].'), evidence)).toEqual({
			grounded: false,
			uncited: false,
			unknownRefs: ['workout:w-9'],
			unmatchedNumbers: []
		});
		// 3 is in the version's document, not the set's.
		expect(checkGrounding(block('[fact] 3 sets at 102.5 kg [[set:set-1]].'), evidence)).toEqual({
			grounded: false,
			uncited: false,
			unknownRefs: [],
			unmatchedNumbers: ['3 sets']
		});
		expect(checkGrounding(block('[fact] You lifted 100 kg.'), evidence)).toEqual({
			grounded: false,
			uncited: true,
			unknownRefs: [],
			unmatchedNumbers: ['100 kg']
		});
		expect(checkGrounding(block('[fact] On [[date:2026-11-03]].'), evidence).unknownRefs).toEqual([
			'date:2026-11-03'
		]);
	});

	it('checks the quantity as rendered, with its unit', () => {
		for (const text of [
			'[fact] Your best was **999** kg [[set:set-1|the log]].',
			'[fact] Your best was *999* kg [[set:set-1|the log]].',
			'[fact] Your run was 102.5 km [[set:set-1|the log]].'
		])
			expect(checkGrounding(block(text), evidence), text).toMatchObject({ grounded: false });
		expect(
			checkGrounding(block('[fact] Your best was **102.5 kgs** [[set:set-1]].'), evidence)
		).toMatchObject({ grounded: true });
	});

	it('reads units at a word end only, and checks no other block kind', () => {
		expect(checkGrounding(block('[fact] 5 mph [[set:set-1]].'), evidence).grounded).toBe(true);
		expect(checkGrounding(block('[recommendation] Add 2.5 kg next week.'), evidence).grounded).toBe(
			true
		);
	});
});
