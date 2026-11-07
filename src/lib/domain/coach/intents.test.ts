import { describe, expect, it } from 'vitest';
import { DIRECT_INTENTS, MAX_LOOKUP_CHARS, directIntent, type DirectIntent } from './intents';

const POSITIVES: [string, DirectIntent][] = [
	["What's today's workout?", 'todays_workout'],
	['what is my workout today', 'todays_workout'],
	["Hey coach, what's my session for today?", 'todays_workout'],
	['What’s on today?', 'todays_workout'],
	// A deliberate choice: in the coach, a bare "What's today?" asks for the workout, not the date.
	["What's today?", 'todays_workout'],
	["What's planned for today?", 'todays_workout'],
	["What's on the plan today?", 'todays_workout'],
	["Today's workout", 'todays_workout'],
	['todays session?', 'todays_workout'],
	["Show me today's workout, please", 'todays_workout'],
	['Can you show me my workout for today?', 'todays_workout'],
	['What am I doing today?', 'todays_workout'],
	['What do I have today', 'todays_workout'],
	['Do I train today?', 'todays_workout'],
	["  WHAT'S   TODAY'S   PLAN??  ", 'todays_workout'],
	["What's my plan this week?", 'this_week'],
	["What's on this week?", 'this_week'],
	["Show me this week's sessions", 'this_week'],
	['What does my week look like?', 'this_week'],
	['What does this week look like', 'this_week'],
	['What have I got this week?', 'this_week'],
	["Ok, what's my training for this week?", 'this_week'],
	["When's my next session?", 'next_session'],
	["What's my next workout?", 'next_session'],
	['When is the next run?', 'next_session'],
	['Show me my next session', 'next_session'],
	["What's next on my plan?", 'next_session'],
	['When do I train next?', 'next_session'],
	["Coach: what's my next lift", 'next_session']
];

const NEAR_MISSES = [
	"Can we change today's workout?",
	"Should I skip today's workout?",
	"How did today's workout go?",
	"Today's workout felt hard",
	"What's today's workout and why is it so long?",
	'Make today’s session shorter',
	'What should I do today?',
	'What should I focus on next week?',
	"What's my plan next week?",
	'How was this week?',
	'Why is this week so hard?',
	'Move my next session to Friday',
	"What's my next goal?",
	"What's next?",
	"What's today's date?",
	'What did I do last week?',
	'Swap squats in my next session',
	"What's my workout today like compared to last week?",
	'workout',
	''
];

describe('directIntent', () => {
	it('answers the whole-message lookups, greetings and punctuation aside', () => {
		for (const [text, intent] of POSITIVES) expect(directIntent(text), text).toBe(intent);
		expect(new Set(POSITIVES.map(([, i]) => i))).toEqual(new Set(DIRECT_INTENTS));
	});

	it('leaves every near miss to the model', () => {
		for (const text of NEAR_MISSES) expect(directIntent(text), text).toBeNull();
	});

	it('never treats a long message as a lookup', () => {
		const long = `What's today's workout?${' '.repeat(MAX_LOOKUP_CHARS)}`;
		expect(directIntent(long.trim())).toBe('todays_workout');
		expect(directIntent(long)).toBeNull();
	});
});
