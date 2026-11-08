/**
 * The one registry of chart bodies: the code that draws a chart, loaded only in the browser,
 * after hydration, by ChartFrame. Each later chart adds one entry, guarded so the server build
 * never reaches the body; while the server can reach a component, SvelteKit links its CSS into the
 * page as render-blocking:
 *
 *   line: () => (import.meta.env.SSR ? never() : import('./bodies/LineChart.svelte')),
 *
 * Files under ./bodies/ are imported only from here, only through import(), and only behind that
 * guard (scripts/chart-body-imports.test.ts). The frame, its title, summary and table are
 * server-rendered; only the plot waits for its body.
 */
import type { Component } from 'svelte';

/** Loads a chart body: a component drawing into the plot box ChartFrame reserves. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any body's props
export type ChartBodyLoader<P extends Record<string, any> = any> = () => Promise<{
	default: Component<P>;
}>;

/** What the server gets instead of a body: a promise that never settles, so nothing loads. */
export const never = () => new Promise<never>(() => {});

export const CHART_BODIES = {
	line: () => (import.meta.env.SSR ? never() : import('./bodies/LineChart.svelte'))
} as const satisfies Record<string, ChartBodyLoader>;

export type ChartBodyName = keyof typeof CHART_BODIES;
