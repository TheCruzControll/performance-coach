/**
 * The findings brief (M6): what a review found, in one shape for the weekly and the cycle review,
 * their screens and the coach's tools. Code writes it; the coach's write-up and the screens read
 * it, so a screen and an answer state the same figure with the same verdict, window and sources.
 *
 * A brief is part of a stored snapshot (snapshot.ts), so any change to its shape bumps
 * SNAPSHOT_VERSION. Pure and server-only at runtime, like all of domain/programming.
 */
import * as z from 'zod/mini';
import type { IsoDate } from '../../calendar.ts';
import type { MetricKind } from '../../analytics/types.ts';
import { METRIC_IDS } from '../../analytics/metrics.ts';
import type { MetricId, MetricUnit } from '../../analytics/metrics.ts';
import { REF_ID_MAX, REF_LABEL_MAX, SOURCE_TYPES } from '../../coach/sources.ts';
import type { SourceRef } from '../../coach/sources.ts';

export const REVIEW_KINDS = ['weekly', 'cycle'] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

/** Where a finding sits on the review screen, in screen order. */
export const FINDING_SECTIONS = [
	'adherence',
	'verdicts',
	'rpe',
	'volume',
	'running',
	'muay_thai',
	'recovery',
	'fatigue',
	'conflicts',
	'goals',
	'effectiveness',
	'prs',
	'next'
] as const;
export type FindingSection = (typeof FINDING_SECTIONS)[number];

/**
 * How a finding reads: good, watch or low as metrics.ts's GoodLevel judges a value, neutral when
 * nothing makes it better or worse, and not_enough_data when there is too little to judge.
 */
export const FINDING_LEVELS = ['good', 'watch', 'low', 'neutral', 'not_enough_data'] as const;
export type FindingLevel = (typeof FINDING_LEVELS)[number];

/** The longest summary a review stores: one sentence a list row and a notification can show. */
export const SUMMARY_MAX = 200;

/** One number in a finding, in canonical units; null: no data, which is not zero. */
export interface FindingFigure {
	label: string;
	value: number | null;
	unit: MetricUnit | null;
	kind: MetricKind;
	/** The figure in words, in the profile's units ('82.5 kg', '3 of 4 sessions'). */
	words: string;
}

export interface Finding {
	/** Stable within a review ('e1rm:bench', 'conflict:2026-11-04'), so the coach can cite it. */
	id: string;
	section: FindingSection;
	label: string;
	figures: FindingFigure[];
	verdict: { level: FindingLevel; words: string };
	/** The days the finding reads ('Trend over the last 12 weeks'); null for a single event. */
	window: { from: IsoDate; to: IsoDate; label: string } | null;
	/** The catalogue metric it reports, whose method and caveat apply; null for anything else. */
	metricId: MetricId | null;
	sources: SourceRef[];
}

export interface ReviewBrief {
	kind: ReviewKind;
	/** The reviewed days: a week, Monday to Sunday, or a block. */
	from: IsoDate;
	to: IsoDate;
	/** At most SUMMARY_MAX characters. */
	summary: string;
	findings: Finding[];
}

const text = (max: number) => z.string().check(z.minLength(1), z.maxLength(max));
const isoDate = z.iso.date('Use a real date');
const finite = z.number().check(z.refine(Number.isFinite, 'Not a finite number'));
// prettier-ignore
const metricUnits = [
	'kg', 'sets', 'rpe', 'm', 's/km', 'runs', 'sessions', 's', 'pct', 'AU', 'ratio', 'h', 'scale'
] as const satisfies readonly MetricUnit[];
const _allUnits: [Exclude<MetricUnit, (typeof metricUnits)[number]>] extends [never]
	? true
	: false = true;

export const sourceRefSchema = z.strictObject({
	type: z.enum(SOURCE_TYPES as [SourceRef['type'], ...SourceRef['type'][]]),
	id: text(REF_ID_MAX),
	label: z.optional(text(REF_LABEL_MAX)),
	date: z.optional(isoDate),
	workoutId: z.optional(text(REF_ID_MAX))
});

const figureSchema = z.strictObject({
	label: text(80),
	value: z.nullable(finite),
	unit: z.nullable(z.enum(metricUnits)),
	kind: z.enum(['measured', 'estimated', 'calculated', 'reported']),
	words: text(120)
});

const findingSchema = z.strictObject({
	id: text(120),
	section: z.enum(FINDING_SECTIONS),
	label: text(120),
	figures: z.array(figureSchema),
	verdict: z.strictObject({ level: z.enum(FINDING_LEVELS), words: text(300) }),
	window: z.nullable(z.strictObject({ from: isoDate, to: isoDate, label: text(80) })),
	metricId: z.nullable(z.enum(METRIC_IDS as [MetricId, ...MetricId[]])),
	sources: z.array(sourceRefSchema)
});

export const reviewBriefSchema = z
	.strictObject({
		kind: z.enum(REVIEW_KINDS),
		from: isoDate,
		to: isoDate,
		summary: text(SUMMARY_MAX),
		findings: z.array(findingSchema)
	})
	.check(
		z.refine((brief) => brief.from <= brief.to, { message: 'Ends before it starts', path: ['to'] }),
		z.refine((brief) => new Set(brief.findings.map((f) => f.id)).size === brief.findings.length, {
			message: 'Each finding id once',
			path: ['findings']
		})
	);

// The schema's output is the interface above, field for field.
const _same: [z.output<typeof reviewBriefSchema>, ReviewBrief] extends [
	ReviewBrief,
	z.output<typeof reviewBriefSchema>
]
	? true
	: false = true;
