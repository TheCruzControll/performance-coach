import { describe, expect, it } from 'vitest';
import { errorCopy, errorKind, offlineLine } from './error-copy.ts';

const at = (screen?: string, deviceOnline: boolean | null = false, atOfflinePath = false) => ({
	screen,
	deviceOnline,
	atOfflinePath
});

describe('errorKind', () => {
	it('is offline for an offline error, not-found for a 404, else error', () => {
		expect(errorKind(503, { message: 'x', offline: true } as App.Error)).toBe('offline');
		expect(errorKind(404, null)).toBe('not-found');
		expect(errorKind(500, { message: 'x' } as App.Error)).toBe('error');
	});
});

describe('errorCopy', () => {
	it('names the screen that needs a connection, and offers nothing: it recovers by itself', () => {
		expect(errorCopy('offline', at('Progress'))).toEqual({
			line: null,
			title: 'Progress needs a connection',
			body: 'It opens by itself when you’re back online. Today and your workout still work.',
			action: null
		});
		expect(errorCopy('offline', at(undefined)).title).toBe('This screen needs a connection');
	});

	it('says the server is quiet when the device is online, and offers nothing', () => {
		expect(errorCopy('offline', at('Profile', true))).toEqual({
			line: null,
			title: 'Your connection looks fine. The server isn’t answering',
			body: 'This screen keeps trying and opens by itself when it can.',
			action: null
		});
	});

	it('keeps Try again on the /offline document itself, where nothing retries', () => {
		expect(errorCopy('offline', at(undefined, false, true)).action).toBe('try-again');
		expect(errorCopy('offline', at(undefined, null, true)).action).toBe('try-again');
	});

	it('a missing page offers the way home; a failure one red line and Try again', () => {
		expect(errorCopy('not-found', at('Today'))).toEqual({
			line: null,
			title: 'Nothing here',
			body: 'This page doesn’t exist. Your training is safe.',
			action: 'back-to-today'
		});
		expect(errorCopy('error', at('Train'))).toEqual({
			line: 'Something went wrong',
			title: 'That one is on us. Your training is safe',
			body: 'Nothing you logged was lost.',
			action: 'try-again'
		});
	});
});

describe('offlineLine', () => {
	it('is one quiet line, offline or with the server quiet', () => {
		expect(offlineLine(false)).toBe('Offline. Your sets are saved on this device.');
		expect(offlineLine(null)).toBe('Offline. Your sets are saved on this device.');
		expect(offlineLine(true)).toBe(
			'The server isn’t answering. Your sets are saved on this device.'
		);
	});
});
