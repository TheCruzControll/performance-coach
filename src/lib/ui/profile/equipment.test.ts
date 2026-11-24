import { describe, expect, it } from 'vitest';
import { SCHEMAS, validate } from '#lib/domain/profile/schemas.ts';
import type { EquipmentProfile } from '#lib/domain/profile/types.ts';
import { equipmentDraft, kitValue } from './equipment';

describe('kitValue', () => {
	it('says how many things are ticked, and “Nothing” for none (no home kit)', () => {
		expect(kitValue([])).toBe('Nothing');
		expect(kitValue(['dumbbells'])).toBe('1 thing');
		expect(
			kitValue([
				'barbell',
				'squat_rack',
				'bench',
				'platform',
				'dumbbells',
				'kettlebells',
				'cables',
				'machines',
				'pull_up_bar'
			])
		).toBe('9 things');
	});
});

const saved: EquipmentProfile = {
	gymType: 'commercial',
	equipment: ['barbell', 'squat_rack'],
	homeEquipment: ['dumbbells'],
	notes: 'Rack is free before 7am',
	updatedAt: new Date('2026-11-01T08:00:00Z')
};

describe('equipmentDraft', () => {
	it('starts blank when nothing is saved yet: no gym picked, nothing ticked', () => {
		expect(equipmentDraft(null)).toEqual({
			gymType: null,
			equipment: [],
			homeEquipment: [],
			notes: null
		});
	});

	it('edits what was saved, without the timestamp the schema does not take', () => {
		expect(equipmentDraft(saved)).toEqual({
			gymType: 'commercial',
			equipment: ['barbell', 'squat_rack'],
			homeEquipment: ['dumbbells'],
			notes: 'Rack is free before 7am'
		});
	});

	it('saves straight back: a draft of either kind passes the shared schema', () => {
		expect(validate(SCHEMAS.equipment, equipmentDraft(null)).ok).toBe(true);
		expect(validate(SCHEMAS.equipment, equipmentDraft(saved))).toEqual({
			ok: true,
			data: equipmentDraft(saved)
		});
	});

	it('copies the lists, so ticking a box never edits the loaded data', () => {
		const draft = equipmentDraft(saved);
		draft.equipment.push('bench');
		draft.homeEquipment.length = 0;
		expect(saved.equipment).toEqual(['barbell', 'squat_rack']);
		expect(saved.homeEquipment).toEqual(['dumbbells']);
	});
});
