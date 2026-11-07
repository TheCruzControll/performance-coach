/**
 * Swapping an exercise (src/routes/(app)/train/session/[key], EditSheetHost and SwapSheet): each
 * exercise of a session that can still change has Swap, which opens a code-split sheet with the
 * alternatives the screen streamed, each with why it fits. Without 'Never prescribe … again' the
 * swap is this session only, saves no preference and says so on the exercise; with it, a dislike
 * (source 'swap') is saved, Profile → Exercises lists it, and every later session swaps too.
 * With bodyweight only, the power clean has nothing that fits: the sheet says why, links to
 * Profile → Equipment, and nothing can be saved. Save is busy while it posts; Close and Escape
 * return focus to the exercise's Swap.
 *
 * The program is seeded next week (PROGRAM_TZ), so every one of its days is ahead on any weekday.
 * Serial: programs and the profile are the one owner's (e2e/program-support.ts).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { DESKTOP, expectNoSideScroll } from './desktop';
import { PROGRAM_TZ, seedProgram, type SeededProgram, type SeededSession } from './program-support';
import {
	captureScreen,
	gotoHydrated,
	profileAction,
	query,
	resetTrainingProfile,
	toastWith,
	trackConsoleErrors
} from './support';

test.use({ timezoneId: PROGRAM_TZ });

test.beforeEach(async () => {
	await resetTrainingProfile();
});

const sheet = (page: Page) => page.getByRole('dialog', { name: 'Swap exercise' });
const save = (page: Page) => sheet(page).getByTestId('edit-save');
const swapButton = (page: Page, name: string) =>
	page.getByRole('button', { name: `Swap ${name}`, exact: true });
const exercise = (page: Page, name: string) =>
	page.getByTestId('exercise').filter({ has: page.getByRole('heading', { name, exact: true }) });
const alternatives = (page: Page) => sheet(page).getByRole('radio');
const never = (page: Page) => sheet(page).getByRole('switch', { name: /^Never prescribe/ });

/** Open Swap on `name` and wait for its alternatives. */
async function openSwap(page: Page, name: string) {
	await swapButton(page, name).click();
	await expect(alternatives(page).first()).toBeVisible();
}

/** The first alternative's name, as its card is labelled (its name, then why it fits). */
async function firstAlternative(page: Page): Promise<string> {
	const label = await alternatives(page)
		.first()
		.evaluate((el) => {
			const card = el.closest('label');
			return card?.querySelector('.label')?.textContent?.trim() ?? '';
		});
	expect(label).not.toBe('');
	return label;
}

function preferences() {
	return query<{ exercise: string; sentiment: string; source: string; reason: string | null }>(
		'select exercise, sentiment, source, reason from exercise_preferences order by exercise'
	);
}

/** Each version's exercise names in a session, oldest first. */
function exercisesIn(lineage: string) {
	return query<{ number: number; names: string[] }>(
		`select v.number, array_agg(x.name order by pe.position) as names
		   from planned_sessions s
		   join program_version_weeks vw on vw.week_id = s.week_id
		   join program_versions v on v.id = vw.version_id
		   join planned_exercises pe on pe.session_id = s.id
		   join exercises x on x.id = pe.exercise_id
		  where s.lineage_id = $1
		  group by v.number
		  order by v.number`,
		[lineage]
	);
}

/** axe with the Swap sheet open, in the dark and the light theme. */
async function auditThemes(page: Page, open: () => Promise<void>) {
	for (const theme of ['dark', 'light'] as const) {
		await page.evaluate(
			(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
			theme
		);
		await page.reload();
		await page.waitForLoadState('networkidle');
		await open();
		await page.evaluate(() => document.fonts.ready);
		await page.waitForTimeout(500); // the sheet's rise settles
		const { violations } = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();
		const found = violations.flatMap((v) =>
			v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${n.failureSummary}`)
		);
		expect(found, `axe, ${theme}`).toEqual([]);
	}
}

test.describe('a program that starts next week', () => {
	let seeded: SeededProgram;
	const fullBody = (week: number): SeededSession =>
		seeded.sessions.filter((s) => s.title === 'Full body')[week]!;
	const open = (session: SeededSession) => `/train/session/${session.lineage}`;

	test.beforeEach(async ({ request }) => {
		seeded = await seedProgram(request, { fixture: 'hybrid', start: 'next_week' });
	});

	test('a swap for this session only changes that session, says so, and saves no preference', async ({
		page
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		await gotoHydrated(page, open(fullBody(0)));
		await openSwap(page, 'Back squat');
		await expect(sheet(page)).toContainText('Back squat');
		await expect(sheet(page).getByRole('group', { name: 'Swap back squat for' })).toBeVisible();
		// Each alternative says why it fits; the best first.
		await expect(alternatives(page).first()).toHaveAccessibleName(
			/Does the same job as back squat/
		);
		await expect(never(page)).not.toBeChecked();
		await expect(sheet(page)).toContainText('Off: this session only');
		await expect(save(page)).toHaveText('Swap');

		const chosen = await firstAlternative(page);
		await alternatives(page).first().check();
		await captureScreen(page, testInfo, 'session-swap');
		await save(page).click();

		await expect(
			toastWith(page, `Swapped for ${chosen}, this session only · version 2`)
		).toBeVisible();
		await expect(sheet(page)).toBeHidden();
		await expect(exercise(page, chosen).getByTestId('exercise-swapped')).toHaveText(
			'This session only'
		);
		await expect(exercise(page, 'Back squat')).toHaveCount(0);
		expect(await preferences()).toEqual([]);
		// Version 1 keeps the back squat; next week's session was never copied.
		const [v1, v2] = await exercisesIn(fullBody(0).lineage);
		expect(v1!.names).toContain('Back squat');
		expect(v2!.names).toContain(chosen);
		expect((await exercisesIn(fullBody(1).lineage)).at(-1)!.names).toContain('Back squat');

		await gotoHydrated(page, open(fullBody(1)));
		await expect(exercise(page, 'Back squat')).toHaveCount(1);
		// A reload keeps the swap.
		await gotoHydrated(page, open(fullBody(0)));
		await expect(exercise(page, chosen).getByTestId('exercise-swapped')).toBeVisible();
		expect(errors).toEqual([]);
	});

	test('never again saves a dislike from the swap and swaps every later session; Profile lists it', async ({
		page
	}) => {
		await gotoHydrated(page, open(fullBody(0)));
		await openSwap(page, 'Back squat');
		const chosen = await firstAlternative(page);
		await alternatives(page).first().check();
		await never(page).check();
		await expect(sheet(page)).toContainText(
			'Saved as a dislike in Profile → Exercises, and swapped in every session from today.'
		);
		await sheet(page)
			.getByLabel(/^Reason/)
			.fill('It never feels right');
		await save(page).click();
		await expect(toastWith(page, `Swapped for ${chosen}, from now on · version 2`)).toBeVisible();

		expect(await preferences()).toEqual([
			{
				exercise: 'Back squat',
				sentiment: 'dislike',
				source: 'swap',
				reason: 'It never feels right'
			}
		]);
		await expect(exercise(page, chosen)).toHaveCount(1);
		await expect(exercise(page, chosen).getByTestId('exercise-swapped')).toHaveCount(0);
		for (const week of [0, 1]) {
			await gotoHydrated(page, open(fullBody(week)));
			await expect(exercise(page, chosen)).toHaveCount(1);
			await expect(exercise(page, 'Back squat')).toHaveCount(0);
		}
		await gotoHydrated(page, '/profile/exercises');
		await expect(page.getByTestId('dislikes')).toContainText('Back squat');
	});

	test('with bodyweight only nothing fits the power clean: why, Profile → Equipment, and no Save', async ({
		page,
		request
	}, testInfo) => {
		await profileAction(request, '/profile/equipment?/save', {
			gymType: 'none',
			equipment: [],
			homeEquipment: [],
			notes: null
		});
		await gotoHydrated(page, open(fullBody(0)));
		await swapButton(page, 'Power clean').click();
		const empty = sheet(page).getByTestId('swap-empty');
		await expect(empty).toContainText('Nothing fits your equipment and injuries');
		await expect(empty.getByTestId('swap-blocked')).toContainText(/Needs a barbell/);
		await expect(save(page)).toHaveCount(0);
		await expect(alternatives(page)).toHaveCount(0);
		await captureScreen(page, testInfo, 'session-swap-empty');

		await empty.getByTestId('swap-equipment').click();
		await expect(page).toHaveURL('/profile/equipment');
		expect(await exercisesIn(fullBody(0).lineage)).toHaveLength(1);
	});

	test('Close and Escape return focus to the exercise’s Swap', async ({ page }) => {
		await gotoHydrated(page, open(fullBody(0)));
		await openSwap(page, 'Bench press');
		await sheet(page).getByRole('button', { name: 'Close' }).click();
		await expect(sheet(page)).toBeHidden();
		await expect(swapButton(page, 'Bench press')).toBeFocused();

		await openSwap(page, 'Barbell row');
		await page.keyboard.press('Escape');
		await expect(sheet(page)).toBeHidden();
		await expect(swapButton(page, 'Barbell row')).toBeFocused();
		expect(await exercisesIn(fullBody(0).lineage)).toHaveLength(1);
	});

	test('the sheet passes axe in dark and light, its empty state too', async ({ page, request }) => {
		await gotoHydrated(page, open(fullBody(0)));
		await auditThemes(page, async () => {
			await openSwap(page, 'Back squat');
			await alternatives(page).first().check();
			await never(page).check();
		});
		await profileAction(request, '/profile/equipment?/save', {
			gymType: 'none',
			equipment: [],
			homeEquipment: [],
			notes: null
		});
		await auditThemes(page, async () => {
			await swapButton(page, 'Power clean').click();
			await expect(sheet(page).getByTestId('swap-empty')).toBeVisible();
		});
	});

	test.describe('with the network in the test’s hands', () => {
		// page.route never sees a request from a page the service worker controls on WebKit.
		test.use({ serviceWorkers: 'block' });

		test('Save is busy while the swap posts, and a second tap posts nothing', async ({ page }) => {
			await gotoHydrated(page, open(fullBody(0)));
			await openSwap(page, 'Back squat');
			await alternatives(page).first().check();

			let posts = 0;
			let release!: () => void;
			const held = new Promise<void>((resolve) => (release = resolve));
			await page.route(
				(url) => url.search === '?/swap',
				async (route) => {
					posts += 1;
					await held;
					await route.continue();
				}
			);
			await save(page).click();
			await expect(save(page)).toHaveAttribute('aria-busy', 'true');
			await expect(save(page)).toBeDisabled();
			await save(page).click({ force: true });
			release();
			await expect(toastWith(page, /this session only · version 2/)).toBeVisible();
			await page.unrouteAll({ behavior: 'ignoreErrors' });
			expect(posts).toBe(1);
			expect(await exercisesIn(fullBody(0).lineage)).toHaveLength(2);
		});
	});

	test.describe('on a desktop window', () => {
		test.use(DESKTOP);

		test('Swap has hover and focus states, and its sheet opens with nothing scrolling sideways', async ({
			page
		}, testInfo) => {
			await gotoHydrated(page, open(fullBody(0)));
			const swap = swapButton(page, 'Back squat');
			const background = () => swap.evaluate((el) => getComputedStyle(el).backgroundColor);
			const resting = await background();
			await swap.hover();
			await expect.poll(background).not.toBe(resting);
			await page.mouse.move(720, 880);

			await swap.focus();
			await page.keyboard.press('Shift+Tab');
			await page.keyboard.press('Tab');
			await expect(swap).toBeFocused();
			expect(await swap.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
			expect(await swap.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');

			await page.keyboard.press('Enter');
			await expect(alternatives(page).first()).toBeVisible();
			await expectNoSideScroll(page);
			await captureScreen(page, testInfo, 'session-swap-desktop');
		});
	});
});
