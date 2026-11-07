/**
 * The Build confirm (PRD §5): the previewed program, stored as the owner's program and its
 * version 1, with every decision the generator made and the confirmation, in one transaction
 * (createProgramFromPlan).
 *
 * No draft was stored, so the build regenerates from the profile as it is now, with the dates
 * the preview showed, and stores it only if it is what the owner saw. Otherwise nothing is
 * written and a ProgrammingConflictError says why, so the screen never shows a false 'your
 * profile changed':
 * - 'start_date': the previewed first day has passed (a build after midnight): it's a new day.
 * - 'library': the exercise library's digest changed (a re-seeded catalogue, an own exercise).
 * - 'profile': the profile gives another fingerprint.
 * The fingerprint ignores the time zone and the start dates, so recording the device's zone
 * never makes a retry a conflict, and a repeated build (a double tap, a retried request) returns
 * the program the first one stored.
 */
import * as z from 'zod/mini';
import { daysBetween, mondayOf } from '../../../domain/calendar';
import { DecisionLog } from '../../../domain/programming/decisions';
import { GENERATOR_ID } from '../../../domain/programming/index';
import type { FieldErrors } from '../../../domain/validation';
import { createProgramFromPlan, type CreatedProgram } from '../programs/store';
import { ConflictError, parseWith, resolveDeps, TrainingInputError } from '../training/shared';
import { generateFor, type ProgrammingDeps } from './preview';
import { previewRequestSchema, startDates } from './start';

export type ProgrammingConflictReason = 'profile' | 'library' | 'start_date';

const CONFLICT_MESSAGE: Readonly<Record<ProgrammingConflictReason, string>> = {
	profile: 'the profile changed since the preview',
	library: 'the exercise library changed since the preview',
	start_date: "the preview's first planned day has passed"
};

/** The previewed program is no longer what a build would store: nothing was written. */
export class ProgrammingConflictError extends ConflictError<ProgrammingConflictReason> {
	constructor(reason: ProgrammingConflictReason) {
		super(reason, CONFLICT_MESSAGE[reason]);
		this.name = 'ProgrammingConflictError';
	}
}

/** FNV-1a 64-bit, as random.ts writes it. */
const hash = z.string('Preview again').check(z.regex(/^[0-9a-f]{16}$/, 'Preview again'));

/** What the Build confirm sends back: the preview's request, its dates and its fingerprints. */
const buildRequestSchema = z.object({
	...previewRequestSchema.shape,
	startsOn: z.iso.date('Use a real date'),
	firstPlannedDay: z.iso.date('Use a real date'),
	fingerprint: hash,
	digest: hash
});
export type BuildRequest = z.output<typeof buildRequestSchema>;

/** Dates no preview of `start` gives, from that day or an earlier one. */
function dateErrors({ today, start, startsOn, firstPlannedDay }: BuildRequest): FieldErrors {
	const errors: FieldErrors = {};
	const offset = daysBetween(startsOn, firstPlannedDay);
	if (mondayOf(startsOn) !== startsOn) errors.startsOn = 'Start on a Monday';
	else if (offset < 0 || offset > 6 || (start === 'next_monday' && offset !== 0)) {
		errors.firstPlannedDay = 'Not a day of week 1';
	} else if (firstPlannedDay > startDates(today, start).firstPlannedDay) {
		errors.firstPlannedDay = 'Later than this start allows';
	}
	return errors;
}

/**
 * Build the previewed program for the owner. `deps.source` confirms it: the owner on Today, or
 * the coach's tool (M5). Refused with a ProgrammingConflictError when it no longer matches the
 * preview, a TrainingInputError for a request no preview sent or an unfinished onboarding, and
 * the store's ProgramExistsError while another program is active.
 */
export async function buildProgram(
	ownerId: string,
	request: unknown,
	deps: ProgrammingDeps = {}
): Promise<CreatedProgram> {
	const confirm = parseWith(buildRequestSchema, request);
	const errors = dateErrors(confirm);
	if (Object.keys(errors).length > 0) throw new TrainingInputError(errors);
	const { today, startsOn, firstPlannedDay } = confirm;
	if (firstPlannedDay < today) throw new ProgrammingConflictError('start_date');

	const { db, now, source } = resolveDeps(deps);
	if (source === 'rules') throw new TrainingInputError({ source: 'You or the coach confirm it' });
	const { plan, input, digest, fingerprint } = await generateFor(
		ownerId,
		{ startsOn, firstPlannedDay },
		{ ...deps, db }
	);
	if (digest !== confirm.digest) throw new ProgrammingConflictError('library');
	if (fingerprint !== confirm.fingerprint) throw new ProgrammingConflictError('profile');

	const confirmed = new DecisionLog(source).add('owner_confirmed', 'program.confirmed', [], {
		fingerprint,
		digest,
		startsOn,
		firstPlannedDay
	});
	return createProgramFromPlan(
		ownerId,
		{ ...plan, decisions: [...plan.decisions, confirmed] },
		{
			source: 'rules',
			generator: GENERATOR_ID,
			fingerprint,
			digest,
			// Plain data (no Date, Map or undefined), so jsonb stores it exactly.
			snapshot: input as unknown as Record<string, unknown>
		},
		{ db, now }
	);
}
