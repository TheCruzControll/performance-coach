import { describe, expect, it } from 'vitest';
import { validate } from '../validation';
import { replanDirectiveSchema, replanPayloadSchema } from './replan';
import type { ReplanDirective } from './replan';

const MONDAY = '2026-11-16';
const GOAL = '00000000-0000-4000-8007-000000000101';
const HASH = '0123456789abcdef';

const DIRECTIVES: ReplanDirective[] = [
	{ kind: 'priorities', cause: 'reorder' },
	{ kind: 'priorities', cause: 'goal_update' },
	{ kind: 'block', phase: 'maintenance', weeks: 3 },
	{ kind: 'block', phase: 'hypertrophy', weeks: 8, focusGoalRef: GOAL },
	{ kind: 'taper', goalRef: GOAL, form: 'full' },
	{ kind: 'taper', goalRef: GOAL, form: 'mini' },
	{ kind: 'deload', week: MONDAY, trigger: 'reactive', reasons: ['Fatigue is high'] },
	{ kind: 'deload', week: MONDAY, trigger: 'owner', reasons: [] }
];

const payload = (directive: unknown, over: Record<string, unknown> = {}) => ({
	directive,
	from: MONDAY,
	baseVersionNumber: 1,
	fingerprint: HASH,
	shapeDigest: HASH,
	...over
});

describe('replanDirectiveSchema', () => {
	it.each(DIRECTIVES.map((d) => [d.kind, d] as const))('parses a %s directive', (_, directive) => {
		expect(validate(replanDirectiveSchema, directive)).toEqual({ ok: true, data: directive });
		expect(validate(replanPayloadSchema, payload(directive)).ok).toBe(true);
	});

	it.each([
		[
			'a deload week that is not a Monday',
			{ kind: 'deload', week: '2026-11-17', trigger: 'owner', reasons: [] },
			'week'
		],
		['a block of 2 weeks', { kind: 'block', phase: 'hypertrophy', weeks: 2 }, 'weeks'],
		['a block of 9 weeks', { kind: 'block', phase: 'hypertrophy', weeks: 9 }, 'weeks'],
		['an unknown phase', { kind: 'block', phase: 'bulking', weeks: 4 }, 'phase'],
		['the bridge phase', { kind: 'block', phase: 'transition', weeks: 4 }, 'phase'],
		[
			'a reason over 160 characters',
			{ kind: 'deload', week: MONDAY, trigger: 'coach', reasons: ['x'.repeat(161)] },
			'reasons.0'
		],
		[
			'six reasons',
			{ kind: 'deload', week: MONDAY, trigger: 'coach', reasons: ['a', 'b', 'c', 'd', 'e', 'f'] },
			'reasons'
		],
		['an unknown cause', { kind: 'priorities', cause: 'whim' }, 'cause'],
		['a taper of no form', { kind: 'taper', goalRef: GOAL, form: 'half' }, 'form']
	])('refuses %s', (_, directive, path) => {
		const result = validate(replanDirectiveSchema, directive);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(Object.keys(result.errors)).toContain(path);
	});

	it('refuses a payload from a day that is not a Monday, base version 0 or a malformed hash', () => {
		const directive = DIRECTIVES[0];
		const refused = (over: Record<string, unknown>) => {
			const result = validate(replanPayloadSchema, payload(directive, over));
			return result.ok ? [] : Object.keys(result.errors);
		};
		expect(refused({ from: '2026-11-18' })).toEqual(['from']);
		expect(refused({ baseVersionNumber: 0 })).toEqual(['baseVersionNumber']);
		expect(refused({ fingerprint: 'ABCDEF0123456789' })).toEqual(['fingerprint']);
		expect(refused({ shapeDigest: '0123' })).toEqual(['shapeDigest']);
		expect(refused({})).toEqual([]);
	});
});
