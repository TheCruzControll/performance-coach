/**
 * Editing state for Profile → Experience: one row per discipline, built from what the services
 * return and the disciplines in play (the edit route's context).
 *
 * A discipline of an open goal always gets a row: one the owner removed comes back, blank, the
 * next time the section opens while that goal is open. That is intended: the coach plans each
 * goal from the owner's level in it, so the screen keeps asking until it has one.
 */
import { DISCIPLINES, type Discipline, type ExperienceLevel } from '#lib/domain/profile/catalog.ts';
import type { FieldErrors } from '#lib/domain/profile/schemas.ts';
import type { ExperienceEntry } from '#lib/domain/profile/types.ts';

export interface ExperienceDraft {
	/** Keeps each row's card (and anything half-typed in it) with its row; never posted. */
	key: string;
	discipline: Discipline;
	customLabel: string | null;
	/** None until the owner picks one: the schema then asks for it on this row. */
	level: ExperienceLevel | null;
	years: number | null;
	sessionsPerWeek: number | null;
	/** Not edited on this screen, but kept, so a save never drops it. */
	notes: string | null;
}

export interface ExperienceState {
	entries: ExperienceDraft[];
}

/**
 * Saved entries first (the services' order), then a blank row for each discipline in play that
 * has none, in catalog order. A custom discipline needs a name first, so it gets none.
 */
export function experienceDraft(
	saved: ExperienceEntry[],
	context: { disciplines: readonly Discipline[] }
): ExperienceState {
	const entries: ExperienceDraft[] = saved.map((e) => ({
		key: e.id,
		discipline: e.discipline,
		customLabel: e.customLabel,
		level: e.level,
		years: e.years,
		sessionsPerWeek: e.sessionsPerWeek,
		notes: e.notes
	}));
	for (const discipline of DISCIPLINES) {
		if (
			discipline !== 'custom' &&
			context.disciplines.includes(discipline) &&
			!entries.some((e) => e.discipline === discipline)
		) {
			entries.push(blankExperience(discipline, entries));
		}
	}
	return { entries };
}

/**
 * A blank row for `discipline`, keyed unlike every row in `entries`. The key is the first free
 * one, so a blank row taken out and added again is the same row: no change to save.
 */
export function blankExperience(
	discipline: Discipline,
	entries: readonly ExperienceDraft[]
): ExperienceDraft {
	let n = 1;
	while (entries.some((e) => e.key === `new:${discipline}:${n}`)) n++;
	return {
		key: `new:${discipline}:${n}`,
		discipline,
		customLabel: null,
		level: null,
		years: null,
		sessionsPerWeek: null,
		notes: null
	};
}

/** Every catalog discipline without a row yet, in catalog order; another custom one always. */
export function addableDisciplines(entries: readonly ExperienceDraft[]): Discipline[] {
	return DISCIPLINES.filter((d) => d === 'custom' || !entries.some((e) => e.discipline === d));
}

/**
 * What Save posts: the rows as they stand, without their keys. Rows keep their places, so an
 * error the schema reports (`entries.2.level`) lands on the card it is about.
 */
export function experiencePayload({ entries }: ExperienceState) {
	return {
		entries: entries.map((e) => ({
			discipline: e.discipline,
			customLabel: e.customLabel,
			level: e.level,
			years: e.years,
			sessionsPerWeek: e.sessionsPerWeek,
			notes: e.notes
		}))
	};
}

/**
 * Field errors by row key. A save's errors name rows by their place (`entries.2.level`), which
 * means `entries` as they were when the errors came back; once pinned to keys, the errors stay
 * with their rows when one above them is removed. Errors about the list as a whole are not here.
 */
export function errorsByRow(
	errors: FieldErrors,
	entries: readonly ExperienceDraft[]
): Record<string, FieldErrors> {
	const byRow: Record<string, FieldErrors> = {};
	for (const [path, message] of Object.entries(errors)) {
		const [, index, field] = /^entries\.(\d+)\.(\w+)$/.exec(path) ?? [];
		const key = index === undefined ? undefined : entries[Number(index)]?.key;
		if (key && field) (byRow[key] ??= {})[field] = message;
	}
	return byRow;
}
