import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';
import * as profileSchemas from './profile/schemas';
import { validate } from './validation';

const schema = z
	.object({
		name: z.string().check(z.minLength(1, 'Name it')),
		entries: z.array(z.object({ level: z.enum(['new', 'advanced'], 'Pick your level') }))
	})
	.check(z.refine((v) => v.entries.length < 3, 'Too many entries'));

describe('validate', () => {
	it('returns the parsed data when the input is valid', () => {
		const input = { name: 'Niko', entries: [{ level: 'new' }] };
		expect(validate(schema, input)).toEqual({ ok: true, data: input });
	});

	it('keys errors by dotted path, root errors under an empty key', () => {
		expect(validate(schema, { name: '', entries: [{ level: 'new' }, { level: 'pro' }] })).toEqual({
			ok: false,
			errors: { name: 'Name it', 'entries.1.level': 'Pick your level' }
		});
		const many = { name: 'Niko', entries: [1, 2, 3].map(() => ({ level: 'new' })) };
		expect(validate(schema, many)).toEqual({ ok: false, errors: { '': 'Too many entries' } });
	});

	it('keeps the first message for a path', () => {
		const twice = z.string().check(z.minLength(3, 'Too short'), z.regex(/^\d+$/, 'Digits only'));
		expect(validate(twice, 'a')).toEqual({ ok: false, errors: { '': 'Too short' } });
	});

	it('is the same function the profile schemas re-export, so M2 call sites are unchanged', () => {
		expect(profileSchemas.validate).toBe(validate);
		expect(validate(profileSchemas.SCHEMAS.basics, { name: ' ' })).toMatchObject({
			ok: false,
			errors: { name: 'Tell your coach what to call you' }
		});
	});
});
