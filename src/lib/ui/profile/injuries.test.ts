import { describe, expect, it } from 'vitest';
import { SCHEMAS, validate } from '#lib/domain/profile/schemas.ts';
import type { Injury } from '#lib/domain/profile/types.ts';
import {
	errorsByRow,
	injuriesDraft,
	injuriesPayload,
	injuryTitle,
	newInjury,
	type InjuryDraft
} from './injuries';

const knee: Injury = {
	id: '0b7f6c1e-8d3a-4c55-9a51-3f0e2d6b7a10',
	bodyArea: 'knee',
	side: 'left',
	severity: 'moderate',
	notes: 'Sore after long runs',
	avoid: ['Jumping lunges', 'Box jumps'],
	active: true,
	since: '2026-09-01',
	updatedAt: new Date('2026-11-01T08:00:00Z')
};

const shoulder: Injury = {
	...knee,
	id: '6a2d9e4f-1b7c-4e08-8f3a-c5d1e2f3a4b5',
	bodyArea: 'shoulder',
	side: null,
	severity: 'mild',
	notes: null,
	avoid: [],
	active: false,
	since: null
};

describe('injuryTitle', () => {
	it('puts a left or right side before the area', () => {
		expect(injuryTitle({ bodyArea: 'knee', side: 'left' })).toBe('Left knee');
		expect(injuryTitle({ bodyArea: 'lower_back', side: 'right' })).toBe('Right lower back');
	});

	it('says “both sides” after the area', () => {
		expect(injuryTitle({ bodyArea: 'ankle_foot', side: 'both' })).toBe('Ankle / foot, both sides');
	});

	it('is the area alone when no side applies', () => {
		expect(injuryTitle({ bodyArea: 'neck', side: null })).toBe('Neck');
	});

	it('names an “other” area’s side after it, never “Left other”', () => {
		expect(injuryTitle({ bodyArea: 'other', side: 'left' })).toBe('Other, left side');
		expect(injuryTitle({ bodyArea: 'other', side: null })).toBe('Other');
	});

	it('names a new injury whose area is not picked yet', () => {
		expect(injuryTitle({ bodyArea: null, side: 'right' })).toBe('New injury or limitation');
	});
});

describe('injuriesDraft', () => {
	it('starts with no injuries when nothing is saved', () => {
		expect(injuriesDraft([])).toEqual({ injuries: [] });
	});

	it('edits each saved injury, keyed and identified by its stored id, resolved ones too', () => {
		expect(injuriesDraft([knee, shoulder])).toEqual({
			injuries: [
				{
					key: knee.id,
					id: knee.id,
					bodyArea: 'knee',
					side: 'left',
					severity: 'moderate',
					notes: 'Sore after long runs',
					avoid: ['Jumping lunges', 'Box jumps'],
					active: true,
					since: '2026-09-01'
				},
				{
					key: shoulder.id,
					id: shoulder.id,
					bodyArea: 'shoulder',
					side: null,
					severity: 'mild',
					notes: null,
					avoid: [],
					active: false,
					since: null
				}
			]
		});
	});

	it('copies the movements to avoid, so editing them never changes the loaded data', () => {
		const draft = injuriesDraft([knee]);
		draft.injuries[0]!.avoid.push('Pistol squats');
		expect(knee.avoid).toEqual(['Jumping lunges', 'Box jumps']);
	});
});

describe('newInjury', () => {
	it('is blank and still active: no area, side or severity picked for the owner', () => {
		const added = newInjury([]);
		expect(added).toEqual({
			key: added.key,
			id: null,
			bodyArea: null,
			side: null,
			severity: null,
			notes: null,
			avoid: [],
			active: true,
			since: null
		});
	});

	it('gets a key no other row has, so each card keeps its own state', () => {
		const rows: InjuryDraft[] = injuriesDraft([knee]).injuries;
		rows.push(newInjury(rows));
		rows.push(newInjury(rows));
		expect(new Set(rows.map((r) => r.key)).size).toBe(3);
	});

	it('reuses a freed key, so adding a card and taking it out again changes nothing', () => {
		const rows = injuriesDraft([knee]).injuries;
		const first = newInjury(rows);
		expect(newInjury(rows).key).toBe(first.key);
	});
});

describe('injuriesPayload', () => {
	it('posts every injury in place without its key, and a new one without an id', () => {
		const draft = injuriesDraft([knee]);
		draft.injuries.push({ ...newInjury(draft.injuries), bodyArea: 'wrist_hand' });
		const payload = injuriesPayload(draft);
		expect(payload.injuries.map((i) => Object.keys(i).sort())).toEqual([
			['active', 'avoid', 'bodyArea', 'id', 'notes', 'severity', 'side', 'since'],
			['active', 'avoid', 'bodyArea', 'id', 'notes', 'severity', 'side', 'since']
		]);
		expect(payload.injuries.map((i) => [i.id, i.bodyArea])).toEqual([
			[knee.id, 'knee'],
			[null, 'wrist_hand']
		]);
	});

	it('is what the injuries schema takes, once every required choice is made', () => {
		const draft = injuriesDraft([knee, shoulder]);
		expect(validate(SCHEMAS.injuries, injuriesPayload(draft))).toMatchObject({ ok: true });
		// A new card asks for its area and severity, by its place in the list.
		draft.injuries.push(newInjury(draft.injuries));
		expect(validate(SCHEMAS.injuries, injuriesPayload(draft))).toEqual({
			ok: false,
			errors: { 'injuries.2.bodyArea': 'Where is it?', 'injuries.2.severity': 'How bad is it?' }
		});
	});

	it('holds the schema’s limits: 60 characters a movement and 12 movements an injury', () => {
		const draft = injuriesDraft([knee]);
		draft.injuries[0]!.avoid = ['x'.repeat(61)];
		expect(validate(SCHEMAS.injuries, injuriesPayload(draft))).toMatchObject({
			ok: false,
			errors: { 'injuries.0.avoid.0': 'Keep it under 60 characters' }
		});
		draft.injuries[0]!.avoid = Array.from({ length: 13 }, (_, i) => `Movement ${i + 1}`);
		expect(validate(SCHEMAS.injuries, injuriesPayload(draft))).toMatchObject({
			ok: false,
			errors: { 'injuries.0.avoid': 'Up to 12 movements per injury' }
		});
	});
});

describe('errorsByRow', () => {
	const rows = () => {
		const injuries = injuriesDraft([knee]).injuries;
		injuries.push(newInjury(injuries));
		return injuries;
	};

	it('files each field error under the key of the row it names', () => {
		const [saved, added] = rows();
		expect(
			errorsByRow(
				{ 'injuries.1.bodyArea': 'Where is it?', 'injuries.0.severity': 'How bad is it?' },
				[saved!, added!]
			)
		).toEqual({
			[saved!.key]: { severity: 'How bad is it?' },
			[added!.key]: { bodyArea: 'Where is it?' }
		});
	});

	it('files a movement’s own error under the movements to avoid', () => {
		const [saved] = rows();
		expect(errorsByRow({ 'injuries.0.avoid.3': 'Keep it under 60 characters' }, [saved!])).toEqual({
			[saved!.key]: { avoid: 'Keep it under 60 characters' }
		});
	});

	it('leaves out errors about the list as a whole and rows that are not there', () => {
		expect(
			errorsByRow({ injuries: 'Too many injuries', 'injuries.7.bodyArea': 'Where is it?' }, rows())
		).toEqual({});
	});
});
