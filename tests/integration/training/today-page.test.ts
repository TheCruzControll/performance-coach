/**
 * Today's page data (src/routes/(app)/today/load.server.ts) on real Postgres, on the shared pool
 * as the page reads it: the setup card alone until onboarding is complete, then the program state,
 * and with a program the streamed plan. The setup and the program are read together, so more than
 * one statement is in flight at once, each on its own connection (the integration setup fails any
 * statement sent to a busy client).
 */
import { describe, expect, it, vi } from 'vitest';
import type { Executor } from '../../../src/lib/server/db/types';
import {
	completeOnboarding,
	createGoal,
	saveSchedule
} from '../../../src/lib/server/services/profile/index';
import { createProgramFromPlan } from '../../../src/lib/server/services/programs/index';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { loadToday } from '../../../src/routes/(app)/today/load.server';
import * as programRead from '../../../src/routes/(app)/today/program.server';
import * as weekRead from '../../../src/routes/(app)/today/week.server';
import { watchPool, withCommitted } from '../helpers';
import { generalGoal, makeOwner } from '../profile/fixtures';

// The reads as they are, watched: which ones loadToday starts.
vi.mock('../../../src/routes/(app)/today/program.server', async (original) => {
	const real = await original<typeof programRead>();
	return { ...real, loadTodayProgram: vi.fn(real.loadTodayProgram) };
});
vi.mock('../../../src/routes/(app)/today/week.server', async (original) => {
	const real = await original<typeof weekRead>();
	return { ...real, loadTodayWeek: vi.fn(real.loadTodayWeek) };
});

/** A Thursday, and a morning on it. */
const TODAY = '2026-11-05';
const now = new Date(`${TODAY}T09:00:00Z`);
const origin = {
	requestId: crypto.randomUUID(),
	method: 'GET',
	path: '/today',
	routeId: '/(app)/today',
	appVersion: '0.1.0+test'
};

async function onboarded(db: Executor) {
	const owner = await makeOwner(db);
	await createGoal(owner, generalGoal(), { db });
	await saveSchedule(
		owner,
		{
			daysPerWeek: 3,
			availableDays: [],
			preferredTimes: [],
			sessionMinutes: null,
			constraints: null,
			commitments: []
		},
		{ db }
	);
	await completeOnboarding(owner, { db });
	return owner;
}

describe('Today’s page data', () => {
	it('reads the setup and the program together, then streams the plan from that program', async () => {
		await withCommitted(async (db) => {
			const owner = await onboarded(db);
			const plan = programFixture('today', { monday: '2026-11-02', today: TODAY });
			await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
			const pool = watchPool();
			const data = await loadToday(owner, { now, origin }).finally(pool.stop);
			expect(data.setup).toMatchObject({ complete: true });
			expect(data.program).toBe('active');
			const view = await data.plan;
			expect(view).toMatchObject({ failed: false, starts: null, complete: null });
			expect(view?.failed === false && view.week).toMatchObject({
				label: 'Week 1',
				today: TODAY,
				selected: TODAY
			});
			// This week's figures stream beside the plan: nothing logged yet, so no data yet.
			expect(await data.week).toMatchObject({
				failed: false,
				tiles: [{ value: null }, { value: null }, { value: null }]
			});
			expect(pool.peak()).toBeGreaterThan(1);
		});
	});

	it('shows the setup card alone until onboarding is complete', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			vi.mocked(programRead.loadTodayProgram).mockClear();
			vi.mocked(weekRead.loadTodayWeek).mockClear();
			const data = await loadToday(owner, { now, origin });
			expect(data).toEqual({
				setup: { complete: false, done: 0, total: expect.any(Number), next: 'welcome' },
				program: undefined,
				plan: undefined,
				week: undefined
			});
			// Once the program read has answered, the week's reads have not started for nothing.
			await vi.mocked(programRead.loadTodayProgram).mock.results[0]!.value;
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(weekRead.loadTodayWeek).not.toHaveBeenCalled();
		});
	});

	it("is 'none' with no plan once onboarded without a program", async () => {
		await withCommitted(async (db) => {
			const owner = await onboarded(db);
			const data = await loadToday(owner, { now, origin });
			expect(data.setup).toMatchObject({ complete: true });
			expect(data).toMatchObject({ program: 'none', plan: undefined });
			// A week before any program still reads: no data yet until the first session.
			expect(await data.week).toMatchObject({ failed: false });
		});
	});
});
