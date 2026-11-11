/**
 * Profile's start-route vitals (profile-vitals.e2e.ts, profile-vitals.desktop.e2e.ts): post a
 * launch of Today the way the app beacons it, then check the card. Other specs' page loads add
 * their own samples, so values are checked for shape, not for an exact number (the integration
 * test tests/integration/vitals.test.ts pins those).
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

export async function expectStartVitals(page: Page) {
	const start = page.getByTestId('start-vitals');
	await expect(start.getByRole('heading', { level: 3, name: /Opening the app/ })).toBeVisible();
	for (const name of ['TTFB', 'LCP', 'INP']) {
		const stat = start.getByTestId(`start-vital-${name}`);
		await expect(stat, name).toContainText(new RegExp(`${name}\\s*\\d+\\s*ms`));
		await expect(stat, name).toContainText(/\d+ samples?/);
	}
	// CLS and FCP stay in the all-screens list only.
	await expect(start.getByTestId('start-vital-CLS')).toHaveCount(0);
	await expect(start.getByTestId('start-vital-FCP')).toHaveCount(0);
	await expect(page.getByTestId('vital-CLS')).toBeVisible();
	return start;
}

export async function expectStartVitalsAxeClean(page: Page) {
	for (const theme of THEMES) {
		await page.evaluate((t) => {
			if (t === 'dark') delete document.documentElement.dataset.theme;
			else document.documentElement.dataset.theme = t;
		}, theme);
		await page.waitForTimeout(250); // colour transitions
		const { violations } = await new AxeBuilder({ page })
			.include('[data-testid="start-vitals"]')
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();
		expect(violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))).toEqual(
			[]
		);
	}
}
