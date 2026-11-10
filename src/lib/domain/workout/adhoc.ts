/**
 * Ad-hoc start kits (the M4 plan's decision 13): a strength session, a run or a session the owner
 * starts without a plan, built on the device, so it starts offline too. It names no planned
 * session (all four planned fields null), so the server records a workout not linked to the plan.
 *
 * Owner decision (ADHOC_DEFAULTS): what an ad-hoc kit starts as. Strength starts with no
 * exercises, and each one is added from the cached library (Add exercise); a run is an easy run
 * with no planned segments, so every segment is a free one; 'Muay Thai and other' starts as a
 * 60-minute Muay Thai class, and the session's own fields change its type, minutes and metrics
 * before Save. Changing a default here changes only what a new ad-hoc workout starts from.
 */
import type { IsoDate } from '../calendar.ts';
import type { Discipline } from '../profile/catalog.ts';
import type { OtherSessionKind, SessionType } from '../training/vocabulary.ts';
import type { KitUnits, OtherKit, RunKit, StartKit, StrengthKit } from './types.ts';

/** The kinds a device builds an ad-hoc kit for: /workout?new=strength, ?new=run and ?new=other. */
export const ADHOC_KINDS = ['strength', 'run', 'other'] as const;
export type AdhocKind = (typeof ADHOC_KINDS)[number];

interface AdhocDefaults {
	title: string;
	sessionType: SessionType;
	discipline: Discipline;
	/** An other session's type and minutes. */
	session?: { kind: OtherSessionKind; durationMinutes: number };
}

export const ADHOC_DEFAULTS = {
	strength: { title: 'Strength', sessionType: 'strength', discipline: 'strength' },
	run: { title: 'Run', sessionType: 'easy_run', discipline: 'running' },
	other: {
		title: 'Muay Thai',
		sessionType: 'muay_thai',
		discipline: 'muay_thai',
		session: { kind: 'class', durationMinutes: 60 }
	}
} as const satisfies Record<AdhocKind, AdhocDefaults>;

/** ?new='s value as an ad-hoc kind, or null for anything else. */
export const adhocKindOf = (value: string | null): AdhocKind | null =>
	ADHOC_KINDS.find((kind) => kind === value) ?? null;

/** A kit for an ad-hoc workout of `kind`, in the owner's units, dated the device's `today`. */
export function adhocKit(kind: 'strength', units: KitUnits, today: IsoDate): StrengthKit;
export function adhocKit(kind: 'run', units: KitUnits, today: IsoDate): RunKit;
export function adhocKit(kind: 'other', units: KitUnits, today: IsoDate): OtherKit;
export function adhocKit(kind: AdhocKind, units: KitUnits, today: IsoDate): StartKit;
export function adhocKit(kind: AdhocKind, units: KitUnits, today: IsoDate): StartKit {
	const { title, sessionType, discipline } = ADHOC_DEFAULTS[kind];
	const base = {
		v: 1,
		title,
		sessionType,
		discipline,
		date: today,
		plannedLineage: null,
		plannedSessionId: null,
		programId: null,
		versionNumber: null,
		units: { ...units }
	} as const;
	if (kind === 'strength') return { ...base, kind, exercises: [] };
	if (kind === 'run') return { ...base, kind, run: { segments: [] } };
	const { session } = ADHOC_DEFAULTS.other;
	return {
		...base,
		kind,
		other: {
			kind: session.kind,
			durationMinutes: session.durationMinutes,
			targetRpe: null,
			metrics: []
		}
	};
}
