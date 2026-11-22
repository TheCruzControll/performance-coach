/**
 * The Playwright runs of CI's e2e job (.github/workflows/ci.yml, job `e2e-legs`), one job each.
 * legsFor picks them by event: a pull request or a push runs the PRD journeys on Chromium
 * (JOURNEYS_CHROMIUM). A scheduled or manual run runs every Chromium leg (CHROMIUM_LEGS) and the
 * journeys on WebKit (JOURNEYS_WEBKIT), the only WebKit run in CI.
 *
 * Performance is not tested in CI, by the owner's decision: the `alone` group (perf-*.e2e.ts) and
 * Lighthouse run locally only (`E2E_GROUP=alone pnpm test:e2e`, `pnpm lighthouse`).
 *
 * No imports, so CI runs it before `pnpm install`.
 */

export interface Leg {
	group: 'main' | 'serial' | 'alone' | 'exclusive';
	engine: 'chromium' | 'webkit';
	shard: number;
	of: number;
	/** The Playwright step's timeout. */
	minutes: number;
	/** A Playwright file filter: when set, the job runs only these specs, unsharded. */
	only?: string;
}

/**
 * The Chromium legs a scheduled or manual run tests, one entry per shard: every Chromium group
 * but `alone`. A leg's `minutes` is its Playwright step's timeout: 1.5 × the leg's slowest measured
 * run, at least 5 (scripts/e2e-timing.ts warns above the 15-minute ceiling). A leg nearing the
 * ceiling gains a shard (`of` up by one, plus an entry per new shard), never less coverage. Every
 * shard holds whole files, planned by measured seconds, or estimated ones for spec files the timing
 * table lacks (scripts/e2e-shards.ts).
 *
 * Shard counts: main 3 (its a11y files fill shard 1 by themselves, so they cannot share a shard);
 * serial 3 (each serial leg runs one worker per owner world, e2e/serial-workers.ts: 2 on
 * Chromium); exclusive 1, its own leg because a shard holding it would run every perf test first
 * (the exclusive project depends on the functional projects).
 */
export const CHROMIUM_LEGS: readonly Leg[] = [
	{ group: 'main', engine: 'chromium', shard: 1, of: 3, minutes: 17 },
	{ group: 'main', engine: 'chromium', shard: 2, of: 3, minutes: 17 },
	{ group: 'main', engine: 'chromium', shard: 3, of: 3, minutes: 17 },
	{ group: 'serial', engine: 'chromium', shard: 1, of: 3, minutes: 14 },
	{ group: 'serial', engine: 'chromium', shard: 2, of: 3, minutes: 14 },
	{ group: 'serial', engine: 'chromium', shard: 3, of: 3, minutes: 14 },
	{ group: 'exclusive', engine: 'chromium', shard: 1, of: 1, minutes: 5 }
];

/** The PRD journeys (e2e/journey-*.serial.e2e.ts) on Chromium: the run a pull request or a push gets. */
export const JOURNEYS_CHROMIUM: Leg = {
	group: 'serial',
	engine: 'chromium',
	shard: 1,
	of: 1,
	minutes: 15,
	only: 'e2e/journey-'
};

/** The PRD journeys on WebKit: the iPhone's engine on its main paths, in a scheduled or manual run. */
export const JOURNEYS_WEBKIT: Leg = {
	group: 'serial',
	engine: 'webkit',
	shard: 1,
	of: 1,
	minutes: 15,
	only: 'e2e/journey-'
};

/**
 * The legs a run of this event tests. A scheduled or manual run tests every Chromium leg and the
 * journeys on WebKit; every other event (pull requests and pushes) runs the journeys on Chromium.
 *
 * Artifact names (`playwright-<run>-<group>-<engine>-<shard>`) stay unique within each run: the
 * journeys jobs and serial·chromium shard 1 never run in the same run (a pull request runs only the
 * journeys, a scheduled run runs serial·chromium and the WebKit journeys), so no two of a run's
 * legs share a name.
 */
export function legsFor(event: string): Leg[] {
	return event === 'schedule' || event === 'workflow_dispatch'
		? [...CHROMIUM_LEGS, JOURNEYS_WEBKIT]
		: [JOURNEYS_CHROMIUM];
}
