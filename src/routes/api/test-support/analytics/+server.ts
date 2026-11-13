import { error, json } from '@sveltejs/kit';
import { testRoutesEnabled } from '#lib/server/env.ts';
import { ownerId } from '#lib/server/forms/profile.ts';
import {
	isRoadFault,
	ROAD_FAULTS,
	setRoadFault
} from '#lib/server/services/periodisation/road-faults.ts';
import { isProfileInputError } from '#lib/server/services/profile/index.ts';
import {
	AnalyticsSeedConflictError,
	FIXTURES,
	isAnalyticsFixture,
	seedAnalyticsFixture
} from '#lib/server/test-support/analytics-fixtures/index.ts';
import type { RequestHandler } from './$types';

const invalid = (message: string, errors?: Record<string, string>) =>
	json({ error: 'invalid', message, ...(errors && { errors }) }, { status: 400 });

/**
 * TEST ONLY: seed one of the analytics fixtures (src/lib/server/test-support/analytics-fixtures)
 * for the signed-in owner, through the real services, so the M6 dashboards can be tested against
 * a known history. 404 unless ENABLE_TEST_ROUTES is on *and* allowed here (local development and
 * tests, never a hosted deployment).
 *
 * POST {fixture, timeZone}:
 * - records `timeZone` on the profile, then takes today from it (ownerToday), so every date is
 *   the server's and never the machine's
 * - answers 201 {fixture, timeZone, today, weekStart, historyStart, programId, exercises,
 *   workouts, lineages}: the ids a spec needs, by the names the fixture gives them
 * - refuses with 409 while the owner has a program, workouts or recovery notes, and writes
 *   nothing: e2e/analytics-support.ts resets before seeding
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!testRoutesEnabled()) error(404, 'Not found');
	const owner = ownerId(locals);

	let body: { fixture?: unknown; timeZone?: unknown };
	try {
		body = JSON.parse(await request.text()) ?? {};
	} catch {
		return invalid('Body must be JSON');
	}
	const { fixture, timeZone } = body;
	if (!isAnalyticsFixture(fixture)) {
		return invalid(`fixture must be one of ${Object.keys(FIXTURES).join(', ')}`);
	}
	if (typeof timeZone !== 'string') return invalid('timeZone must be an IANA time zone');

	try {
		return json(await seedAnalyticsFixture(owner, fixture, { timeZone }), { status: 201 });
	} catch (err) {
		if (err instanceof AnalyticsSeedConflictError) {
			return json({ error: 'training_data_exists', message: err.message }, { status: 409 });
		}
		if (isProfileInputError(err)) return invalid('The profile refused timeZone', err.errors);
		throw err;
	}
};

/**
 * TEST ONLY: PUT {roadFault}, one of ROAD_FAULTS (m7/39, road-faults.ts): 'slow' holds Train's
 * road read until the next PUT (at most ROAD_FAULT_HOLD_MS), 'fail' fails it, 'none' clears it and
 * releases any read held. Answers 200 {roadFault}; 404 where test routes are not enabled.
 */
export const PUT: RequestHandler = async ({ locals, request }) => {
	if (!testRoutesEnabled()) error(404, 'Not found');
	ownerId(locals);
	let body: { roadFault?: unknown };
	try {
		body = JSON.parse(await request.text()) ?? {};
	} catch {
		return invalid('Body must be JSON');
	}
	const { roadFault } = body;
	if (!isRoadFault(roadFault)) return invalid(`roadFault must be one of ${ROAD_FAULTS.join(', ')}`);
	setRoadFault(roadFault);
	return json({ roadFault });
};
