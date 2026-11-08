import { error, json } from '@sveltejs/kit';
import { MOCK_SCRIPTS } from '#lib/server/agent/provider/mock-scripts/index.ts';
import { testRoutesEnabled } from '#lib/server/env.ts';
import { ownerId } from '#lib/server/forms/profile.ts';
import { isProfileInputError } from '#lib/server/services/profile/index.ts';
import {
	applyCoachFault,
	COACH_FAULTS,
	COACH_FIXTURES,
	CoachSeedConflictError,
	isCoachFault,
	isCoachFixture,
	seedCoachFixture
} from '#lib/server/test-support/coach-fixtures.ts';
import type { RequestHandler } from './$types';

/** The longest delay or turn a test may ask for: a test never waits a minute on one chunk. */
const MAX_MS = 60_000;

const invalid = (message: string, errors?: Record<string, string>) =>
	json({ error: 'invalid', message, ...(errors && { errors }) }, { status: 400 });

const isMs = (value: unknown, min: number) =>
	value === undefined ||
	(Number.isInteger(value) && (value as number) >= min && (value as number) <= MAX_MS);

/**
 * TEST ONLY: make coach journeys deterministic. 404 unless ENABLE_TEST_ROUTES is on *and* allowed
 * here (local development and tests, never a hosted deployment, where the mock never reads the
 * overrides either).
 *
 * POST {fixture, timeZone}: seed a coach fixture (src/lib/server/test-support/coach-fixtures.ts)
 * for the signed-in owner, at dates taken from `timeZone`; 201 with the ids a spec needs; 409
 * while the owner has threads, a program or workouts (e2e/coach-support.ts resets first).
 *
 * POST {fault?, script?, chunkDelayMs?, turnMs?}: what the next turns do, until the next POST:
 * - fault: one of COACH_FAULTS (default none), described there
 * - script: a mock script that answers whatever the owner asks (it wins over a fault's script)
 * - chunkDelayMs: a wait before every streamed chunk; turnMs: a turn's time, so a slow answer
 *   times out
 * Answers 200 {fault, overrides}.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!testRoutesEnabled()) error(404, 'Not found');
	const owner = ownerId(locals);

	let body: Record<string, unknown>;
	try {
		body = JSON.parse(await request.text()) ?? {};
	} catch {
		return invalid('Body must be JSON');
	}

	if (body.fixture !== undefined) {
		const { fixture, timeZone } = body;
		if (!isCoachFixture(fixture))
			return invalid(`fixture must be one of ${COACH_FIXTURES.join(', ')}`);
		if (typeof timeZone !== 'string') return invalid('timeZone must be an IANA time zone');
		try {
			return json(await seedCoachFixture(owner, fixture, { timeZone }), { status: 201 });
		} catch (err) {
			if (err instanceof CoachSeedConflictError)
				return json({ error: 'coach_data_exists', message: err.message }, { status: 409 });
			if (isProfileInputError(err)) return invalid('The profile refused timeZone', err.errors);
			throw err;
		}
	}

	const { fault = 'none', script, chunkDelayMs, turnMs } = body;
	if (!isCoachFault(fault))
		return invalid(`fault must be one of ${Object.keys(COACH_FAULTS).join(', ')}`);
	if (script !== undefined && !MOCK_SCRIPTS.some((each) => each.name === script))
		return invalid('script must name a mock script');
	if (!isMs(chunkDelayMs, 0)) return invalid(`chunkDelayMs must be 0 to ${MAX_MS}`);
	if (!isMs(turnMs, 1)) return invalid(`turnMs must be 1 to ${MAX_MS}`);

	const overrides = await applyCoachFault(owner, fault, {
		...(script !== undefined && { script: script as string }),
		...(chunkDelayMs !== undefined && { chunkDelayMs: chunkDelayMs as number }),
		...(turnMs !== undefined && { turnMs: turnMs as number })
	});
	return json({ fault, overrides });
};
