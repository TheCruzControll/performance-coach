/**
 * Editing state for Profile → Equipment, built from what the services return. Exactly the
 * shape the equipment schema validates, so the form posts it as it stands.
 */
import type { EquipmentInput } from '#lib/domain/profile/schemas.ts';
import type { EquipmentProfile } from '#lib/domain/profile/types.ts';

export function equipmentDraft(saved: EquipmentProfile | null): EquipmentInput {
	return {
		gymType: saved?.gymType ?? null,
		equipment: [...(saved?.equipment ?? [])],
		homeEquipment: [...(saved?.homeEquipment ?? [])],
		notes: saved?.notes ?? null
	};
}
