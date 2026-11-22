/**
 * Every main screen in a desktop window (docs/design-system.md, Responsive layout): each one
 * loads without moving, scrolls nothing sideways, sits beside the rail inside the shell or
 * centred in the window outside it, logs no console error, and leaves a screenshot under
 * test-results/screens/<project>/ for review (dark, and light for Today and sign-in). Layout
 * details of each screen belong to its own desktop spec; this is the sweep that misses none.
 */
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import {
	DESKTOP,
	boxOf,
	expectMainCentred,
	expectNoShift,
	expectNoSideScroll,
	layoutWidth
} from './desktop';
import { captureScreen, signedOut, trackConsoleErrors } from './support';

test.use(DESKTOP);

type Theme = 'dark' | 'light';

interface Screen {
	/** The screenshot's file name. */
	name: string;
	path: string;
	heading: string | RegExp;
	/** The heading's level, when the screen's title is not an h1 (an error page's is an h2). */
	level?: 1 | 2;
	/** The document's HTTP status, when it is not 200: a 404 page's own load is not an error. */
	status?: 404;
	/** Inside the app shell (beside the rail) or outside it (centred in the window). */
	shell: boolean;
	/** Also shot in the light theme. */
	light?: boolean;
}

const SIGNED_OUT: Screen[] = [
	{ name: 'sign-in', path: '/', heading: /train with intent/i, shell: false, light: true },
	{ name: 'recover', path: '/recover', heading: 'Lost your passkey?', shell: false }
];

const SIGNED_IN: Screen[] = [
	{ name: 'today', path: '/today', heading: 'Today', shell: true, light: true },
	{ name: 'train', path: '/train', heading: 'Train', shell: true },
	{ name: 'progress', path: '/progress', heading: 'Progress', shell: true },
	{ name: 'coach', path: '/coach', heading: 'Coach', shell: true },
	{ name: 'profile', path: '/profile', heading: 'Profile', shell: true },
	{ name: 'profile-equipment', path: '/profile/equipment', heading: 'Equipment', shell: true },
	{ name: 'profile-security', path: '/profile/security', heading: 'Security', shell: true },
	{ name: 'design', path: '/design', heading: 'Design system', shell: false },
	{ name: 'offline', path: '/offline', heading: /offline/i, shell: true },
	{
		name: 'not-found-in-shell',
		path: '/today/unknown',
		heading: 'Nothing here',
		level: 2,
		status: 404,
		shell: true
	},
	{
		name: 'not-found',
		path: '/nothing-here',
		heading: 'Nothing here',
		level: 2,
		status: 404,
		shell: false
	}
];

/** The design gallery's component groups, by their tab's label. */
const DESIGN_TABS = ['Buttons', 'Inputs', 'Data', 'Feedback', 'Plan'] as const;

const railOf = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
const mainOf = (page: Page) => page.locator('main#main');

/** The screen's first block under its header: main's first section, or its first child. */
async function firstSectionOf(page: Page): Promise<Locator> {
	const section = mainOf(page).locator('section').first();
	if (await section.count()) return section;
	return mainOf(page).locator('> *').first();
}

/**
 * Open a screen in a theme, checking that nothing moves while it loads: from the first server-
 * rendered paint (the title shown) until the page has loaded, its fonts have settled and its code
 * has hydrated, the title and main's first section keep their boxes (and on Chromium the
 * layout-shift entries stay at most 0.01).
 */
async function openWithoutShift(page: Page, screen: Screen, theme: Theme) {
	await page.addInitScript(
		(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
		theme
	);
	const response = await page.goto(screen.path, { waitUntil: 'commit' });
	expect(response?.status(), `${screen.path} answers`).toBe(screen.status ?? 200);
	const heading = page.getByRole('heading', { level: screen.level ?? 1, name: screen.heading });
	await expect(heading).toBeVisible();
	await expectNoShift(page, {
		action: () => page.waitForLoadState('load'),
		boxes: [heading, await firstSectionOf(page)]
	});
	if (theme === 'light') await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
}

/** Outside the shell: no rail, and the screen's content is centred in the window. */
async function expectCentredInWindow(page: Page) {
	await expect(railOf(page)).toHaveCount(0);
	const errorView = page.getByTestId('error-view');
	const content = (await errorView.count()) ? errorView : mainOf(page);
	const box = await boxOf(content);
	const off = box.x + box.width / 2 - (await layoutWidth(page)) / 2;
	expect(Math.abs(off), `${content} is ${off.toFixed(1)}px off the window's centre`).toBeLessThan(
		1.5
	);
}

async function checkScreen(page: Page, testInfo: TestInfo, screen: Screen, theme: Theme) {
	// Chromium logs a document that answers 404 as a failed resource: only that one line is
	// expected, and only on a screen that is meant to be a 404.
	const errors = trackConsoleErrors(
		page,
		(msg) =>
			screen.status === 404 &&
			msg.text().includes('status of 404') &&
			new URL(msg.location().url).pathname === screen.path
	);
	await openWithoutShift(page, screen, theme);
	await expectNoSideScroll(page);
	if (screen.shell) await expectMainCentred(page);
	else await expectCentredInWindow(page);
	await captureScreen(page, testInfo, `screen-${screen.name}${theme === 'light' ? '-light' : ''}`);
	expect(errors).toEqual([]);
}

/** Each screen in dark, and the ones with `light` in the light theme too. */
const cases = (screens: Screen[]) =>
	screens.flatMap((screen) =>
		(screen.light ? (['dark', 'light'] as const) : (['dark'] as const)).map(
			(theme) => [screen, theme] as const
		)
	);

test.describe('signed out', () => {
	test.use({ storageState: signedOut });
	for (const [screen, theme] of cases(SIGNED_OUT)) {
		test(`${screen.path} (${theme})`, async ({ page }, testInfo) => {
			await checkScreen(page, testInfo, screen, theme);
		});
	}
});

test.describe('signed in', () => {
	for (const [screen, theme] of cases(SIGNED_IN)) {
		test(`${screen.path} (${theme})`, async ({ page }, testInfo) => {
			await checkScreen(page, testInfo, screen, theme);
		});
	}

	test('a missing page in the shell lines its state up with its title, not centred under it', async ({
		page
	}) => {
		const response = await page.goto('/today/unknown');
		expect(response?.status()).toBe(404);
		const title = await boxOf(page.getByRole('heading', { level: 1, name: 'Not found' }));
		const view = page.getByTestId('error-view');
		for (const part of [
			view.getByRole('heading', { level: 2, name: 'Nothing here' }),
			view.getByText('This page does not exist.'),
			view.getByRole('link', { name: 'Back to Today' })
		]) {
			const box = await boxOf(part);
			expect(Math.abs(box.x - title.x), `${part} starts where the title does`).toBeLessThanOrEqual(
				1
			);
		}
	});

	test('/design, every component group', async ({ page }, testInfo) => {
		const errors = trackConsoleErrors(page);
		await page.goto('/design');
		await page.waitForLoadState('networkidle');
		const tabs = page.getByRole('tablist', { name: 'Component group' });
		for (const label of DESIGN_TABS) {
			const tab = tabs.getByRole('tab', { name: label });
			await tab.click();
			await expect(tab).toHaveAttribute('aria-selected', 'true');
			const panel = page.getByRole('tabpanel', { name: label });
			await expect(panel).toBeVisible();
			// A group's code loads when its tab opens: wait for it, not its placeholder.
			await expect(panel.locator('div.grid[aria-busy="true"]')).toHaveCount(0);
			await expectNoSideScroll(page);
			await captureScreen(page, testInfo, `screen-design-${label.toLowerCase()}`);
		}
		expect(errors).toEqual([]);
	});
});
