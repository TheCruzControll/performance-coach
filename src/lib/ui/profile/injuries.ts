/**
 * Editing state for Profile → Injuries: one card per injury or limitation, built from what the
 * services return. Resolved ones stay listed (the coach keeps them as history); only the
 * active ones are programmed around. Also the name a card goes by ("Left knee").
 */
import {
	BODY_AREA_LABEL,
	type BodyArea,
	type Severity,
	type Side
} from '#lib/domain/profile/catalog.ts';
import type { FieldErrors } from '#lib/domain/profile/schemas.ts';
import type { Injury } from '#lib/domain/profile/types.ts';

/** One injury being edited: every field the injuries schema reads, and the row's key. */
export interface InjuryDraft {
	/** Keeps the card (and anything half-typed in it) with its injury; never posted. */
	key: string;
	/** The stored injury this edits, so its history survives a save; none for a new one. */
	id: string | null;
	/** None until the owner picks one: the schema then asks for it on this card. */
	bodyArea: BodyArea | null;
	/** None means no side applies (a neck, a lower back). */
	side: Side | null;
	severity: Severity | null;
	notes: string | null;
	avoid: string[];
	/** Off once resolved. */
	active: boolean;
	/** Not edited on this screen, but kept, so a save never drops it. */
	since: string | null;
}

export interface InjuriesDraft {
	injuries: InjuryDraft[];
}

/** The saved injuries, in the services' order (active first), ready to edit. */
export function injuriesDraft(saved: Injury[]): InjuriesDraft {
	return {
		injuries: saved.map((i) => ({
			key: i.id,
			id: i.id,
			bodyArea: i.bodyArea,
			side: i.side,
			severity: i.severity,
			notes: i.notes,
			avoid: [...i.avoid],
			active: i.active,
			since: i.since
		}))
	};
}

/**
 * A blank card, keyed unlike every row in `rows`. The key is the first free one, so a card
 * added and taken out again leaves the same state: nothing to save.
 */
export function newInjury(rows: readonly InjuryDraft[]): InjuryDraft {
	let n = 1;
	while (rows.some((r) => r.key === `new:${n}`)) n++;
	return {
		key: `new:${n}`,
		id: null,
		bodyArea: null,
		side: null,
		severity: null,
		notes: null,
		avoid: [],
		active: true,
		since: null
	};
}

/**
 * What Save posts: the injuries as they stand, without their keys. Rows keep their places, so
 * an error the schema reports (`injuries.2.bodyArea`) lands on the card it is about.
 */
export function injuriesPayload({ injuries }: InjuriesDraft) {
	return { injuries: injuries.map(({ key: _key, ...injury }) => injury) };
}

/** "Left knee", "Ankle / foot, both sides", "Neck"; a card with no area yet says it is new. */
export function injuryTitle({ bodyArea, side }: Pick<InjuryDraft, 'bodyArea' | 'side'>): string {
	if (!bodyArea) return 'New injury or limitation';
	const area = BODY_AREA_LABEL[bodyArea];
	if (!side) return area;
	if (side === 'both') return `${area}, both sides`;
	if (bodyArea === 'other') return `${area}, ${side} side`;
	return `${side === 'left' ? 'Left' : 'Right'} ${area.toLowerCase()}`;
}

/**
 * Field errors by row key. A save's errors name rows by their place (`injuries.2.severity`,
 * `injuries.0.avoid.3`), which means the rows as they were when the errors came back; once
 * pinned to keys, the errors stay with their cards when one above them is removed. Errors
 * about the list as a whole are not here.
 */
export function errorsByRow(
	errors: FieldErrors,
	rows: readonly InjuryDraft[]
): Record<string, FieldErrors> {
	const byRow: Record<string, FieldErrors> = {};
	for (const [path, message] of Object.entries(errors)) {
		const [, index, field] = /^injuries\.(\d+)\.(\w+)(?:\.\d+)?$/.exec(path) ?? [];
		const key = index === undefined ? undefined : rows[Number(index)]?.key;
		if (key && field) (byRow[key] ??= {})[field] ??= message;
	}
	return byRow;
}
