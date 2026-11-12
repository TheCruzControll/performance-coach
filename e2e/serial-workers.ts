/**
 * Playwright workers of a serial CI leg (E2E_GROUP=serial), per engine: the one place they are
 * set. Each worker runs in an owner world of its own, a database and a production server
 * (e2e/worlds.ts), and the shard planner divides a leg's seconds by the same number
 * (scripts/e2e-shards.ts legWorkers).
 *
 * Measured on the runner's 4 vCPUs, two workers against one (run 43172816565):
 * - Chromium: a serial spec file took 1.15× its 1-worker time, so 2 workers nearly halve a leg's
 *   wall clock (serial·chromium went from 3 shards to 2).
 * - WebKit: a serial spec file took 1.39× its 1-worker time, and the heaviest tests went past
 *   their 30 s timeout, attempt and retry: workout-run.serial.e2e.ts:116 (run 43178306850) and
 *   adjust-skip.serial.e2e.ts:302's axe test (~31.6 s), each ~13 s on 1 worker. So WebKit keeps
 *   1 worker and buys its wall clock with shards instead (.github/workflows/ci.yml).
 *
 * No imports: CI runs the planner with Node alone, before anything is built.
 */
export const SERIAL_WORKERS = { chromium: 2, webkit: 1 } as const;

/** A serial CI leg's workers for E2E_ENGINE `engine`; 1 when it names no engine. */
export function serialWorkers(engine: string | undefined): number {
	return engine === 'chromium' || engine === 'webkit' ? SERIAL_WORKERS[engine] : 1;
}
