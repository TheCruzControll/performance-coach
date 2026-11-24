/**
 * Profile → About this app → Speed (profile-vitals.e2e.ts, profile-vitals.desktop.e2e.ts): post a
 * launch of Today the way the app beacons it, then check the three questions and the launches
 * under them. Other specs' page loads add their own samples, so values are checked for shape, not
 * for an exact number (the integration test tests/integration/vitals.test.ts pins those).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { SAME_ORIGIN } from './support';

const THEMES = ['dark', 'light'] as const;

/** One launch of Today as the app reports it, plus a CLS there (not a start metric). */
export async function postStartVitals(page: Page) {
	const run = `${test.info().project.name}-${Date.now()}`;
	const on = { path: '/today', route: '/(app)/today', rating: 'good', navigationType: 'navigate' };
	const res = await page.request.post('/api/vitals', {
		headers: SAME_ORIGIN,
		data: [
			{ ...on, id: `start-ttfb-${run}`, name: 'TTFB', value: 412 },
			{ ...on, id: `start-lcp-${run}`, name: 'LCP', value: 1180 },
			{ ...on, id: `start-inp-${run}`, name: 'INP', value: 64 },
			{ ...on, id: `start-cls-${run}`, name: 'CLS', value: 0.01 }
		]
	});
	expect(res.status()).toBe(204);
}

/** On Speed: each question answered in words, and the launches the numbers come from. */
export async function expectStartVitals(page: Page) {
	await expect(page.getByRole('heading', { level: 1, name: 'Speed' })).toBeVisible();
	await expect(page.getByTestId('speed-open')).toHaveText(
		/^Opening the app\s*\d+(\.\d)? (s|ms), (good|needs work|poor)$/
	);
	await expect(page.getByTestId('speed-tap')).toHaveText(
		/^Answering a tap\s*\d+(\.\d)? (s|ms), (good|needs work|poor)$/
	);
	await expect(page.getByTestId('speed-stable')).toHaveText(
		/Things staying put\s*(Good|Needs work|Poor)/
	);
	// The launch just posted is on the start route: the count is of launches, not visits.
	await expect(page.getByTestId('speed-note')).toHaveText(/^From \d+ launch(es)?\.$/);
}

export async function expectStartVitalsAxeClean(page: Page) {
	for (const theme of THEMES) {
		await page.evaluate((t) => {
			if (t === 'dark') delete document.documentElement.dataset.theme;
			else document.documentElement.dataset.theme = t;
		}, theme);
		await page.waitForTimeout(250); // colour transitions
		const { violations } = await new AxeBuilder({ page })
			.include('main')
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();
		expect(violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))).toEqual(
			[]
		);
	}
}
