/**
 * Ad-hoc start kits (the M4 plan's decision 13): a strength session, a run or a session the owner
 * starts without a plan, built on the device, so it starts offline too. It names no planned
 * session (all four planned fields null), so the server records a workout not linked to the plan.
 *
 * Owner decision (ADHOC_DEFAULTS): what an ad-hoc kit starts as. Strength starts with no
 * exercises, and each one is added from the cached library (Add exercise); a run is an easy run
 * with no planned segments, so every segment is a free one; 'Muay Thai or something else' starts as a
 * 60-minute Muay Thai class, and the session's own fields change its type, minutes and metrics
 * before Save. Started from /workout's "What kind" (?new=other&kind=), it starts as that type,
 * titled by it ("Pad work"), keeping the Muay Thai session type and discipline. Changing a default
 * here changes only what a new ad-hoc workout starts from.
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

/**
 * What an ad-hoc session of each type is called (the "What kind" words; the vocabulary keeps its
 * short labels for History).
 */
export const ADHOC_SESSION_TITLES: Readonly<Record<OtherSessionKind, string>> = {
	class: 'Class',
	pad_work: 'Pad work',
	sparring: 'Sparring',
	technical: 'Technical',
	conditioning: 'Conditioning',
	mobility: 'Mobility',
	strength_conditioning: 'Strength and conditioning',
	custom: 'Your own session'
};

/** ?kind='s value as a session type, or null for anything else. */
export const adhocSessionOf = (value: string | null): OtherSessionKind | null =>
	value !== null && Object.hasOwn(ADHOC_SESSION_TITLES, value) ? (value as OtherSessionKind) : null;

/**
 * A kit for an ad-hoc workout of `kind`, in the owner's units, dated the device's `today`. An
 * other session given its `session` type starts as that type, titled by it.
 */
export function adhocKit(kind: 'strength', units: KitUnits, today: IsoDate): StrengthKit;
export function adhocKit(kind: 'run', units: KitUnits, today: IsoDate): RunKit;
export function adhocKit(
	kind: 'other',
	units: KitUnits,
	today: IsoDate,
	session?: OtherSessionKind
): OtherKit;
export function adhocKit(
	kind: AdhocKind,
	units: KitUnits,
	today: IsoDate,
	session?: OtherSessionKind
): StartKit;
export function adhocKit(
	kind: AdhocKind,
	units: KitUnits,
	today: IsoDate,
	session?: OtherSessionKind
): StartKit {
	const { title, sessionType, discipline } = ADHOC_DEFAULTS[kind];
	const base = {
		v: 1,
		title: kind === 'other' && session ? ADHOC_SESSION_TITLES[session] : title,
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
	const defaults = ADHOC_DEFAULTS.other.session;
	return {
		...base,
		kind,
		other: {
			kind: session ?? defaults.kind,
			durationMinutes: defaults.durationMinutes,
			targetRpe: null,
			metrics: []
		}
	};
}
