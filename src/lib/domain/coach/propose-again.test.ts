import { describe, expect, it } from 'vitest';
import {
	COULDNT_PREPARE,
	NOT_REPROPOSABLE_NOTE,
	NOT_STALE_NOTE,
	outcomeOf,
	PROPOSE_AGAIN,
	proposeNote,
	UNCHANGED_NOTE
} from './propose-again.ts';

describe('the note a Propose again answer leaves', () => {
	it('shows the engine’s own sentence for a refusal, and no proposal is implied', () => {
		const why = 'Nothing in that week is still ahead of you, so there is nothing left to change.';
		expect(proposeNote({ status: 'refused', why })).toBe(why);
	});

	it('says there is nothing new for an unchanged plan or a stale one that is up to date', () => {
		expect(proposeNote({ status: 'unchanged' })).toBe(UNCHANGED_NOTE);
		expect(proposeNote({ status: 'not_stale' })).toBe(NOT_STALE_NOTE);
	});

	it('says on a neutral line, with a curly apostrophe, that a source cannot be proposed again', () => {
		expect(NOT_REPROPOSABLE_NOTE).toBe('This can’t be proposed again from here');
		expect(proposeNote({ status: 'not_reproposable' })).toBe(NOT_REPROPOSABLE_NOTE);
	});

	it('leaves no note for a fresh proposal, a failure, or before any answer', () => {
		expect(proposeNote({ status: 'proposed', id: 'p-1' })).toBeNull();
		expect(proposeNote({ status: 'failed' })).toBeNull();
		expect(proposeNote(null)).toBeNull();
	});
});

describe('the words of the Propose again control', () => {
	it('words the failure with a curly apostrophe, and the button as Propose again', () => {
		expect(COULDNT_PREPARE).toBe('Couldn’t prepare it');
		expect(PROPOSE_AGAIN).toBe('Propose again');
	});
});

describe('outcomeOf', () => {
	it('reads each outcome the action sends', () => {
		expect(outcomeOf({ status: 'proposed', id: 'p-1' })).toEqual({ status: 'proposed', id: 'p-1' });
		expect(outcomeOf({ status: 'refused', why: 'Not this week.' })).toEqual({
			status: 'refused',
			why: 'Not this week.'
		});
		expect(outcomeOf({ status: 'unchanged' })).toEqual({ status: 'unchanged' });
		expect(outcomeOf({ status: 'not_stale' })).toEqual({ status: 'not_stale' });
		expect(outcomeOf({ status: 'not_reproposable' })).toEqual({ status: 'not_reproposable' });
		expect(outcomeOf({ status: 'failed' })).toEqual({ status: 'failed' });
	});

	it('reads anything it does not know, or an outcome missing its field, as a failure', () => {
		for (const value of [
			undefined,
			null,
			'proposed',
			{},
			{ status: 'nope' },
			{ status: 'proposed' },
			{ status: 'proposed', id: 7 },
			{ status: 'refused' }
		]) {
			expect(outcomeOf(value)).toEqual({ status: 'failed' });
		}
	});
});
