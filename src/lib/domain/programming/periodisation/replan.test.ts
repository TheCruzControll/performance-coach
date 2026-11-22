/**
 * replan-domain: where a re-plan starts. The skeleton and the mechanisms are not in this file yet.
 */
import { describe, expect, it } from 'vitest';
import { m7Day } from './scenarios';
import { replanStart } from './replan';

describe('replanStart', () => {
	it('is the next Monday, today on a Monday, past any week with something logged or skipped', () => {
		expect(replanStart(m7Day(2, 3), [])).toBe(m7Day(3, 0));
		expect(replanStart(m7Day(2, 0), [])).toBe(m7Day(2, 0));
		expect(replanStart(m7Day(2, 0), [m7Day(2, 0)])).toBe(m7Day(3, 0));
		expect(replanStart(m7Day(2, 3), [m7Day(2, 1), m7Day(3, 4)])).toBe(m7Day(4, 0));
	});
});
