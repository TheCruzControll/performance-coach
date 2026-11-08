import { describe, expect, it } from 'vitest';
import {
	COMPOSER_COUNT_FROM,
	composerCount,
	pointerOf,
	sendsOnKey,
	type ComposerKey
} from './composer-keys.ts';

const key = (k: string, mods: Partial<ComposerKey> = {}): ComposerKey => ({
	key: k,
	shiftKey: false,
	ctrlKey: false,
	metaKey: false,
	altKey: false,
	isComposing: false,
	...mods
});

describe('sendsOnKey', () => {
	it('on a fine pointer, Enter sends and Shift+Enter adds a newline', () => {
		expect(sendsOnKey(key('Enter'), 'fine')).toBe(true);
		expect(sendsOnKey(key('Enter', { shiftKey: true }), 'fine')).toBe(false);
	});

	it('on a phone’s keyboard, Return always adds a newline: Send sends', () => {
		expect(sendsOnKey(key('Enter'), 'coarse')).toBe(false);
		expect(sendsOnKey(key('Enter', { shiftKey: true }), 'coarse')).toBe(false);
	});

	it('Ctrl or Cmd with Enter sends on any pointer', () => {
		for (const pointer of ['fine', 'coarse'] as const) {
			expect(sendsOnKey(key('Enter', { metaKey: true }), pointer)).toBe(true);
			expect(sendsOnKey(key('Enter', { ctrlKey: true }), pointer)).toBe(true);
			expect(sendsOnKey(key('Enter', { ctrlKey: true, shiftKey: true }), pointer)).toBe(false);
		}
	});

	it('never takes an input method’s Enter, Alt+Enter or another key', () => {
		expect(sendsOnKey(key('Enter', { isComposing: true }), 'fine')).toBe(false);
		expect(sendsOnKey(key('Enter', { altKey: true }), 'fine')).toBe(false);
		expect(sendsOnKey(key('a'), 'fine')).toBe(false);
		expect(sendsOnKey(key(' '), 'fine')).toBe(false);
	});
});

describe('pointerOf', () => {
	it('reads a mouse as fine, a finger or a pen as the on-screen keyboard', () => {
		expect(pointerOf('mouse')).toBe('fine');
		expect(pointerOf('touch')).toBe('coarse');
		expect(pointerOf('pen')).toBe('coarse');
	});
});

describe('the composer’s limit', () => {
	it('shows the count only near the limit, grouped', () => {
		expect(composerCount('')).toBeNull();
		expect(composerCount('a'.repeat(COMPOSER_COUNT_FROM - 1))).toBeNull();
		expect(composerCount('a'.repeat(COMPOSER_COUNT_FROM))).toBe('3,600 / 4,000');
		expect(composerCount('a'.repeat(4000))).toBe('4,000 / 4,000');
	});
});
