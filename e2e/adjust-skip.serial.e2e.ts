/**
 * Adjusting and skipping a planned session (src/routes/(app)/train/session/[key], EditSheetHost,
 * AdjustSheet and SkipSheet): the last owner edits in the UI.
 * - Adjust is a sheet of NumberSteppers shaped by discipline: an exercise's sets, reps, RPE, load
 *   and rest; a run segment's repeats, distance, duration, pace and RPE; a class's length and RPE.
 *   A value out of range is shown on its stepper, announced, and nothing is posted.
 * - Skip takes an optional reason; the session then shows its designed skipped state, and Train
 *   shows it Skipped on its day.
 * Each saves the next version with its decision; a reload keeps it. Save is busy while it posts;
 * Close and Escape return focus to what opened the sheet.
 *
 * The program is seeded next week (PROGRAM_TZ), so every one of its days is ahead on any weekday.
 * Serial: programs are the one owner's (e2e/program-support.ts).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { longDate } from '../src/lib/ui/program/words';
import { DESKTOP, expectNoSideScroll } from './desktop';
import { PROGRAM_TZ, seedProgram, type SeededProgram, type SeededSession } from './program-support';
import {
	captureScreen,
	gotoHydrated,
	query,
	resetTrainingProfile,
	SAME_ORIGIN,
	toastWith,
	trackConsoleErrors
} from './support';

test.use({ timezoneId: PROGRAM_TZ });

test.beforeEach(async () => {
	await resetTrainingProfile();
});

const adjustSheet = (page: Page) => page.getByRole('dialog', { name: 'Adjust' });
const skipSheet = (page: Page) => page.getByRole('dialog', { name: 'Skip session' });
const saveIn = (sheet: ReturnType<Page['getByRole']>) => sheet.getByTestId('edit-save');
const stepper = (page: Page, name: string) =>
	adjustSheet(page).getByRole('spinbutton', { name, exact: true });
const adjustExercise = (page: Page, name: string) =>
	page.getByRole('button', { name: `Adjust ${name}`, exact: true });
const exercise = (page: Page, name: string) =>
	page.getByTestId('exercise').filter({ has: page.getByRole('heading', { name, exact: true }) });
const facts = (page: Page) => page.getByTestId('session-facts').getByRole('listitem');

/** Open Adjust on an exercise, or on the session (a run, a class), and wait for its steppers. */
async function openAdjust(page: Page, exerciseName?: string) {
	const trigger = exerciseName
		? adjustExercise(page, exerciseName)
		: page.getByTestId('adjust-session');
	await trigger.click();
	await expect(adjustSheet(page).getByRole('spinbutton').first()).toBeVisible();
}

async function openSkip(page: Page) {
	await page.getByTestId('skip-session').click();
	await expect(skipSheet(page).getByLabel(/^Reason/)).toBeVisible();
}

function versionCount() {
	return query<{ n: number }>('select count(*)::int as n from program_versions').then(
		([row]) => row!.n
	);
}

/** The decisions the owner's edits recorded, oldest first. */
function ownerDecisions() {
	return query<{ number: number; kind: string; why: string }>(
		`select v.number, d.kind, d.why
		   from programming_decisions d join program_versions v on v.id = d.version_id
		  where d.decided_by = 'owner'
		  order by d.id`
	);
}

/** Skip a session through the screen's own action, as another tab of the app would. */
async function skipThroughAction(request: APIRequestContext, lineage: string) {
	const response = await request.post(`/train/session/${lineage}?/skip`, {
		headers: { ...SAME_ORIGIN, accept: 'application/json', 'x-sveltekit-action': 'true' },
		multipart: { payload: JSON.stringify({ sessionLineage: lineage, version: 1 }) }
	});
	expect(await response.json()).toMatchObject({ type: 'success' });
}

async function axe(page: Page, label: string) {
	await page.evaluate(() => document.fonts.ready);
	await page.waitForTimeout(500); // the sheet's rise settles: contrast on final colours
	const { violations } = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.analyze();
	const found = violations.flatMap((v) =>
		v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${n.failureSummary}`)
	);
	expect(found, `axe, ${label}`).toEqual([]);
}

test.describe('a program that starts next week', () => {
	let seeded: SeededProgram;
	/** The `n`th session titled `title` in version 1 (week order). */
	const titled = (title: string, n = 0): SeededSession =>
		seeded.sessions.filter((s) => s.title === title)[n]!;
	const open = (session: SeededSession) => `/train/session/${session.lineage}`;
	/** Train on the session's day: its cards. */
	async function trainCard(page: Page, session: SeededSession) {
		await gotoHydrated(page, '/train');
		await page
			.getByTestId('week-strip')
			.getByRole('radio', { name: new RegExp(`^${longDate(session.date)}\\b`) })
			.click();
		return page.getByTestId('session-card').filter({ hasText: session.title });
	}

	test.beforeEach(async ({ request }) => {
		seeded = await seedProgram(request, { fixture: 'hybrid', start: 'next_week' });
	});

	test('strength: 3 → 4 sets at RPE 7 → 7.5 updates the exercise, as version 2 with its decision', async ({
		page
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		const full = titled('Full body');
		await gotoHydrated(page, open(full));
		await expect(exercise(page, 'Barbell row')).toContainText('3 × 8–10 @ RPE 7');
		await openAdjust(page, 'Barbell row');
		await expect(adjustSheet(page)).toContainText('Barbell row');
		await expect(stepper(page, 'Sets')).toHaveAttribute('aria-valuenow', '3');
		await expect(stepper(page, 'Target RPE')).toHaveAttribute('aria-valuenow', '7');
		await expect(saveIn(adjustSheet(page))).toHaveText('Save');

		await adjustSheet(page).getByRole('button', { name: 'Increase Sets' }).click();
		await adjustSheet(page).getByRole('button', { name: 'Increase Target RPE' }).click();
		await expect(stepper(page, 'Sets')).toHaveAttribute('aria-valuenow', '4');
		await expect(stepper(page, 'Target RPE')).toHaveAttribute('aria-valuenow', '7.5');
		await adjustSheet(page)
			.getByLabel(/^Reason/)
			.fill('Feeling strong');
		await captureScreen(page, testInfo, 'session-adjust');

		await saveIn(adjustSheet(page)).click();
		await expect(toastWith(page, 'Adjusted Barbell row · version 2')).toBeVisible();
		await expect(adjustSheet(page)).toBeHidden();
		await expect(adjustExercise(page, 'Barbell row')).toBeFocused();
		await expect(exercise(page, 'Barbell row')).toContainText('4 × 8–10 @ RPE 7.5');

		const decisions = await ownerDecisions();
		expect(decisions).toHaveLength(1);
		expect(decisions[0]).toMatchObject({ number: 2, kind: 'prescription_adjusted' });
		expect(decisions[0]!.why).toContain('Feeling strong');

		await gotoHydrated(page, open(full));
		await expect(exercise(page, 'Barbell row')).toContainText('4 × 8–10 @ RPE 7.5');
		expect(errors).toEqual([]);
	});

	test('run: the intervals’ repeats 6 → 5 change the whole repeat group and the run’s minutes', async ({
		page
	}, testInfo) => {
		const intervals = titled('Intervals');
		await gotoHydrated(page, open(intervals));
		await expect(page.getByTestId('run')).toContainText('Repeat 6 times');
		const minutes = await facts(page).first().textContent();
		await openAdjust(page);

		// Its segments to pick from; the repeat group's first is picked, with its repeats.
		const segments = adjustSheet(page).getByRole('group', { name: 'Segment' }).getByRole('radio');
		await expect(segments).toHaveCount(4);
		await expect(segments.nth(1)).toBeChecked();
		await expect(segments.nth(1)).toHaveAccessibleName(/^6 × Interval 400 m/);
		await expect(stepper(page, 'Repeats')).toHaveAttribute('aria-valuenow', '6');
		await expect(stepper(page, 'Pace, fastest')).toHaveValue('3:45');
		await adjustSheet(page).getByRole('button', { name: 'Decrease Repeats' }).click();
		await captureScreen(page, testInfo, 'session-adjust-run');

		await saveIn(adjustSheet(page)).click();
		await expect(toastWith(page, 'Adjusted Intervals · version 2')).toBeVisible();
		await expect(page.getByTestId('run')).toContainText('Repeat 5 times');
		await expect(facts(page).first()).not.toHaveText(minutes!);
		expect(await ownerDecisions()).toMatchObject([{ number: 2, kind: 'prescription_adjusted' }]);

		await gotoHydrated(page, open(intervals));
		await expect(page.getByTestId('run')).toContainText('Repeat 5 times');
	});

	test('Muay Thai: 90 → 60 min updates the detail and Train’s card', async ({ page }) => {
		const thai = titled('Muay Thai class');
		await gotoHydrated(page, open(thai));
		await openAdjust(page);
		await expect(adjustSheet(page).getByRole('spinbutton')).toHaveCount(2);
		await stepper(page, 'Duration').fill('60');
		await stepper(page, 'Duration').press('Enter');
		await expect(stepper(page, 'Duration')).toHaveAttribute('aria-valuenow', '60');
		await saveIn(adjustSheet(page)).click();
		await expect(toastWith(page, 'Adjusted Muay Thai class · version 2')).toBeVisible();
		await expect(facts(page).first()).toHaveText(/^Duration\s*60\s*min\s*$/);
		expect(await ownerDecisions()).toMatchObject([{ number: 2, kind: 'prescription_adjusted' }]);

		await expect(await trainCard(page, thai)).toContainText('Muay Thai · 60 min');
		await gotoHydrated(page, open(thai));
		await expect(facts(page).first()).toHaveText(/^Duration\s*60\s*min\s*$/);
	});

	test('skip with a reason: the designed skipped state, and Skipped on Train’s day', async ({
		page
	}, testInfo) => {
		const easy = titled('Easy run');
		await gotoHydrated(page, open(easy));
		await openSkip(page);
		await expect(saveIn(skipSheet(page))).toHaveText('Skip');
		await skipSheet(page)
			.getByLabel(/^Reason/)
			.fill('Travelling');
		await saveIn(skipSheet(page)).click();
		await expect(toastWith(page, 'Skipped Easy run · version 2')).toBeVisible();
		await expect(skipSheet(page)).toBeHidden();

		const skipped = page.getByTestId('session-skipped');
		await expect(skipped).toContainText('Skipped');
		await expect(skipped.getByRole('link', { name: 'See why in History' })).toBeVisible();
		await expect(page.getByTestId('session-status')).toHaveText('Skipped');
		// Nothing left to change.
		for (const id of ['move-session', 'adjust-session', 'skip-session']) {
			await expect(page.getByTestId(id)).toHaveCount(0);
		}
		await captureScreen(page, testInfo, 'session-skipped');

		const decisions = await ownerDecisions();
		expect(decisions).toMatchObject([{ number: 2, kind: 'session_skipped' }]);
		expect(decisions[0]!.why).toContain('Travelling');
		expect(
			await query<{ number: number; status: string }>(
				`select v.number, s.status
				   from planned_sessions s
				   join program_version_weeks vw on vw.week_id = s.week_id
				   join program_versions v on v.id = vw.version_id
				  where s.lineage_id = $1
				  order by v.number`,
				[easy.lineage]
			)
		).toEqual([
			{ number: 1, status: 'planned' },
			{ number: 2, status: 'skipped' }
		]);

		await expect(await trainCard(page, easy)).toContainText('Skipped');
		await gotoHydrated(page, open(easy));
		await expect(page.getByTestId('session-skipped')).toBeVisible();
	});

	test('Adjust left open while another tab skips the session: Reload closes it onto the skipped state', async ({
		page,
		request
	}) => {
		const errors = trackConsoleErrors(page);
		const full = titled('Full body');
		await gotoHydrated(page, open(full));
		await openAdjust(page, 'Barbell row');
		await skipThroughAction(request, full.lineage);

		await adjustSheet(page).getByRole('button', { name: 'Increase Sets' }).click();
		await saveIn(adjustSheet(page)).click();
		const conflict = adjustSheet(page).getByTestId('adjust-conflict');
		await expect(conflict).toContainText('Your plan changed');
		await conflict.getByRole('button', { name: 'Reload' }).click();

		await expect(adjustSheet(page)).toBeHidden();
		await expect(page.getByTestId('session-skipped')).toBeVisible();
		expect(await versionCount()).toBe(2);
		expect(errors).toEqual([]);
	});

	test('Close and Escape return focus to Adjust and to Skip', async ({ page }) => {
		await gotoHydrated(page, open(titled('Full body')));
		await openAdjust(page, 'Bench press');
		await adjustSheet(page).getByRole('button', { name: 'Close' }).click();
		await expect(adjustSheet(page)).toBeHidden();
		await expect(adjustExercise(page, 'Bench press')).toBeFocused();

		await openSkip(page);
		await page.keyboard.press('Escape');
		await expect(skipSheet(page)).toBeHidden();
		await expect(page.getByTestId('skip-session')).toBeFocused();

		await gotoHydrated(page, open(titled('Intervals')));
		await openAdjust(page);
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('adjust-session')).toBeFocused();
		expect(await versionCount()).toBe(1);
	});

	test('every sheet and the skipped state pass axe in dark and light', async ({
		page,
		request
	}) => {
		const easy = titled('Easy run');
		await skipThroughAction(request, easy.lineage);
		const variants: [string, SeededSession, () => Promise<void>][] = [
			['strength', titled('Full body'), () => openAdjust(page, 'Back squat')],
			['run', titled('Intervals'), () => openAdjust(page)],
			['class', titled('Muay Thai class'), () => openAdjust(page)],
			['skip', titled('Intervals'), () => openSkip(page)],
			['skipped', easy, () => expect(page.getByTestId('session-skipped')).toBeVisible()]
		];
		for (const theme of ['dark', 'light'] as const) {
			await gotoHydrated(page, open(easy));
			await page.evaluate(
				(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
				theme
			);
			for (const [name, session, show] of variants) {
				await gotoHydrated(page, open(session));
				await show();
				await axe(page, `${name}, ${theme}`);
			}
		}
	});

	test.describe('with the network in the test’s hands', () => {
		// page.route never sees a request from a page the service worker controls on WebKit.
		test.use({ serviceWorkers: 'block' });

		test('an RPE of 11 is shown on its stepper, announced, and nothing is posted', async ({
			page
		}) => {
			const posts: string[] = [];
			page.on('request', (r) => r.method() === 'POST' && posts.push(r.url()));
			await gotoHydrated(page, open(titled('Full body')));
			await openAdjust(page, 'Barbell row');
			await stepper(page, 'Target RPE').fill('11');
			await stepper(page, 'Target RPE').press('Tab');
			await saveIn(adjustSheet(page)).click();

			await expect(stepper(page, 'Target RPE')).toHaveAttribute('aria-invalid', 'true');
			await expect(adjustSheet(page).getByRole('alert')).toHaveText('RPE 5 to 10, in half steps');
			await expect(stepper(page, 'Target RPE')).toBeFocused();
			expect(posts).toEqual([]);
			expect(await versionCount()).toBe(1);

			// Fixed, the error goes, and the adjustment saves.
			await stepper(page, 'Target RPE').fill('8');
			await stepper(page, 'Target RPE').press('Tab');
			await expect(stepper(page, 'Target RPE')).not.toHaveAttribute('aria-invalid', 'true');
			await saveIn(adjustSheet(page)).click();
			await expect(toastWith(page, 'Adjusted Barbell row · version 2')).toBeVisible();
		});

		test('Save is busy while an adjustment or a skip posts, and a second tap posts nothing', async ({
			page
		}) => {
			let posts = 0;
			let release!: () => void;
			let held = new Promise<void>((resolve) => (release = resolve));
			await page.route(
				(url) => url.search === '?/adjustDetails' || url.search === '?/skip',
				async (route) => {
					posts += 1;
					await held;
					await route.continue();
				}
			);
			const thai = titled('Muay Thai class');
			await gotoHydrated(page, open(thai));
			await openAdjust(page);
			await adjustSheet(page).getByRole('button', { name: 'Decrease Duration' }).click();
			const saveAdjust = saveIn(adjustSheet(page));
			await saveAdjust.click();
			await expect(saveAdjust).toHaveAttribute('aria-busy', 'true');
			await expect(saveAdjust).toBeDisabled();
			await saveAdjust.click({ force: true });
			release();
			await expect(toastWith(page, 'Adjusted Muay Thai class · version 2')).toBeVisible();
			await expect(page.getByTestId('adjust-session')).toBeFocused();
			expect(posts).toBe(1);

			held = new Promise<void>((resolve) => (release = resolve));
			await openSkip(page);
			const saveSkip = saveIn(skipSheet(page));
			await saveSkip.click();
			await expect(saveSkip).toHaveAttribute('aria-busy', 'true');
			await expect(saveSkip).toBeDisabled();
			await saveSkip.click({ force: true });
			release();
			await expect(toastWith(page, 'Skipped Muay Thai class · version 3')).toBeVisible();
			await page.unrouteAll({ behavior: 'ignoreErrors' });
			expect(posts).toBe(2);
			expect(await versionCount()).toBe(3);
		});
	});

	test.describe('on a desktop window', () => {
		test.use(DESKTOP);

		test('Adjust and Skip have hover and focus states, and the sheet opens with nothing scrolling sideways', async ({
			page
		}, testInfo) => {
			await gotoHydrated(page, open(titled('Intervals')));
			for (const id of ['adjust-session', 'skip-session']) {
				const button = page.getByTestId(id);
				const background = () => button.evaluate((el) => getComputedStyle(el).backgroundColor);
				const resting = await background();
				await button.hover();
				await expect.poll(background).not.toBe(resting);
				await page.mouse.move(720, 880);
			}

			const adjust = page.getByTestId('adjust-session');
			await page.getByTestId('move-session').focus();
			await page.keyboard.press('Tab');
			await expect(adjust).toBeFocused();
			expect(await adjust.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
			expect(await adjust.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');

			await page.keyboard.press('Enter');
			await expect(adjustSheet(page).getByRole('spinbutton').first()).toBeVisible();
			await expectNoSideScroll(page);
			await captureScreen(page, testInfo, 'session-adjust-desktop');
		});
	});
});
