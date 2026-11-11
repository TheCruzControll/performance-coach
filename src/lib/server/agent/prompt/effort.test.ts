import { describe, expect, it } from 'vitest';
import { chatEffort, isQuickQuestion, QUICK_EFFORT, QUICK_MAX_CHARS } from './effort';
import { CHAT_EFFORT } from './layout';

const quick = { entry: null, painMode: false, opensSegment: true };

describe('chatEffort', () => {
	it('runs a short, general question that opens its segment at low effort', () => {
		expect(QUICK_EFFORT).toBe('low');
		expect(CHAT_EFFORT).toBe('medium');
		for (const text of [
			'What does RPE mean?',
			'How do I brace for a squat?',
			'Is creatine safe to take every day?',
			'what is a hip hinge'
		])
			expect(chatEffort({ ...quick, text }), text).toBe('low');
	});

	it('keeps questions about the owner’s training, or a plan to change it, at medium', () => {
		for (const text of [
			'Is my deadlift on track?',
			'Plan a deload',
			'Can you swap squats for leg press?',
			'What should I do in today’s session?',
			'How is the program going?',
			'Review the last cycle',
			'Should I move Friday’s workout to Saturday?',
			'What are my goals?'
		])
			expect(chatEffort({ ...quick, text }), text).toBe('medium');
	});

	it('keeps long or multi-part messages at medium', () => {
		const long = `What is ${'a very '.repeat(20)}good warm-up?`;
		expect(Array.from(long).length).toBeGreaterThan(QUICK_MAX_CHARS);
		expect(chatEffort({ ...quick, text: long })).toBe('medium');
		expect(chatEffort({ ...quick, text: 'What is RPE? And RIR?' })).toBe('medium');
		expect(chatEffort({ ...quick, text: 'What is RPE?\nAnd RIR?' })).toBe('medium');
		expect(chatEffort({ ...quick, text: '   ' })).toBe('medium');
		const edge = `What is${' a'.repeat((QUICK_MAX_CHARS - 8) / 2)}?`;
		expect(Array.from(edge)).toHaveLength(QUICK_MAX_CHARS);
		expect(chatEffort({ ...quick, text: edge })).toBe('low');
		expect(chatEffort({ ...quick, text: `${edge.slice(0, -1)}a?` })).toBe('medium');
	});

	it('keeps pain, an entry point and a question mid-segment at medium', () => {
		const text = 'What does RPE mean?';
		expect(chatEffort({ ...quick, text, painMode: true })).toBe('medium');
		expect(chatEffort({ ...quick, text, entry: { from: 'today', ref: null } })).toBe('medium');
		expect(chatEffort({ ...quick, text, opensSegment: false })).toBe('medium');
	});
});

describe('isQuickQuestion', () => {
	it('reads one sentence ending in punctuation as one sentence', () => {
		expect(isQuickQuestion('What is RPE?!')).toBe(true);
		expect(isQuickQuestion('What is 2.5 kg in pounds?')).toBe(true);
		expect(isQuickQuestion('Thanks. What is RPE?')).toBe(false);
	});
});
