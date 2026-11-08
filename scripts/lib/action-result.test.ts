import { describe, expect, it } from 'vitest';
import { readActionAnswer, unflatten } from './action-result.ts';

/** What devalue 5 (SvelteKit's) writes for a preview-shaped result, strings deduplicated. */
const ENCODED =
	'[{"today":1,"start":2,"preview":3},"2026-11-05","this_week",{"startsOn":4,"firstPlannedDay":1,"fingerprint":5,"digest":6,"week":7,"n":13,"u":-1,"x":14,"b":15},"2026-11-02","0123456789abcdef","fedcba9876543210",{"days":8},[9,11],{"date":1,"sessions":10},[],{"date":1,"sessions":12},[],null,1.5,true]';

describe('unflatten', () => {
	it('reads plain data, following shared indices', () => {
		expect(unflatten(ENCODED)).toEqual({
			today: '2026-11-05',
			start: 'this_week',
			preview: {
				startsOn: '2026-11-02',
				firstPlannedDay: '2026-11-05',
				fingerprint: '0123456789abcdef',
				digest: 'fedcba9876543210',
				week: {
					days: [
						{ date: '2026-11-05', sessions: [] },
						{ date: '2026-11-05', sessions: [] }
					]
				},
				n: null,
				u: undefined,
				x: 1.5,
				b: true
			}
		});
	});

	it('refuses a type it does not know rather than guess', () => {
		expect(() => unflatten('[{"a":1},["Date","1970-01-01T00:00:00.000Z"]]')).toThrow(/Date/);
	});
});

describe('readActionAnswer', () => {
	it("decodes a success's data and keeps a redirect as it is", () => {
		const success = JSON.stringify({ type: 'success', status: 200, data: '[{"ok":1},true]' });
		expect(readActionAnswer(success)).toEqual({ type: 'success', status: 200, data: { ok: true } });
		const redirect = JSON.stringify({ type: 'redirect', status: 303, location: '/onboarding' });
		expect(readActionAnswer(redirect)).toEqual({
			type: 'redirect',
			status: 303,
			location: '/onboarding'
		});
	});
});
