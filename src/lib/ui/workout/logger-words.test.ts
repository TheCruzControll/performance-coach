import { describe, expect, it } from 'vitest';
import { setFields } from '#lib/domain/workout/logging.ts';
import type { LoadSource } from '#lib/domain/workout/prefill.ts';
import { loadHint } from './logger-words';

const hint = (
	loadType: Parameters<typeof setFields>[1],
	loadFrom: LoadSource | null,
	instruction: string | null = null
) => loadHint({ fields: setFields('reps', loadType), loadFrom, instruction });

describe('loadHint', () => {
	it('says where a prefilled load came from, whatever the load type', () => {
		expect(hint('external', 'last_session')).toBe('From last time');
		expect(hint('external', 'top_set_today')).toBe("From today's top set");
		expect(hint('bodyweight', 'previous_set')).toBe('Same as your last set');
		expect(hint('assisted', 'last_top_set')).toBe('From its last top set');
	});

	it("asks for a weighted set's load with its instruction when nothing is prefilled", () => {
		expect(hint('external', null, 'Pick a load that feels like RPE 7')).toBe(
			'Pick a load that feels like RPE 7'
		);
		expect(hint('external', null)).toBe('Enter the weight you use');
	});

	it('says what 0 means for an optional load, and nothing for an unloaded exercise', () => {
		expect(hint('bodyweight', null)).toBe('Leave at 0 for bodyweight only');
		expect(hint('assisted', null)).toBe('Leave at 0 for none · less is harder');
		expect(hint('none', 'previous_set')).toBeNull();
	});
});
