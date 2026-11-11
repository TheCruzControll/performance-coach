/**
 * Train's page data, gated against the bytes committed before M7 changed it
 * (scripts/explain/baselines/train-m7.json; m7-plan, 'SCREENS AND BUDGETS').
 *
 * Train's load (week.server.ts) runs on real Postgres for the periodisation-week fixture on its
 * pinned clock, for the owner's current week and for the owner-move week, and the result is
 * gzipped as JSON. That is a proxy for /train/__data.json (m7-plan named an e2e gate on it): it
 * leaves out devalue's encoding and whatever +page.server.ts or the layout add, so a Train slice
 * that puts data outside loadTrainWeek measures it here or in its own gate. The baseline was
 * measured on main's code with this fixture, so each M7 Train slice may grow it only by the rows
 * of ALLOWANCES it has turned on. Ids and timestamps differ run to run, so a measure is compared
 * within TOLERANCE_B. No time is measured: a time on one machine is noise on another.
 */
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import { FIXTURE_WEEKS } from '../../../src/lib/server/test-support/analytics-fixtures/periodisation-week';
import { loadTrainWeek } from '../../../src/routes/(app)/train/week.server';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

interface Baseline {
	commit: string;
	clock: string;
	timeZone: string;
	/** gzip bytes of Train's page data, by fixture week. */
	bytes: Record<'current' | 'moved', number>;
}

const baseline = JSON.parse(
	readFileSync('scripts/explain/baselines/train-m7.json', 'utf8')
) as Baseline;

/**
 * What each M7 Train slice may add, in KB of gzip (m7-plan; 3.0 KB in all). A slice turns on its
 * own row in ON when it lands.
 */
const ALLOWANCES = {
	findings: 0.6,
	why: 1.5,
	weekKinds: 0.1,
	timeline: 0.7,
	replanNote: 0.1
} as const;
const ON: readonly (keyof typeof ALLOWANCES)[] = ['findings'];
/** Random ids and the store's timestamps move a measure by a few bytes either way. */
const TOLERANCE_B = 64;

const WEEKS = { current: null, moved: String(FIXTURE_WEEKS.moved) } as const;

describe('Train’s page data', () => {
	it.each(Object.keys(WEEKS) as (keyof typeof WEEKS)[])(
		'the %s week grows only by the allowances turned on',
		async (name) => {
			await withRollback(async (db) => {
				const owner = await makeOwner(db);
				const now = new Date(baseline.clock);
				await seedAnalyticsFixture(
					owner,
					'periodisation-week',
					{ timeZone: baseline.timeZone, now },
					{ db }
				);
				const origin = {
					...{ requestId: crypto.randomUUID(), method: 'GET', path: '/train' },
					...{ routeId: '/(app)/train', appVersion: '0.1.0+test' }
				};
				const data = await loadTrainWeek(owner, { now, week: WEEKS[name], origin }, { db });
				expect(data.state).toBe('program');
				const bytes = gzipSync(JSON.stringify(data)).length;
				const allowed = ON.reduce((sum, row) => sum + ALLOWANCES[row] * 1024, 0);
				const growth = bytes - baseline.bytes[name];
				console.log(
					`Train page data, ${name} week: ${bytes} B gzip (${growth >= 0 ? '+' : ''}${growth} B on ${baseline.bytes[name]} B, allowed +${Math.round(allowed)} B)`
				);
				expect(growth).toBeLessThanOrEqual(allowed + TOLERANCE_B);
			});
		}
	);
});
