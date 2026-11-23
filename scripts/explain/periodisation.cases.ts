/**
 * M7's server time in db:explain (m7-plan, 'SCREENS AND BUDGETS'): each M7 path timed against the
 * same path without M7, in the same run, on M3's two-year dataset (dataset.ts) loaded by
 * history.explain.ts. Only the difference of two medians is gated, so the machine cancels out
 * and no machine's numbers are committed. Later M7 cases join this file.
 *
 * - Train's load (week.server.ts loadTrainWeek) for the dataset's current week, with
 *   deps.periodisation on (the week's findings, m7/04) and off (every M7 read skipped):
 *   WARM_UPS pairs, then RUNS of each, interleaved. Both medians and their difference are printed
 *   against TRAIN_TARGET_MS, for information only: performance is not tested in CI (the owner's
 *   decision of 2026-11-22, docs/decisions.md). The run still fails if Train does not render.
 */
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';
import { addDays } from '../../src/lib/domain/calendar';
import type * as schema from '../../src/lib/server/db/schema';
import { loadTrainWeek, type TrainLoadDeps } from '../../src/routes/(app)/train/week.server';
import { FIRST_MONDAY, WEEKS } from './dataset';

/** Runs before the timed ones, alternating, and the timed runs of each path. */
export const WARM_UPS = 3;
export const RUNS = 15;
/** Train's load with the findings, over its median without them (m7-plan); printed, not gated. */
export const TRAIN_TARGET_MS = 10;

export interface PeriodisationHarness {
	db: NodePgDatabase<typeof schema>;
	/** The dataset's one owner, whose active program Train reads. */
	owner: string;
}

const median = (values: readonly number[]) => {
	const sorted = values.toSorted((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

export function periodisationExplain({ db, owner }: PeriodisationHarness): void {
	/** Noon on the Wednesday of the dataset's last week, as history.explain.ts's TODAY. */
	const now = new Date(`${addDays(FIRST_MONDAY, (WEEKS - 1) * 7 + 2)}T12:00:00Z`);
	const origin = {
		...{ requestId: crypto.randomUUID(), method: 'GET', path: '/train' },
		...{ routeId: '/(app)/train', appVersion: 'explain' }
	};

	/** One load, timed; it must render the week, with its findings when they are on. */
	async function time(periodisation: TrainLoadDeps['periodisation']): Promise<number> {
		const started = performance.now();
		const data = await loadTrainWeek(
			owner,
			{ now, week: null, origin },
			{ db, errorsDb: db, periodisation }
		);
		const elapsed = performance.now() - started;
		if (data.state !== 'program') throw new Error(`Train's load gave ${data.state}`);
		const line = data.noteParts.summary;
		if ((line !== null) !== (periodisation !== false)) {
			throw new Error(
				`Train's load gave week line ${line} with periodisation ${periodisation !== false}`
			);
		}
		return elapsed;
	}

	describe('M7 periodisation: server time against the same path without M7', () => {
		it(`Train's load renders with and without the findings, and prints the time they add`, async () => {
			for (let i = 0; i < WARM_UPS; i++) {
				await time({});
				await time(false);
			}
			const on: number[] = [];
			const off: number[] = [];
			for (let i = 0; i < RUNS; i++) {
				on.push(await time({}));
				off.push(await time(false));
			}
			const [withFindings, without] = [median(on), median(off)];
			const added = withFindings - without;
			const verdict = added <= TRAIN_TARGET_MS ? 'within' : 'over';
			console.log(
				`\nTrain's load, median of ${RUNS}: ${withFindings.toFixed(1)} ms with the findings, ${without.toFixed(1)} ms without: ${added >= 0 ? '+' : ''}${added.toFixed(1)} ms (${verdict} the +${TRAIN_TARGET_MS} ms target; not gated)`
			);
			expect(on).toHaveLength(RUNS);
		}, 60_000);
	});
}
