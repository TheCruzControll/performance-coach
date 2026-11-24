/**
 * Editing state for Profile → Equipment, built from what the services return. Exactly the
 * shape the equipment schema validates, so the form posts it as it stands. Also a kit list's
 * answer in words, for its row.
 */
import type { EquipmentInput } from '#lib/domain/profile/schemas.ts';
import type { EquipmentProfile } from '#lib/domain/profile/types.ts';

/** A kit list's answer on its row: "Nothing", "1 thing", "9 things". */
export function kitValue(list: readonly unknown[]): string {
	if (list.length === 0) return 'Nothing';
	return list.length === 1 ? '1 thing' : `${list.length} things`;
}

export function equipmentDraft(saved: EquipmentProfile | null): EquipmentInput {
	return {
		gymType: saved?.gymType ?? null,
		equipment: [...(saved?.equipment ?? [])],
		homeEquipment: [...(saved?.homeEquipment ?? [])],
		notes: saved?.notes ?? null
	};
}
