/**
 * Validation for the owner's program edits (PRD §5), on zod/mini: what an edit sheet posts, which
 * services/programs/edits.ts parses again and stays the authority over. Import this file by path
 * (servers always, browsers on demand), never through ./index.ts, so no page carries zod in its
 * initial JavaScript.
 *
 * An edit names its session by lineage, which every version keeps. The version it was made on
 * and the owner's today travel beside it, not in it: the service checks them.
 */
import * as z from 'zod/mini';
import { TIMES_OF_DAY } from '../profile/catalog.ts';

/** The longest reason an edit keeps: it is written into its decision's 'why'. */
export const REASON_MAX = 200;

const sessionLineage = z.uuid('Unknown session');

/** Optional; blank counts as no reason. */
const reason = z.optional(
	z
		.string('Write a reason, or leave it blank')
		.check(z.trim(), z.maxLength(REASON_MAX, `Up to ${REASON_MAX} characters`))
);

/** Move a session to another day of its week, at a time of day or at its own. */
export const moveSessionSchema = z.object({
	sessionLineage,
	toDate: z.iso.date('Pick a day'),
	/** Left out, the session keeps its time of day; null leaves the time open. */
	timeOfDay: z.optional(z.nullable(z.enum(TIMES_OF_DAY, 'Pick a time'))),
	reason
});
export type MoveSessionInput = z.output<typeof moveSessionSchema>;

export const skipSessionSchema = z.object({ sessionLineage, reason });
export type SkipSessionInput = z.output<typeof skipSessionSchema>;
