/**
 * Launch timing for the perf specs (perf-launch.e2e.ts, perf-journey.e2e.ts) and WebKit's marks
 * (launch-webkit.e2e.ts): when a workout page became usable, and the app's own marks.
 */
import type { Page } from '@playwright/test';

/** The page is usable: Complete set shown and enabled, with the store open (Shell's data-store). */
export const USABLE = 'main#main[data-store] [data-testid="complete-set"]';

/**
 * When the logger first showed Complete set enabled with the store open: `at` from the document's
 * navigation start, `epoch` on the clock every document of the origin shares.
 */
export const usableAt = (page: Page, timeout = 15_000) =>
	page
		.waitForFunction(
			(selector) => {
				const button = document.querySelector<HTMLButtonElement>(selector);
				if (!button || button.disabled || button.getClientRects().length === 0) return false;
				const at = performance.now();
				return { at, epoch: performance.timeOrigin + at };
			},
			USABLE,
			{ polling: 'raf', timeout }
		)
		.then((handle) => handle.jsonValue() as Promise<{ at: number; epoch: number }>);

/** A performance mark's time from navigation start, or null when the page set none. */
export const markAt = (page: Page, name: string) =>
	page.evaluate((mark) => performance.getEntriesByName(mark, 'mark')[0]?.startTime ?? null, name);

/** A time in whole ms, or 'none'. */
export const ms = (value: number | null) => (value === null ? 'none' : String(Math.round(value)));
