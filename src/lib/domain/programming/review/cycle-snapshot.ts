/**
 * What a stored cycle review is (M6): the versioned snapshot of one finished block, its schema and
 * the one way to read a row back, on review-snapshot's contract (snapshot.ts): a row at another
 * version reads as legacy with its summary, and a current-version row that breaks the schema
 * throws a SnapshotError naming the path.
 *
 * The snapshot keeps every figure the next block is planned from (cycle-directives reads it), so
 * the review reads the same after the log is edited. Any change to the shape below or to the
 * brief's (brief.ts) bumps CYCLE_SNAPSHOT_VERSION. Pure and server-only, like domain/programming.
 */
import * as z from 'zod/mini';
import { addDays, mondayOf } from '../../calendar.ts';
import type { IsoDate } from '../../calendar.ts';
import { WEEKDAYS } from '../../profile/catalog.ts';
import type { Weekday } from '../../profile/catalog.ts';
import { MUSCLE_GROUPS, PHASES } from '../../training/vocabulary.ts';
import type { MuscleGroup, Phase } from '../../training/vocabulary.ts';
import type { FatigueLevel } from '../results.ts';
import { FINDING_LEVELS, reviewBriefSchema } from './brief.ts';
import type { FindingLevel, ReviewBrief } from './brief.ts';
import { readVersioned } from './snapshot.ts';
import type { ReadSnapshot, StoredSnapshotRow } from './snapshot.ts';

/** The cycle snapshot's shape. Bump it with any change to CycleReviewSnapshot or ReviewBrief. */
export const CYCLE_SNAPSHOT_VERSION = 1;

/** How an exercise did over the block, by its estimated 1RM. */
export const EFFECTIVENESS_VERDICTS = ['progressed', 'held', 'regressed', 'too_few'] as const;
export type EffectivenessVerdict = (typeof EFFECTIVENESS_VERDICTS)[number];

/** Whether the next block should open with a deload. */
export const DELOAD_NEEDS = ['needed', 'consider', 'not_needed'] as const;
export type DeloadNeed = (typeof DELOAD_NEEDS)[number];

/** What a goal's progress is measured by; none when its target cannot be read. */
export const GOAL_MEASURES = ['e1rm', 'pace', 'hard_sets', 'sessions', 'none'] as const;
export type GoalMeasure = (typeof GOAL_MEASURES)[number];

interface Counts {
	planned: number;
	completed: number;
	skipped: number;
	missed: number;
	/** Completed of those due, in percentage points; null with nothing due. */
	pct: number | null;
}

export interface CycleReviewSnapshot {
	version: typeof CYCLE_SNAPSHOT_VERSION;
	block: { lineage: string; name: string; phase: Phase; from: IsoDate; to: IsoDate; weeks: number };
	computedOn: IsoDate;
	timeZone: string;
	analyticsVersion: number;
	inputsDigest: string;
	adherence: Counts & {
		/** Adherence too low to judge progression: the verdicts say so instead. */
		verdictsWithheld: boolean;
		weeks: (Counts & { weekStartsOn: IsoDate })[];
		oftenMissed: Weekday[];
	};
	goals: { goalId: string; measure: GoalMeasure; sessions: number; level: FindingLevel }[];
	effectiveness: {
		exercise: string;
		main: boolean;
		verdict: EffectivenessVerdict;
		/** Sessions of it in the block with an estimated 1RM. */
		exposures: number;
		firstKg: number | null;
		lastKg: number | null;
		/** Not progressed over STALL_EXPOSURES or more sessions. */
		stalled: boolean;
	}[];
	/** Hard sets per group per week: planned (plannedHardSets), achieved (hardSets), the range. */
	volume: {
		weekStartsOn: IsoDate;
		group: MuscleGroup;
		planned: number | null;
		achieved: number;
		target: [number, number] | null;
	}[];
	fatigue: { level: FatigueLevel; reasons: string[]; deloadPlanned: boolean };
	deloadNeed: { verdict: DeloadNeed; reasons: string[] };
	previous: { from: IsoDate; to: IsoDate; summary: string } | null;
	next: { name: string; phase: Phase; startsOn: IsoDate } | null;
	brief: ReviewBrief;
}

const count = z.int().check(z.nonnegative());
const isoDate = z.iso.date('Use a real date');
const sets = z.number().check(z.gte(0));
const words = (max: number) => z.string().check(z.minLength(1), z.maxLength(max));
const pct = z.nullable(z.number().check(z.gte(0), z.lte(100)));
const counts = { planned: count, completed: count, skipped: count, missed: count, pct };
const kg = z.nullable(z.number().check(z.positive()));
const whenValid = { when: (payload: z.core.ParsePayload) => payload.issues.length === 0 };

export const cycleReviewSnapshotSchema = z
	.strictObject({
		version: z.literal(CYCLE_SNAPSHOT_VERSION),
		block: z.strictObject({
			lineage: words(64),
			name: words(120),
			phase: z.enum(PHASES as [Phase, ...Phase[]]),
			from: isoDate,
			to: isoDate,
			weeks: z.int().check(z.positive())
		}),
		computedOn: isoDate,
		timeZone: words(64),
		analyticsVersion: z.int().check(z.positive()),
		inputsDigest: z.string().check(z.regex(/^[0-9a-f]{16}$/, 'Not an inputs digest')),
		adherence: z.strictObject({
			...counts,
			verdictsWithheld: z.boolean(),
			weeks: z.array(z.strictObject({ weekStartsOn: isoDate, ...counts })),
			oftenMissed: z.array(z.enum(WEEKDAYS))
		}),
		goals: z.array(
			z.strictObject({
				goalId: words(64),
				measure: z.enum(GOAL_MEASURES),
				sessions: count,
				level: z.enum(FINDING_LEVELS)
			})
		),
		effectiveness: z.array(
			z.strictObject({
				exercise: words(120),
				main: z.boolean(),
				verdict: z.enum(EFFECTIVENESS_VERDICTS),
				exposures: count,
				firstKg: kg,
				lastKg: kg,
				stalled: z.boolean()
			})
		),
		volume: z.array(
			z.strictObject({
				weekStartsOn: isoDate,
				group: z.enum(MUSCLE_GROUPS as [MuscleGroup, ...MuscleGroup[]]),
				planned: z.nullable(sets),
				achieved: sets,
				target: z.nullable(z.tuple([sets, sets]))
			})
		),
		fatigue: z.strictObject({
			level: z.enum(['none', 'watch', 'high'] as const satisfies readonly FatigueLevel[]),
			reasons: z.array(words(200)),
			deloadPlanned: z.boolean()
		}),
		deloadNeed: z.strictObject({ verdict: z.enum(DELOAD_NEEDS), reasons: z.array(words(200)) }),
		previous: z.nullable(z.strictObject({ from: isoDate, to: isoDate, summary: words(200) })),
		next: z.nullable(
			z.strictObject({
				name: words(120),
				phase: z.enum(PHASES as [Phase, ...Phase[]]),
				startsOn: isoDate
			})
		),
		brief: reviewBriefSchema
	})
	.check(
		z.refine((s) => mondayOf(s.block.from) === s.block.from, {
			message: 'Not a Monday',
			path: ['block', 'from'],
			...whenValid
		}),
		z.refine((s) => s.block.to === addDays(s.block.from, 7 * s.block.weeks - 1), {
			message: 'Not the end of its weeks',
			path: ['block', 'to'],
			...whenValid
		}),
		z.refine(
			(s) => s.brief.kind === 'cycle' && s.brief.from === s.block.from && s.brief.to === s.block.to,
			{ message: 'Not a brief of the reviewed block', path: ['brief'], ...whenValid }
		)
	);

// The schema's output is the interface above, field for field.
const _same: [z.output<typeof cycleReviewSnapshotSchema>, CycleReviewSnapshot] extends [
	CycleReviewSnapshot,
	z.output<typeof cycleReviewSnapshotSchema>
]
	? true
	: false = true;

/** A cycle_reviews row's snapshot; throws SnapshotError for a malformed current-version row. */
export function readCycleSnapshot(row: StoredSnapshotRow): ReadSnapshot<CycleReviewSnapshot> {
	return readVersioned(cycleReviewSnapshotSchema, CYCLE_SNAPSHOT_VERSION, row);
}
