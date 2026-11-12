import { describe, expect, it } from 'vitest';
import { ASK_QUESTIONS, askHref } from './ask-link';

const query = (href: string) => new URL(href, 'https://coach.test');

describe('askHref', () => {
	it('opens Coach with the question and where it was asked from', () => {
		const url = query(askHref(ASK_QUESTIONS.today, 'today'));
		expect(url.pathname).toBe('/coach');
		expect([...url.searchParams]).toEqual([
			['ask', 'What should I focus on next week?'],
			['from', 'today']
		]);
	});

	it('names what the question is about as `type:id`', () => {
		const url = query(askHref('Hi', 'exercise', { type: 'exercise', id: 'back_squat' }));
		expect(url.searchParams.get('ref')).toBe('exercise:back_squat');
	});

	it('keeps a question with query characters whole', () => {
		const ask = 'Squats & lunges: 5+5 or 3×8? 100% sure #legday';
		const url = query(askHref(ask, 'workout'));
		expect(url.searchParams.get('ask')).toBe(ask);
		expect(url.searchParams.get('from')).toBe('workout');
		expect(url.hash).toBe('');
	});

	it('asks about the exercise by its name', () => {
		expect(ASK_QUESTIONS.exercise('Bench press')).toBe('How has my Bench press progressed?');
	});
});
