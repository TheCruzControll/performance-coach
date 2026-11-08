import { error, json } from '@sveltejs/kit';
import { addDays, mondayOf } from '#lib/domain/calendar.ts';
import { testRoutesEnabled } from '#lib/server/env.ts';
import { ownerId } from '#lib/server/forms/profile.ts';
import { ownerToday } from '#lib/server/local-date.ts';
import {
	getAthleteProfile,
	isProfileInputError,
	saveBasics
} from '#lib/server/services/profile/index.ts';
import {
	createProgramFromPlan,
	getProgramVersion,
	ProgramExistsError
} from '#lib/server/services/programs/index.ts';
import {
	PROGRAM_FIXTURES,
	programFixture,
	type ProgramFixture
} from '#lib/server/test-support/program-fixtures.ts';
import type { RequestHandler } from './$types';

/** Where week 1 starts, in days from the Monday of the owner's current week. */
const START_OFFSETS = { last_week: -7, this_week: 0, next_week: 7 } as const;
type Start = keyof typeof START_OFFSETS;

const isFixture = (value: unknown): value is ProgramFixture =>
	PROGRAM_FIXTURES.includes(value as ProgramFixture);
const isStart = (value: unknown): value is Start =>
	typeof value === 'string' && Object.hasOwn(START_OFFSETS, value);

const invalid = (message: string, errors?: Record<string, string>) =>
	json({ error: 'invalid', message, ...(errors && { errors }) }, { status: 400 });

/**
 * TEST ONLY: store one of the fixture programs (src/lib/server/test-support/program-fixtures.ts)
 * as the signed-in owner's program, through createProgramFromPlan as a build would, so the
 * program screens can be tested before the generator lands. 404 unless ENABLE_TEST_ROUTES is on
 * *and* allowed here (local development and tests, never a hosted deployment).
 *
 * POST {fixture, start: 'last_week' | 'this_week' | 'next_week', timeZone}:
 * - records `timeZone` on the profile (Profile → Body & units' service), then takes today from
 *   it with ownerToday, so dates are the server's and never depend on the machine's zone
 * - week 1 starts on the Monday of last, this or next week; the 'today' fixtures and
 *   'workout-day' (the shared kit fixture's program) need this_week
 * - answers 201 {programId, version, today, weekStart, sessions: [{ref, lineage, date, title}]},
 *   where `ref` is the session's path in version 1 (`blocks.0.weeks.1.sessions.2`, by day and
 *   then order in the day, as the store reads a week back)
 * - refuses with 409 while a program is active. It never deletes anything: e2e/program-support.ts
 *   resets programs before seeding. The zone is recorded first (today depends on it), so a seed
 *   refused after that (409, or a fixture that does not fit `start`) still leaves it on the profile.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!testRoutesEnabled()) error(404, 'Not found');
	const owner = ownerId(locals);

	const text = await request.text();
	let body: { fixture?: unknown; start?: unknown; timeZone?: unknown };
	try {
		body = JSON.parse(text) ?? {};
	} catch {
		return invalid('Body must be JSON');
	}
	const { fixture, start, timeZone } = body;
	if (!isFixture(fixture)) return invalid(`fixture must be one of ${PROGRAM_FIXTURES.join(', ')}`);
	if (!isStart(start))
		return invalid(`start must be one of ${Object.keys(START_OFFSETS).join(', ')}`);
	if (typeof timeZone !== 'string') return invalid('timeZone must be an IANA time zone');

	try {
		const { name, weightUnit, distanceUnit } = await getAthleteProfile(owner);
		await saveBasics(owner, { name, weightUnit, distanceUnit, timeZone });
	} catch (err) {
		if (isProfileInputError(err)) return invalid('The profile refused timeZone', err.errors);
		throw err;
	}

	const today = await ownerToday(owner, new Date());
	const weekStart = addDays(mondayOf(today), START_OFFSETS[start]);
	let plan;
	try {
		plan = programFixture(fixture, { monday: weekStart, today });
	} catch (err) {
		if (err instanceof RangeError) return invalid(err.message);
		throw err;
	}

	let created;
	try {
		created = await createProgramFromPlan(owner, plan, { source: 'rules' });
	} catch (err) {
		if (err instanceof ProgramExistsError) {
			const message = 'A program is active: reset programs before seeding another';
			return json({ error: 'program_exists', message }, { status: 409 });
		}
		throw err;
	}

	const stored = await getProgramVersion(owner, created.programId, 1);
	const sessions = stored.blocks.flatMap((block, b) =>
		block.weeks.flatMap((week, w) =>
			week.sessions.map((session, s) => ({
				ref: `blocks.${b}.weeks.${w}.sessions.${s}`,
				lineage: session.lineage,
				date: session.date,
				title: session.title
			}))
		)
	);
	return json(
		{ programId: created.programId, version: stored.version.number, today, weekStart, sessions },
		{ status: 201 }
	);
};
