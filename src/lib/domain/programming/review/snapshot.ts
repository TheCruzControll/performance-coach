/**
 * What a stored weekly review is (M6): the versioned snapshot in weekly_reviews.snapshot, its
 * schema, and the one way to read a row back.
 *
 * - The snapshot keeps the figures as they were when the review was computed, so the review reads
 *   the same after the log is edited; inputsDigest (digest.ts) says when it is out of date.
 * - A row's snapshot_version names its shape. Version 0 is a row written before M6 (M3's table,
 *   whose snapshot has no contract) and any version this code does not know is from another
 *   release: both read as legacy, with the row's summary, never as an error.
 * - A row at SNAPSHOT_VERSION that breaks the schema is a bug or a corrupted row: readSnapshot
 *   throws a SnapshotError naming the path, rather than show figures it cannot trust.
 *
 * Any change to the shape below or to the brief's (brief.ts) bumps SNAPSHOT_VERSION, and the rows
 * stored before it then read as legacy, except an additive optional field that every stored row
 * already satisfies by leaving it out: M7's `deload` (m7-plan reactive-deload) is one, so v1 rows
 * read as before. Pure and server-only at runtime, like domain/programming.
 */
import * as z from 'zod/mini';
import { addDays, mondayOf } from '../../calendar.ts';
import type { IsoDate } from '../../calendar.ts';
import { validate } from '../../validation.ts';
import type { FieldErrors } from '../../validation.ts';
import { WEEK_KINDS } from '../../training/vocabulary.ts';
import type { WeekKind } from '../../training/vocabulary.ts';
import { REPLAN_REASONS } from '../../training/replan.ts';
import type { FatigueLevel } from '../results.ts';
import { reviewBriefSchema } from './brief.ts';
import type { ReviewBrief } from './brief.ts';

/** The weekly snapshot's shape. Bump it with any change to WeeklyReviewSnapshot or ReviewBrief. */
export const SNAPSHOT_VERSION = 1;

/** What next week is: planned in this block, an outline, a new block or not planned at all. */
export const NEXT_WEEK_STATES = ['planned', 'outline', 'new_block', 'unplanned'] as const;
export type NextWeekState = (typeof NEXT_WEEK_STATES)[number];

/** Why a review proposes no changes to next week; null when it does. */
export const NO_PROPOSAL_REASONS = ['late', 'boundary', 'no_program', 'no_changes'] as const;
export type NoProposalReason = (typeof NO_PROPOSAL_REASONS)[number];

const FATIGUE_LEVELS = ['none', 'watch', 'high'] as const satisfies readonly FatigueLevel[];

export interface WeeklyReviewSnapshot {
	version: typeof SNAPSHOT_VERSION;
	/** The reviewed week's Monday. */
	weekStartsOn: IsoDate;
	/** The owner's day the review was computed on, in `timeZone`. */
	computedOn: IsoDate;
	timeZone: string;
	/** analytics/version.ts's ANALYTICS_VERSION when it was computed. */
	analyticsVersion: number;
	/** digest.ts's inputsDigest of the facts it was computed from. */
	inputsDigest: string;
	adherence: {
		planned: number;
		completed: number;
		skipped: number;
		missed: number;
		/** Completed of planned, in percentage points; null with nothing planned. */
		pct: number | null;
	};
	fatigue: { level: FatigueLevel; reasons: string[] };
	next: { weekStartsOn: IsoDate; state: NextWeekState; kind: WeekKind | null };
	noProposal: NoProposalReason | null;
	/**
	 * M7: the review proposed a deload of `week` (next week, or the week holding the day it was
	 * made on when next week had ended) instead of next week's changes, for `reasons`. Its boundary
	 * is 'deload': no ops are stored, and next week's other changes are listed as not proposed.
	 * Absent on every review that proposed no deload, and on every row stored before M7.
	 */
	deload?: { week: IsoDate; reasons: string[] };
	brief: ReviewBrief;
}

const count = z.int().check(z.nonnegative());
const isoDate = z.iso.date('Use a real date');
// The calendar checks run only on an otherwise valid snapshot: mondayOf throws on a malformed date.
const whenValid = { when: (payload: z.core.ParsePayload) => payload.issues.length === 0 };

export const weeklyReviewSnapshotSchema = z
	.strictObject({
		version: z.literal(SNAPSHOT_VERSION),
		weekStartsOn: isoDate,
		computedOn: isoDate,
		timeZone: z.string().check(z.minLength(1), z.maxLength(64)),
		analyticsVersion: z.int().check(z.positive()),
		inputsDigest: z.string().check(z.regex(/^[0-9a-f]{16}$/, 'Not an inputs digest')),
		adherence: z.strictObject({
			planned: count,
			completed: count,
			skipped: count,
			missed: count,
			pct: z.nullable(z.number().check(z.gte(0), z.lte(100)))
		}),
		fatigue: z.strictObject({
			level: z.enum(FATIGUE_LEVELS),
			reasons: z.array(z.string().check(z.minLength(1), z.maxLength(200)))
		}),
		next: z.strictObject({
			weekStartsOn: isoDate,
			state: z.enum(NEXT_WEEK_STATES),
			kind: z.nullable(z.enum(WEEK_KINDS as [WeekKind, ...WeekKind[]]))
		}),
		noProposal: z.nullable(z.enum(NO_PROPOSAL_REASONS)),
		deload: z.optional(
			z.strictObject({
				week: isoDate,
				reasons: z
					.array(z.string().check(z.minLength(1), z.maxLength(REPLAN_REASONS.length)))
					.check(z.maxLength(REPLAN_REASONS.max))
			})
		),
		brief: reviewBriefSchema
	})
	.check(
		z.refine((s) => mondayOf(s.weekStartsOn) === s.weekStartsOn, {
			message: 'Not a Monday',
			path: ['weekStartsOn'],
			...whenValid
		}),
		z.refine((s) => !s.deload || mondayOf(s.deload.week) === s.deload.week, {
			message: 'Not a Monday',
			path: ['deload', 'week'],
			...whenValid
		}),
		z.refine((s) => s.next.weekStartsOn === addDays(s.weekStartsOn, 7), {
			message: 'Not the week after the reviewed one',
			path: ['next', 'weekStartsOn'],
			...whenValid
		}),
		z.refine(
			(s) =>
				s.brief.kind === 'weekly' &&
				s.brief.from === s.weekStartsOn &&
				s.brief.to === addDays(s.weekStartsOn, 6),
			{ message: 'Not a brief of the reviewed week', path: ['brief'], ...whenValid }
		)
	);

// The schema's output is the interface above, field for field.
const _same: [z.output<typeof weeklyReviewSnapshotSchema>, WeeklyReviewSnapshot] extends [
	WeeklyReviewSnapshot,
	z.output<typeof weeklyReviewSnapshotSchema>
]
	? true
	: false = true;

/** A stored review row, as far as reading its snapshot goes. */
export interface StoredSnapshotRow {
	snapshotVersion: number;
	snapshot: unknown;
	summary: string;
}

/** A row read back: its snapshot at the current version, or legacy with only its summary. */
export type ReadSnapshot<T> =
	| { legacy: false; version: number; summary: string; snapshot: T }
	| { legacy: true; version: number; summary: string };

/** A row at the current version whose snapshot breaks the schema. */
export class SnapshotError extends Error {
	/** The first refused path, dotted ('brief.findings.0.verdict.level'); '' for the root. */
	readonly path: string;
	readonly errors: FieldErrors;

	constructor(errors: FieldErrors) {
		const [path, why] = Object.entries(errors)[0] ?? ['', 'Invalid'];
		super(`The stored review snapshot breaks its contract at ${path || 'its root'}: ${why}`);
		this.name = 'SnapshotError';
		this.path = path;
		this.errors = errors;
	}
}

/**
 * Read a row's snapshot with `schema` when the row is at `version`; any other version is legacy.
 * Shared by the weekly and the cycle review, each with its own schema and version.
 */
export function readVersioned<S extends z.ZodMiniType>(
	schema: S,
	version: number,
	row: StoredSnapshotRow
): ReadSnapshot<z.output<S>> {
	const { snapshotVersion, summary } = row;
	if (snapshotVersion !== version) return { legacy: true, version: snapshotVersion, summary };
	const checked = validate(schema, row.snapshot);
	if (!checked.ok) throw new SnapshotError(checked.errors);
	return { legacy: false, version, summary, snapshot: checked.data };
}

/** A weekly_reviews row's snapshot; throws SnapshotError for a malformed current-version row. */
export function readSnapshot(row: StoredSnapshotRow): ReadSnapshot<WeeklyReviewSnapshot> {
	return readVersioned(weeklyReviewSnapshotSchema, SNAPSHOT_VERSION, row);
}
