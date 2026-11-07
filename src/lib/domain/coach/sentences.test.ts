import { describe, expect, it } from 'vitest';
import { clauseBoundaries, sentenceBoundaries, splitClauses, splitSentences } from './sentences';

const sentences = (text: string) => splitSentences(text).map((s) => s.text);
const clauses = (text: string) => splitClauses(text).map((s) => s.text);

describe('splitSentences', () => {
	it('ends a sentence at . ! ? or … that whitespace follows', () => {
		expect(sentences('Squat today. Rest tomorrow! Ready? Good… Go')).toEqual([
			'Squat today.',
			'Rest tomorrow!',
			'Ready?',
			'Good…',
			'Go'
		]);
		expect(sentences('Really?! Yes...  Now.')).toEqual(['Really?!', 'Yes...', 'Now.']);
	});

	it('keeps closing quotes and brackets with their sentence', () => {
		expect(sentences('She said "stop." Then rest. (It helps.) Next')).toEqual([
			'She said "stop."',
			'Then rest.',
			'(It helps.)',
			'Next'
		]);
	});

	it('keeps decimals, abbreviations and initials intact', () => {
		expect(sentences('Lift 102.5 kg, e.g. for 3 sets. Rest approx. 2 min. between them.')).toEqual([
			'Lift 102.5 kg, e.g. for 3 sets.',
			'Rest approx. 2 min. between them.'
		]);
		expect(sentences('Squats vs. lunges, i.e. knee-dominant work etc. Done.')).toEqual([
			'Squats vs. lunges, i.e. knee-dominant work etc. Done.'
		]);
		expect(sentences('Ask J. Smith first. Then train.')).toEqual([
			'Ask J. Smith first.',
			'Then train.'
		]);
	});

	it('keeps list items whole, one per line', () => {
		expect(
			sentences('Today:\n1. Back squat 5 × 5.\n2. Romanian deadlift 3 × 8\n- Plank. 3 rounds')
		).toEqual([
			'Today:',
			'1. Back squat 5 × 5.',
			'2. Romanian deadlift 3 × 8',
			'- Plank.',
			'3 rounds'
		]);
		expect(sentences('a. Bench\nb. Row')).toEqual(['a. Bench', 'b. Row']);
		expect(sentences('Week 3. Then deload')).toEqual(['Week 3.', 'Then deload']);
	});

	it('never splits inside a ref, even an unclosed one', () => {
		expect(sentences('See [[workout:w1|Mon. 3 Nov. session]]. Next')).toEqual([
			'See [[workout:w1|Mon. 3 Nov. session]].',
			'Next'
		]);
		expect(sentences('See [[workout:w1|Mon. 3')).toEqual(['See [[workout:w1|Mon. 3']);
	});

	it('gives offsets that slice back to each span, and drops empty ones', () => {
		const text = '  One.  \n\n Two!  ';
		const spans = splitSentences(text);
		expect(spans.map((s) => s.text)).toEqual(['One.', 'Two!']);
		for (const s of spans) expect(text.slice(s.start, s.end)).toBe(s.text);
		expect(splitSentences('   ')).toEqual([]);
		expect(splitSentences('')).toEqual([]);
	});

	it("never reports the text's own end, which the next delta may continue", () => {
		expect(sentenceBoundaries('Rest 2.')).toEqual([]);
		expect(sentenceBoundaries('Rest 2.5 min. Then')).toEqual([]);
		expect(sentenceBoundaries('Rest. Then')).toEqual([5]);
	});
});

describe('splitClauses', () => {
	it('ends a clause after , ; or : that whitespace follows, and before a spaced dash', () => {
		expect(clauses('Squat first, then bench; rest: 2 min — less is fine - ok')).toEqual([
			'Squat first,',
			'then bench;',
			'rest:',
			'2 min',
			'— less is fine',
			'- ok'
		]);
		expect(clauses('Lift 1,000 kg at 10:30, knee-high')).toEqual([
			'Lift 1,000 kg at 10:30,',
			'knee-high'
		]);
	});

	it('ends a clause before a joining word between spaces', () => {
		expect(clauses('I love squats and hate lunges but rows are fine because they help')).toEqual([
			'I love squats',
			'and hate lunges',
			'but rows are fine',
			'because they help'
		]);
		expect(clauses('Android sandbags, brandy')).toEqual(['Android sandbags,', 'brandy']);
	});

	it('includes every sentence boundary', () => {
		const text = 'One, two. Three and four.\nFive';
		const all = new Set(clauseBoundaries(text));
		for (const b of sentenceBoundaries(text)) expect(all.has(b)).toBe(true);
	});
});

describe('boundaries while streaming', () => {
	const samples = [
		'Squat 3 × 5 at 102.5 kg, e.g. a top set. Rest approx. 2 min. Then: 1. Bench\n2. Row — light, and stop if it hurts!',
		'See [[set:s1|Mon. 3 Nov.]] and [[workout:w2]]. Done? Yes… "Good." Next, rest; or walk - easy',
		'Mr. A. Smith said no. 4 sets though, because yes. a. b. c.'
	];

	it('a boundary found in a prefix stays a boundary of every longer text', () => {
		for (const text of samples) {
			const full = { s: new Set(sentenceBoundaries(text)), c: new Set(clauseBoundaries(text)) };
			for (let n = 0; n <= text.length; n += 1) {
				const prefix = text.slice(0, n);
				for (const b of sentenceBoundaries(prefix)) expect(full.s.has(b), `${n}: ${b}`).toBe(true);
				for (const b of clauseBoundaries(prefix)) expect(full.c.has(b), `${n}: ${b}`).toBe(true);
			}
		}
	});

	it('returns sorted, distinct offsets inside the text', () => {
		for (const text of samples) {
			for (const list of [sentenceBoundaries(text), clauseBoundaries(text)]) {
				expect(list).toEqual([...new Set(list)].sort((a, b) => a - b));
				expect(list.every((b) => b > 0 && b < text.length)).toBe(true);
			}
		}
	});
});
