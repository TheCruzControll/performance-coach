import { describe, expect, it } from 'vitest';
import { SCHEMAS, validate } from '#lib/domain/profile/schemas.ts';
import type { BodyWeightEntry } from '#lib/domain/profile/types.ts';
import { bodyDraft, bodyPayload, type BodySaved } from './body';

const entry = (value: number, unit: 'kg' | 'lb', measuredOn: string, id = 1): BodyWeightEntry => ({
	id,
	value,
	unit,
	measuredOn,
	source: 'profile'
});

const profile: BodySaved['profile'] = {
	weightUnit: 'kg',
	birthYear: 1994,
	nutritionPhase: 'cut',
	targetWeight: 78,
	targetWeightUnit: 'kg',
	targetDate: '2027-03-14'
};

/** Most recent first, as the services list it. */
const history = [entry(82.4, 'kg', '2026-11-05', 2), entry(83.1, 'kg', '2026-10-29', 1)];

describe('bodyDraft', () => {
	it('starts from the latest weight when it is in the owner’s unit, and from the profile', () => {
		expect(bodyDraft({ profile, bodyWeight: history })).toEqual({
			birthYear: 1994,
			weightUnit: 'kg',
			bodyWeight: 82.4,
			recorded: null,
			nutritionPhase: 'cut',
			targetWeight: 78,
			targetDate: '2027-03-14'
		});
	});

	it('shows a weight recorded in the other unit converted, to one decimal, and remembers it', () => {
		const lb = { ...profile, weightUnit: 'lb' as const };
		// 82.4 kg is 181.6563… lb.
		expect(bodyDraft({ profile: lb, bodyWeight: history })).toMatchObject({
			weightUnit: 'lb',
			bodyWeight: 181.7,
			recorded: { value: 82.4, unit: 'kg', shown: 181.7 }
		});
		// 180 lb is 81.6466… kg.
		expect(bodyDraft({ profile, bodyWeight: [entry(180, 'lb', '2026-11-05')] })).toMatchObject({
			bodyWeight: 81.6,
			recorded: { value: 180, unit: 'lb', shown: 81.6 }
		});
	});

	it('shows a target set in the other unit in the owner’s, to one decimal, as Save stores it', () => {
		const target = (p: Partial<BodySaved['profile']>) =>
			bodyDraft({ profile: { ...profile, ...p }, bodyWeight: [] }).targetWeight;
		// 78 kg is 171.9605… lb, and 180 lb is 81.6466… kg. In the owner's unit it stays as set.
		expect(target({ weightUnit: 'lb' })).toBe(172);
		expect(target({ targetWeight: 180, targetWeightUnit: 'lb' })).toBe(81.6);
		expect(target({ targetWeight: 78.25 })).toBe(78.25);
	});

	it('leaves the weight blank with no history, and drafts no phase as “Not focusing on it”', () => {
		const blank = {
			weightUnit: 'kg' as const,
			birthYear: null,
			nutritionPhase: null,
			targetWeight: null,
			targetWeightUnit: null,
			targetDate: null
		};
		expect(bodyDraft({ profile: blank, bodyWeight: [] })).toEqual({
			birthYear: null,
			weightUnit: 'kg',
			bodyWeight: null,
			recorded: null,
			nutritionPhase: 'none',
			targetWeight: null,
			targetDate: null
		});
	});
});

describe('bodyPayload', () => {
	it('posts “Not focusing on it” as no phase, and a phase as itself', () => {
		const draft = bodyDraft({ profile: { ...profile, nutritionPhase: null }, bodyWeight: [] });
		expect(draft.nutritionPhase).toBe('none');
		expect(bodyPayload(draft).nutritionPhase).toBeNull();
		expect(bodyPayload({ ...draft, nutritionPhase: 'recomp' }).nutritionPhase).toBe('recomp');
	});

	it('posts no weight while a converted one is untouched, so rounding never records a weigh-in', () => {
		const draft = bodyDraft({ profile: { ...profile, weightUnit: 'lb' }, bodyWeight: history });
		expect(bodyPayload(draft).bodyWeight).toBeNull();
		// Typed over, it is the owner's own number.
		expect(bodyPayload({ ...draft, bodyWeight: 180.5 }).bodyWeight).toBe(180.5);
		expect(bodyPayload({ ...draft, bodyWeight: null }).bodyWeight).toBeNull();
	});

	it('posts a weight in the owner’s unit as it stands (the services skip an unchanged one)', () => {
		expect(bodyPayload(bodyDraft({ profile, bodyWeight: history })).bodyWeight).toBe(82.4);
	});

	it('is exactly what the shared schema takes, with nothing of the editor’s own', () => {
		const draft = bodyDraft({ profile: { ...profile, weightUnit: 'lb' }, bodyWeight: history });
		const payload = bodyPayload(draft);
		expect(payload).not.toHaveProperty('recorded');
		expect(validate(SCHEMAS.body, payload)).toEqual({
			ok: true,
			data: {
				birthYear: 1994,
				weightUnit: 'lb',
				bodyWeight: null,
				nutritionPhase: 'cut',
				targetWeight: 172,
				targetDate: '2027-03-14'
			}
		});
		const blank = bodyDraft({
			profile: {
				...profile,
				birthYear: null,
				nutritionPhase: null,
				targetWeight: null,
				targetWeightUnit: null,
				targetDate: null
			},
			bodyWeight: []
		});
		expect(validate(SCHEMAS.body, bodyPayload(blank)).ok).toBe(true);
	});
});
