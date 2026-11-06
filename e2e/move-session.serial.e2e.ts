/**
 * Moving a planned session (src/routes/(app)/train/session/[key], EditSheetHost and MoveSheet):
 * the first owner edit in the UI. Move opens a code-split sheet listing the days left in the
 * session's week as one choice; a day that breaks an interference rule is warned about before
 * saving; Save is busy while it posts, then a toast names the day and the new version, and Train
 * shows the session moved. Every version stays as it was, and the decision keeps the reason and
 * the warnings. A page left on an older version, an offline save and a sheet whose code fails to
 * load each have their designed state; Close and Escape return focus to Move.
 *
 * The program is seeded next week (PROGRAM_TZ), so every one of its days is ahead on any weekday.
 * Serial: programs are the one owner's (e2e/program-support.ts).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { addDays } from '../src/lib/domain/calendar';
import { longDate, shortDate } from '../src/lib/ui/program/words';
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

const CLIENT = path.resolve(import.meta.dirname, '../.svelte-kit/output/client');

/** A module's chunk in the build under test (`_app/immutable/chunks/….js`), from Vite's manifest. */
function chunkFile(source: string): string {
	const manifest = JSON.parse(readFileSync(`${CLIENT}/.vite/manifest.json`, 'utf8')) as Record<
		string,
		{ file: string } | undefined
	>;
	const chunk = manifest[source];
	if (!chunk) throw new Error(`${source} is not in the build under test`);
	return chunk.file;
}

const MOVE_SHEET = 'src/lib/ui/program/MoveSheet.svelte';
const EDIT_HOST = 'src/lib/ui/program/EditSheetHost.svelte';

const moveButton = (page: Page) => page.getByTestId('move-session');
const sheet = (page: Page) => page.getByRole('dialog', { name: 'Move session' });
const day = (page: Page, date: string) =>
	sheet(page).getByRole('radio', { name: new RegExp(`^${shortDate(date)}\\b`) });
const save = (page: Page) => sheet(page).getByTestId('edit-save');

/** Open the Move sheet and wait for its days. */
async function openMove(page: Page) {
	await moveButton(page).click();
	await expect(sheet(page).getByRole('radio').first()).toBeVisible();
}

/** Every version's copy of a session, oldest first: its day and status in each. */
function versionsOf(lineage: string) {
	return query<{ number: number; scheduled_on: string; status: string; moved_from: string | null }>(
		`select v.number, s.scheduled_on::text, s.status, s.moved_from::text
		   from planned_sessions s
		   join program_version_weeks vw on vw.week_id = s.week_id
		   join program_versions v on v.id = vw.version_id
		  where s.lineage_id = $1
		  order by v.number`,
		[lineage]
	);
}

/** The decisions the owner's edits recorded, oldest first. */
function ownerDecisions() {
	return query<{ number: number; kind: string; why: string; decided_by: string }>(
		`select v.number, d.kind, d.why, d.decided_by
		   from programming_decisions d join program_versions v on v.id = d.version_id
		  where d.decided_by = 'owner'
		  order by d.id`
	);
}

/** Move a session through the screen's own action, as another tab of the app would. */
async function moveThroughAction(
	request: APIRequestContext,
	lineage: string,
	toDate: string,
	version: number
) {
	const response = await request.post(`/train/session/${lineage}?/move`, {
		headers: { ...SAME_ORIGIN, accept: 'application/json', 'x-sveltekit-action': 'true' },
		multipart: { payload: JSON.stringify({ sessionLineage: lineage, toDate, version }) }
	});
	expect(await response.json()).toMatchObject({ type: 'success' });
}

/** axe with the Move sheet open, in the dark and the light theme. */
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
		await page.waitForTimeout(500); // the sheet's rise and the notices settle
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
	/** The `n`th session titled `title` in version 1 (week order). */
	const titled = (title: string, n = 0): SeededSession =>
		seeded.sessions.filter((s) => s.title === title)[n]!;
	const open = (session: SeededSession) => `/train/session/${session.lineage}`;

	test.beforeEach(async ({ request }) => {
		seeded = await seedProgram(request, { fixture: 'hybrid', start: 'next_week' });
	});

	test("Monday's session moves to Wednesday as version 2, with its reason, and Train shows it there", async ({
		page
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		const full = titled('Full body');
		const wednesday = addDays(seeded.weekStart, 2);
		await gotoHydrated(page, open(full));
		await openMove(page);

		// Tuesday to Sunday, each with what is planned there; not Monday, its own day.
		const days = sheet(page).getByRole('radio');
		await expect(days).toHaveCount(6);
		for (let n = 1; n < 7; n++) {
			await expect(days.nth(n - 1)).toHaveAccessibleName(
				new RegExp(`^${shortDate(addDays(seeded.weekStart, n))}\\b`)
			);
		}
		await expect(days.nth(1)).toHaveAccessibleName(/Intervals$/);
		await expect(days.nth(4)).toHaveAccessibleName(/Rest day$/);
		await expect(save(page)).toHaveText('Move');

		await day(page, wednesday).check();
		await expect(sheet(page).getByTestId('move-check')).toHaveText(
			'Wednesday fits the rest of your week.'
		);
		await sheet(page)
			.getByLabel(/^Reason/)
			.fill('Work trip on Monday');
		await captureScreen(page, testInfo, 'session-move');

		await save(page).click();
		await expect(toastWith(page, 'Moved to Wednesday · version 2')).toBeVisible();
		await expect(sheet(page)).toBeHidden();
		await expect(moveButton(page)).toBeFocused();
		await expect(page.locator('header.page-header .eyebrow')).toHaveText(
			`${longDate(wednesday)} · Morning`
		);
		await expect(page.getByTestId('session-status')).toHaveText('Moved from Mon');

		// Every version as it was: version 1 still plans it on Monday.
		expect(await versionsOf(full.lineage)).toEqual([
			{ number: 1, scheduled_on: full.date, status: 'planned', moved_from: null },
			{ number: 2, scheduled_on: wednesday, status: 'moved', moved_from: full.date }
		]);
		expect(await ownerDecisions()).toEqual([
			{
				number: 2,
				kind: 'session_moved',
				why: 'You moved Full body from Mon to Wed. Work trip on Monday.',
				decided_by: 'owner'
			}
		]);

		// Train shows it on Wednesday, moved, and a reload keeps it there.
		await page.getByTestId('back-to-train').click();
		await page
			.getByTestId('week-strip')
			.getByRole('radio', { name: new RegExp(`^${longDate(wednesday)}\\b`) })
			.click();
		const card = page.getByTestId('session-card').filter({ hasText: 'Full body' });
		await expect(card).toContainText('Moved from Mon');
		await gotoHydrated(page, open(full));
		await expect(page.getByTestId('session-status')).toHaveText('Moved from Mon');
		expect(errors).toEqual([]);
	});

	test('moving heavy lower body to the day before Muay Thai warns before saving, and the decision keeps the warning', async ({
		page
	}, testInfo) => {
		// Week 2's Full body squats heavy; Thursday holds a hard Muay Thai class.
		const heavy = titled('Full body', 1);
		const wednesday = addDays(seeded.weekStart, 9);
		const warning =
			'Heavy lower body the day before hard Muay Thai: Full body on Wednesday, then Muay Thai class on Thursday.';
		await gotoHydrated(page, open(heavy));
		await openMove(page);
		await day(page, wednesday).check();

		const warnings = sheet(page).getByTestId('move-warnings');
		await expect(warnings).toContainText('Before you move it');
		await expect(warnings.getByRole('listitem').first()).toHaveText(warning);
		await expect(warnings).toContainText('You can still move it');
		await expect(save(page)).toBeEnabled();
		expect(await ownerDecisions()).toEqual([]);
		await captureScreen(page, testInfo, 'session-move-warning');

		await save(page).click();
		await expect(toastWith(page, 'Moved to Wednesday · version 2')).toBeVisible();
		const [decision] = await ownerDecisions();
		expect(decision!.why).toMatch(/^You moved Full body from Mon to Wed\. No reason given\. /);
		expect(decision!.why).toContain(warning);
	});

	test('a page left on an older version says the plan changed, and changes nothing', async ({
		page,
		request
	}) => {
		const full = titled('Full body');
		await gotoHydrated(page, open(full));
		// Moved meanwhile, from another tab: this page still shows version 1.
		await moveThroughAction(request, full.lineage, addDays(seeded.weekStart, 2), 1);

		await openMove(page);
		await day(page, addDays(seeded.weekStart, 4)).check();
		const conflict = sheet(page).getByTestId('move-conflict');
		await expect(conflict).toContainText('Your plan changed');
		await save(page).click();
		await expect(conflict).toContainText('nothing was moved');
		await expect(sheet(page)).toBeVisible();
		expect((await versionsOf(full.lineage)).map((v) => v.scheduled_on)).toEqual([
			full.date,
			addDays(seeded.weekStart, 2)
		]);

		// Reload shows the latest, from which it can move again.
		await conflict.getByRole('button', { name: 'Reload' }).click();
		await expect(conflict).toBeHidden();
		await expect(day(page, full.date)).toBeVisible(); // Monday is a day it can move back to
		await day(page, addDays(seeded.weekStart, 4)).check();
		await expect(sheet(page).getByTestId('move-check')).toContainText('Friday');
	});

	test('Close and Escape return focus to Move', async ({ page }) => {
		await gotoHydrated(page, open(titled('Intervals')));
		await openMove(page);
		await sheet(page).getByRole('button', { name: 'Close' }).click();
		await expect(sheet(page)).toBeHidden();
		await expect(moveButton(page)).toBeFocused();

		await openMove(page);
		await page.keyboard.press('Escape');
		await expect(sheet(page)).toBeHidden();
		await expect(moveButton(page)).toBeFocused();
		expect(await versionsOf(titled('Intervals').lineage)).toHaveLength(1);
	});

	test('the sheet passes axe in dark and light, with a warning showing', async ({ page }) => {
		await gotoHydrated(page, open(titled('Full body', 1)));
		await auditThemes(page, async () => {
			await openMove(page);
			await day(page, addDays(seeded.weekStart, 9)).check();
			await expect(sheet(page).getByTestId('move-warnings')).toBeVisible();
		});
	});

	test.describe('with the network in the test’s hands', () => {
		// page.route never sees a request from a page the service worker controls on WebKit.
		test.use({ serviceWorkers: 'block' });

		test('Save is busy while the move posts, and a second tap posts nothing', async ({ page }) => {
			await gotoHydrated(page, open(titled('Full body')));
			await openMove(page);
			await day(page, addDays(seeded.weekStart, 4)).check();
			await expect(sheet(page).getByTestId('move-check')).toBeVisible();

			let posts = 0;
			let release!: () => void;
			const held = new Promise<void>((resolve) => (release = resolve));
			await page.route(
				(url) => url.search === '?/move',
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
			await save(page).dispatchEvent('click');
			release();
			await expect(toastWith(page, 'Moved to Friday · version 2')).toBeVisible();
			await page.unrouteAll({ behavior: 'ignoreErrors' });
			expect(posts).toBe(1);
			expect(await versionsOf(titled('Full body').lineage)).toHaveLength(2);
		});

		test('a save offline keeps the sheet open with the error, and nothing changes', async ({
			page,
			context
		}) => {
			await gotoHydrated(page, open(titled('Full body')));
			await openMove(page);
			await day(page, addDays(seeded.weekStart, 4)).check();
			await expect(sheet(page).getByTestId('move-check')).toBeVisible();

			await context.setOffline(true);
			await save(page).click();
			await expect(sheet(page).getByTestId('move-error')).toHaveText(
				'Can’t reach the server. Check your connection, then try again.'
			);
			await expect(sheet(page)).toBeVisible();
			await expect(save(page)).toBeEnabled();
			await expect(day(page, addDays(seeded.weekStart, 4))).toBeChecked();
			await context.setOffline(false);
			expect(await versionsOf(titled('Full body').lineage)).toHaveLength(1);
		});

		test('two warnings in the same words are both listed', async ({ page }) => {
			// Sessions can share a title, so one rule broken twice by a move can read word for word.
			const twice =
				'Heavy lower body the day before hard Muay Thai: Full body on Friday, then Muay Thai class on Saturday.';
			await page.route(
				(url) => url.search === '?/checkMove',
				(route) =>
					route.fulfill({
						json: {
							type: 'success',
							status: 200,
							// { warnings: [warning, warning] }, in devalue as SvelteKit sends an action's data.
							data: JSON.stringify([
								{ warnings: 1 },
								[2, 5],
								{ severity: 3, message: 4 },
								'avoid',
								twice,
								{ severity: 3, message: 4 }
							])
						}
					})
			);
			const errors = trackConsoleErrors(page);
			await gotoHydrated(page, open(titled('Full body')));
			await openMove(page);
			await day(page, addDays(seeded.weekStart, 4)).check();
			await expect(sheet(page).getByTestId('move-warnings').getByRole('listitem')).toHaveText([
				twice,
				twice
			]);
			expect(errors).toEqual([]);
		});

		test('a sheet whose code fails to load shows Retry, and Retry loads it', async ({ page }) => {
			const chunk = `**/${chunkFile(MOVE_SHEET)}`;
			await page.route(chunk, (route) => route.abort());
			const full = titled('Full body');
			await gotoHydrated(page, open(full));
			// Fetched as a module, never as a modulepreload, which WebKit would never fetch again.
			await expect(
				page.locator(`link[rel="modulepreload"][href$="/${chunkFile(MOVE_SHEET)}"]`)
			).toHaveCount(0);

			await moveButton(page).click();
			const failed = sheet(page).getByTestId('edit-sheet-error');
			await expect(failed).toContainText('Couldn’t load this editor');
			await expect(save(page)).toHaveCount(0);

			// In place on WebKit; on Chromium, which keeps the failed fetch, through a reload of
			// the screen that opens the sheet once its code arrives.
			await page.unroute(chunk);
			await failed.getByRole('button', { name: 'Retry' }).click();
			await expect(day(page, addDays(seeded.weekStart, 2))).toBeVisible();
			await expect(save(page)).toHaveText('Move');

			// Closed, focus is on Move, whichever way the sheet opened, and the URL is the screen's.
			await page.keyboard.press('Escape');
			await expect(sheet(page)).toBeHidden();
			await expect(moveButton(page)).toBeFocused();
			await expect(page).toHaveURL(new RegExp(`${open(full)}$`));
		});

		test('an editor whose code fails to load is a toast with Retry, which opens the sheet', async ({
			page
		}) => {
			const chunk = `**/${chunkFile(EDIT_HOST)}`;
			await page.route(chunk, (route) => route.abort());
			const full = titled('Full body');
			await gotoHydrated(page, open(full));
			await moveButton(page).click();
			const failed = toastWith(page, 'Couldn’t open the editor. Check your connection.');
			await expect(failed).toBeVisible();
			await expect(sheet(page)).toHaveCount(0);
			await expect(moveButton(page)).not.toHaveAttribute('aria-busy', 'true');

			// In place on WebKit; on Chromium, through a reload that opens the sheet.
			await page.unroute(chunk);
			await failed.getByRole('button', { name: 'Retry' }).click();
			await expect(day(page, addDays(seeded.weekStart, 2))).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(moveButton(page)).toBeFocused();
			await expect(page).toHaveURL(new RegExp(`${open(full)}$`));
		});
	});

	test.describe('on a desktop window', () => {
		test.use(DESKTOP);

		test('Move has hover and focus states, and its sheet opens with nothing scrolling sideways', async ({
			page
		}, testInfo) => {
			await gotoHydrated(page, open(titled('Full body')));
			const move = moveButton(page);
			const background = () => move.evaluate((el) => getComputedStyle(el).backgroundColor);
			const resting = await background();
			await move.hover();
			await expect.poll(background).not.toBe(resting);
			await page.mouse.move(720, 880);

			// From the keyboard: Tab reaches it after the rail and Back, with a focus ring.
			for (
				let i = 0;
				i < 12 && !(await move.evaluate((el) => el === document.activeElement));
				i++
			) {
				await page.keyboard.press('Tab');
			}
			await expect(move).toBeFocused();
			expect(await move.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
			expect(await move.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');

			await page.keyboard.press('Enter');
			await expect(sheet(page).getByRole('radio').first()).toBeVisible();
			await expectNoSideScroll(page);
			await captureScreen(page, testInfo, 'session-move-desktop');
		});
	});
});
