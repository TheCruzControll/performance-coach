/**
 * The CI e2e legs (scripts/ci-legs.ts): each leg's shape and shards, the journeys' file filter,
 * the legs each event runs, and what scripts/ci-scope.ts writes for them (.github/workflows/ci.yml).
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHROMIUM_LEGS, type Leg, JOURNEYS_CHROMIUM, JOURNEYS_WEBKIT, legsFor } from './ci-legs.ts';
import { CEILING_MINUTES } from './e2e-timing.ts';

const legKey = (leg: Leg) => `${leg.group}/${leg.engine}`;
/** The spec files directly under e2e/, where the journeys live. */
const specs = readdirSync(new URL('../e2e/', import.meta.url));

describe('CHROMIUM_LEGS', () => {
	it('holds whole, well-formed entries of the Chromium groups CI tests', () => {
		for (const leg of CHROMIUM_LEGS) {
			expect(leg.engine, JSON.stringify(leg)).toBe('chromium');
			// `alone` (perf) is absent by the owner's decision: performance is not tested in CI.
			expect(['main', 'serial', 'exclusive'], JSON.stringify(leg)).toContain(leg.group);
			expect(leg.only, JSON.stringify(leg)).toBeUndefined();
			for (const key of ['shard', 'of', 'minutes'] as const) {
				expect(Number.isInteger(leg[key]), `${key} in ${JSON.stringify(leg)}`).toBe(true);
				expect(leg[key], `${key} in ${JSON.stringify(leg)}`).toBeGreaterThanOrEqual(1);
			}
			expect(leg.shard, JSON.stringify(leg)).toBeLessThanOrEqual(leg.of);
		}
	});

	it('bounds each entry by its minutes, within the ceiling and at least 5', () => {
		for (const leg of CHROMIUM_LEGS) {
			expect(leg.minutes, JSON.stringify(leg)).toBeLessThanOrEqual(
				Math.ceil(1.5 * CEILING_MINUTES)
			);
			expect(leg.minutes, JSON.stringify(leg)).toBeGreaterThanOrEqual(5);
		}
	});

	it('has contiguous shards within each group and engine', () => {
		const legs = new Map<string, Leg[]>();
		for (const leg of CHROMIUM_LEGS) legs.set(legKey(leg), [...(legs.get(legKey(leg)) ?? []), leg]);
		for (const [key, shards] of legs) {
			const of = shards[0]!.of;
			expect(
				shards.map((s) => s.of),
				key
			).toEqual(shards.map(() => of));
			expect(
				shards.map((s) => s.shard).sort((a, b) => a - b),
				key
			).toEqual(Array.from({ length: of }, (_, i) => i + 1));
		}
	});
});

describe('the PRD journeys', () => {
	it.each([
		['chromium', JOURNEYS_CHROMIUM],
		['webkit', JOURNEYS_WEBKIT]
	])('on %s: one unsharded serial leg filtered to the journey specs', (engine, leg) => {
		expect(leg).toEqual({
			group: 'serial',
			engine,
			shard: 1,
			of: 1,
			minutes: 15,
			only: 'e2e/journey-'
		});
		// Playwright matches a file filter as a substring of the spec's path.
		expect(specs.filter((file) => `e2e/${file}`.includes(leg.only!)).length).toBeGreaterThan(0);
	});
});

describe('legsFor', () => {
	it('runs every Chromium leg and the journeys on WebKit on a scheduled or manual run', () => {
		expect(legsFor('schedule')).toEqual([...CHROMIUM_LEGS, JOURNEYS_WEBKIT]);
		expect(legsFor('workflow_dispatch')).toEqual([...CHROMIUM_LEGS, JOURNEYS_WEBKIT]);
		expect(legsFor('schedule').filter((leg) => leg.engine === 'webkit')).toEqual([JOURNEYS_WEBKIT]);
	});

	it('runs only the journeys on Chromium on a pull request or a push', () => {
		expect(legsFor('pull_request')).toEqual([JOURNEYS_CHROMIUM]);
		expect(legsFor('push')).toEqual([JOURNEYS_CHROMIUM]);
	});
});

describe('scripts/ci-scope.ts legs output', () => {
	it('writes the scope and the legs of a manual run, one line each', () => {
		const script = fileURLToPath(new URL('./ci-scope.ts', import.meta.url));
		const result = spawnSync(process.execPath, [script], {
			encoding: 'utf8',
			env: { ...process.env, EVENT_NAME: 'workflow_dispatch' }
		});
		expect(result.status, result.stderr).toBe(0);
		const legs = JSON.stringify({ include: [...CHROMIUM_LEGS, JOURNEYS_WEBKIT] });
		expect(result.stdout.split('\n')).toEqual(['scope=full', `legs=${legs}`, '']);
	});
});
