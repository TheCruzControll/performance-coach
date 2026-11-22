/**
 * The re-plan contract (M7, PRD §5; docs/adr/NNNN-replans-as-versions.md): what a re-plan is asked
 * for, and the payload an M5 proposal of kind replan stores. The change itself is re-derived from
 * the payload at accept, so the payload holds only the request and the hashes that tell whether
 * the profile or the plan moved since.
 *
 * Four directives, discriminated by kind:
 * - priorities: the goals' effective priorities changed (a reorder, a status, an event date, an
 *   accepted coach goal_update, or the coach)
 * - block: a chosen phase for 3 to 8 weeks, maintenance included, optionally for one goal
 * - taper: an event goal's taper, its form full or a mini-taper
 * - deload: one week (a Monday) deloaded in place, with who asked and why
 *
 * Validators use zod/mini and are imported by path: this module is never reachable from
 * ./index.ts (scripts/training-index-imports.test.ts), so zod stays out of client JS.
 */
import * as z from 'zod/mini';
import { mondayOf } from '../calendar.ts';
import { PHASES } from './vocabulary.ts';
import type { Phase } from './vocabulary.ts';

/** The phases a block directive may ask for: every planned phase, never the bridge between blocks. */
export const REPLAN_PHASES = PHASES.filter((p) => p !== 'transition') as Exclude<
	Phase,
	'transition'
>[];

/** A block directive's weeks, inclusive. */
export const REPLAN_BLOCK_WEEKS = { min: 3, max: 8 } as const;
/** A deload directive's reasons: at most this many, each at most this long. */
export const REPLAN_REASONS = { max: 5, length: 160 } as const;

export const PRIORITY_CAUSES = ['reorder', 'status', 'event', 'goal_update', 'coach'] as const;
export const DELOAD_TRIGGERS = ['reactive', 'owner', 'coach'] as const;
/** A taper's form, as periodisation/taper.ts names it ('kind' is the directive's discriminator). */
export const TAPER_FORMS = ['full', 'mini'] as const;

const monday = z.iso
	.date('Use a real date')
	.check(z.refine((d) => mondayOf(d) === d, 'Start on a Monday'));
const uuid = z.uuid('Pick a goal');
const hash = z.string('Not a digest').check(z.regex(/^[0-9a-f]{16}$/, 'Not a digest'));
const reason = z
	.string('Give a reason')
	.check(
		z.trim(),
		z.minLength(1, 'Give a reason'),
		z.maxLength(REPLAN_REASONS.length, `Up to ${REPLAN_REASONS.length} characters`)
	);

export const replanDirectiveSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('priorities'), cause: z.enum(PRIORITY_CAUSES, 'Pick a cause') }),
	z.object({
		kind: z.literal('block'),
		phase: z.enum(REPLAN_PHASES, 'Pick a phase'),
		weeks: z
			.int('Whole weeks')
			.check(
				z.minimum(
					REPLAN_BLOCK_WEEKS.min,
					`${REPLAN_BLOCK_WEEKS.min} to ${REPLAN_BLOCK_WEEKS.max} weeks`
				),
				z.maximum(
					REPLAN_BLOCK_WEEKS.max,
					`${REPLAN_BLOCK_WEEKS.min} to ${REPLAN_BLOCK_WEEKS.max} weeks`
				)
			),
		focusGoalRef: z.optional(uuid)
	}),
	z.object({ kind: z.literal('taper'), goalRef: uuid, form: z.enum(TAPER_FORMS, 'Pick a taper') }),
	z.object({
		kind: z.literal('deload'),
		week: monday,
		trigger: z.enum(DELOAD_TRIGGERS, 'Pick who asked'),
		reasons: z
			.array(reason)
			.check(z.maxLength(REPLAN_REASONS.max, `Up to ${REPLAN_REASONS.max} reasons`))
	})
]);
export type ReplanDirective = z.output<typeof replanDirectiveSchema>;
export type ReplanDirectiveKind = ReplanDirective['kind'];

/** An M5 replan proposal's payload: re-derived at accept, so only the request and the hashes. */
export const replanPayloadSchema = z.object({
	directive: replanDirectiveSchema,
	/** The first day the new version may differ on. */
	from: monday,
	baseVersionNumber: z.int('A version').check(z.minimum(1, 'A version')),
	/** Today's profile input, the directive, the base version and from: never the actuals. */
	fingerprint: hash,
	/** The new plan's shape from `from`: phases, week kinds and dates, sessions, never loads. */
	shapeDigest: hash
});
export type ReplanPayload = z.output<typeof replanPayloadSchema>;
