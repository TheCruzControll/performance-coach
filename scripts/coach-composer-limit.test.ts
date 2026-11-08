import { describe, expect, it } from 'vitest';
import { OWNER_MESSAGE_MAX_CHARS } from '../src/lib/server/services/coach/threads.ts';
import { COMPOSER_MAX_CHARS } from '../src/lib/ui/coach/composer-keys.ts';

/**
 * The composer's limit and the server's are two constants on either side of the layer boundary
 * (the UI may not import the server), so this test, outside both, keeps them equal: a composer
 * that accepted more would send messages the server refuses.
 */
describe('the coach composer’s limit', () => {
	it('is the server’s, 4,000 characters', () => {
		expect(COMPOSER_MAX_CHARS).toBe(OWNER_MESSAGE_MAX_CHARS);
		expect(COMPOSER_MAX_CHARS).toBe(4_000);
	});
});
