/**
 * Which state Today shows once onboarding is complete (src/routes/(app)/today/program.server.ts),
 * on real Postgres: 'none' until a program is built, then 'active', with the owner's today. When the database cannot be
 * reached it fails soft: null, and the failure recorded as a server error.
 */
import { describe, expect, it } from 'vitest';
import { findErrorsByRequestId } from '../../../src/lib/server/services/errors';
import { createProgramFromPlan } from '../../../src/lib/server/services/programs/index';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { loadTodayProgram } from '../../../src/routes/(app)/today/program.server';
import { unreachableDb, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const now = new Date('2026-11-05T09:00:00Z');
const origin = (requestId = crypto.randomUUID()) => ({
	requestId,
	method: 'GET',
	path: '/today',
	routeId: '/(app)/today',
	appVersion: '0.1.0+test'
});

describe('Today’s program state', () => {
	it("is 'none' until a program exists, then 'active'", async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			expect(await loadTodayProgram(owner, { now, origin: origin() }, { db })).toEqual({
				state: 'none',
				today: '2026-11-05'
			});
			const plan = programFixture('hybrid', { monday: '2026-11-09', today: '2026-11-05' });
			await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
			expect(await loadTodayProgram(owner, { now, origin: origin() }, { db })).toEqual({
				state: 'active',
				today: '2026-11-05'
			});
		});
	});

	it('fails soft when the database cannot be reached, and records the failure', async () => {
		const broken = unreachableDb();
		try {
			await withRollback(async (tx) => {
				const request = origin();
				const state = await loadTodayProgram(
					crypto.randomUUID(),
					{ now, origin: request },
					{ db: broken.db, errorsDb: tx }
				);
				expect(state).toBeNull();
				const recorded = await findErrorsByRequestId(request.requestId, { db: tx });
				expect(recorded).toHaveLength(1);
				expect(recorded[0]).toMatchObject({
					kind: 'load',
					status: 500,
					path: '/today',
					context: expect.objectContaining({ load: 'todayProgram' })
				});
			});
		} finally {
			await broken.close();
		}
	});
});
