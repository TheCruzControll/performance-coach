/**
 * Managing conversations (src/routes/(app)/coach/[[thread]]: ThreadList, ManageSheet,
 * ArchivedSheet and ArchivedBanner; api/coach/threads):
 * - rename is busy while it saves, then the new name persists after a reload
 * - archive leaves Recent with an Undo toast, and Undo brings it back; archiving one shown by
 *   'Show older' takes it out of the list too
 * - an archived conversation is under Archived conversations; it opens read-only (the banner, the
 *   composer disabled), and Unarchive in place returns it to Recent with the composer enabled
 * - the Archived list pages ('Show older'), still to its end after its last row is unarchived;
 *   a fresh owner sees 'No archived conversations'
 * - loading rows while the list is held; a 500 offers Retry, which lists them; a failed unarchive
 *   says so on its row, and Retry unarchives it
 * - axe in both themes, on an iPhone and on a desktop window, where the sheets are centred
 *   dialogs with focus rings and hover
 *
 * Serial: the coach rows are the one owner's (e2e/coach-support.ts).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { COACH_TZ, openThread, query, resetCoach, seedCoach } from './coach-support';
import { DESKTOP, expectNoSideScroll } from './desktop';
import { captureScreen, gotoHydrated, trackConsoleErrors } from './support';

test.use({ timezoneId: COACH_TZ });

test.beforeEach(async ({ request }) => {
	await resetCoach(request);
});

test.afterAll(async ({ request }) => {
	await resetCoach(request);
});

/** bench-month's stored conversation, and the newest of archived-threads' three. */
const BENCH_QUESTION = 'How is my bench press going?';
const NEWEST_ARCHIVED = 'Can I run the day after heavy squats?';

/** The action endpoint (POST /api/coach/threads/<id>) and the Archived list's read. */
const ACTION = (url: URL) => url.pathname.startsWith('/api/coach/threads/');
const LIST = (url: URL) => url.pathname === '/api/coach/threads';

const threadRows = (page: Page) => page.getByTestId('thread-row');
const manageSheet = (page: Page) => page.getByTestId('manage-sheet');
const archivedSheet = (page: Page) => page.getByTestId('archived-sheet');
const archivedRows = (page: Page) => page.getByTestId('archived-row');
const message = (page: Page) =>
	page.getByRole('form', { name: 'Message your coach' }).getByRole('textbox', { name: 'Message' });

async function openManage(page: Page, title: string) {
	await page.getByRole('button', { name: `Manage ${title}` }).click();
	await expect(manageSheet(page)).toBeVisible();
}

async function openArchived(page: Page) {
	await page.getByTestId('archived-link').click();
	await expect(archivedSheet(page)).toBeVisible();
}

/** `count` archived conversations, an hour apart, all archived before any fixture's. */
async function manyArchived(count: number) {
	await query(
		`insert into coach_threads
			(owner_id, title, title_source, segment_prompt_version, last_message_at, archived_at)
		select o.id, 'Archived question ' || n, 'first_message', 'pv-e2e',
			now() - n * interval '1 day', now() - n * interval '1 hour'
		from owners o, generate_series(1, $1::int) n`,
		[count]
	);
}

/** `count` open conversations, a minute apart, newest 'Question 1': more than a page past 20. */
async function manyOpen(count: number) {
	await query(
		`insert into coach_threads (owner_id, title, title_source, segment_prompt_version, last_message_at)
		select o.id, 'Question ' || n, 'first_message', 'pv-e2e', now() - n * interval '1 minute'
		from owners o, generate_series(1, $1::int) n`,
		[count]
	);
}

/** One open conversation in Recent, beside a fixture's archived ones. */
const OPEN_TITLE = 'Open question';
async function oneOpen() {
	await query(
		`insert into coach_threads (owner_id, title, title_source, segment_prompt_version)
		select o.id, $1, 'first_message', 'pv-e2e' from owners o`,
		[OPEN_TITLE]
	);
}

/** axe on the conversation sheets and an archived conversation (archived-threads, oneOpen). */
async function auditManaging(page: Page, archivedId: string) {
	await audit(page, 'the manage sheet', async () => {
		await gotoHydrated(page, '/coach');
		await openManage(page, OPEN_TITLE);
	});
	await audit(page, 'the Archived list', async () => {
		await gotoHydrated(page, '/coach');
		await openArchived(page);
		await expect(archivedRows(page)).toHaveCount(3);
	});
	await audit(page, 'an archived conversation', async () => {
		await openThread(page, archivedId);
		await expect(page.getByTestId('archived-banner')).toBeVisible();
	});
}

/** axe on what is on screen, in the dark and the light theme, each opened by `open`. */
async function audit(page: Page, label: string, open: () => Promise<void>) {
	for (const theme of ['dark', 'light'] as const) {
		await page.evaluate(
			(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
			theme
		);
		await open();
		await page.evaluate(() => document.fonts.ready);
		await page.waitForTimeout(400); // the sheet's entrance settles: contrast on final colours
		const { violations } = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();
		const found = violations.flatMap((v) =>
			v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${n.failureSummary}`)
		);
		expect(found, `axe on ${label}, ${theme}`).toEqual([]);
	}
}

test('archive leaves Recent with an Undo toast, and Undo brings the conversation back', async ({
	page,
	request
}, testInfo) => {
	const errors = trackConsoleErrors(page);
	await seedCoach(request, 'bench-month');
	await gotoHydrated(page, '/coach');
	await openManage(page, BENCH_QUESTION);
	await expectNoSideScroll(page);
	await captureScreen(page, testInfo, 'coach-manage-sheet');

	await manageSheet(page).getByRole('button', { name: 'Archive conversation' }).click();
	await expect(manageSheet(page)).toBeHidden();
	await expect(threadRows(page)).toHaveCount(0);
	await expect(page.getByTestId('coach-empty')).toBeVisible();
	const toast = page.locator('.toast', { hasText: 'Conversation archived' });
	await expect(toast).toBeVisible();
	await captureScreen(page, testInfo, 'coach-archived-undo');

	await toast.getByRole('button', { name: 'Undo' }).click();
	await expect(threadRows(page)).toHaveCount(1);
	await expect(threadRows(page).first()).toContainText(BENCH_QUESTION);
	const [row] = await query<{ archived: boolean }>(
		`select archived_at is not null as archived from coach_threads`
	);
	expect(row!.archived).toBe(false);
	expect(errors).toEqual([]);
});

test('archiving a conversation from Show older takes it out of Recent', async ({ page }) => {
	await manyOpen(21);
	await gotoHydrated(page, '/coach');
	await expect(threadRows(page)).toHaveCount(20);
	await page.getByTestId('show-older').click();
	await expect(threadRows(page)).toHaveCount(21);
	await openManage(page, 'Question 21');
	await manageSheet(page).getByRole('button', { name: 'Archive conversation' }).click();
	await expect(manageSheet(page)).toBeHidden();
	await expect(threadRows(page)).toHaveCount(20);
	await expect(threadRows(page).filter({ hasText: 'Question 21' })).toHaveCount(0);
});

test('an archived conversation is under Archived, opens read-only, and Unarchive returns it', async ({
	page,
	request
}, testInfo) => {
	const seeded = await seedCoach(request, 'bench-month');
	await gotoHydrated(page, '/coach');
	await openManage(page, BENCH_QUESTION);
	await manageSheet(page).getByRole('button', { name: 'Archive conversation' }).click();
	await expect(threadRows(page)).toHaveCount(0);

	await openArchived(page);
	await expect(archivedRows(page)).toHaveCount(1);
	await expect(archivedRows(page).first()).toContainText(BENCH_QUESTION);
	await expect(archivedRows(page).first()).toContainText(/Archived today · \d\d:\d\d/);
	await captureScreen(page, testInfo, 'coach-archived-list');
	await archivedRows(page).first().getByRole('link', { name: BENCH_QUESTION }).click();

	await expect(page).toHaveURL(`/coach/${seeded.threads.bench}`);
	const banner = page.getByTestId('archived-banner');
	await expect(banner).toContainText('Archived · Unarchive to continue');
	await expect(page.getByTestId('coach-message')).toContainText('Bench press');
	await expect(message(page)).toBeDisabled();
	await expectNoSideScroll(page);
	await captureScreen(page, testInfo, 'coach-archived-thread');

	await banner.getByRole('button', { name: 'Unarchive' }).click();
	await expect(banner).toHaveCount(0);
	await expect(message(page)).toBeEnabled();
	await expect(page).toHaveURL(`/coach/${seeded.threads.bench}`);
	await page.getByTestId('all-conversations').click();
	await expect(threadRows(page)).toHaveCount(1);
	await expect(threadRows(page).first()).toContainText(BENCH_QUESTION);
});

test('the Archived list pages, and Unarchive from it returns a conversation to Recent', async ({
	page,
	request
}) => {
	await seedCoach(request, 'archived-threads');
	await manyArchived(20);
	await gotoHydrated(page, '/coach');
	await expect(page.getByTestId('coach-empty')).toBeVisible();
	await openArchived(page);
	await expect(archivedRows(page)).toHaveCount(20);
	await expect(archivedRows(page).first()).toContainText(NEWEST_ARCHIVED);
	// The page's last row is its cursor: unarchived, 'Show older' still continues to the end.
	await archivedRows(page)
		.last()
		.getByRole('button', { name: 'Unarchive Archived question 17' })
		.click();
	await expect(archivedRows(page)).toHaveCount(19);
	await archivedSheet(page).getByTestId('archived-older').click();
	await expect(archivedRows(page)).toHaveCount(22);
	await expect(archivedRows(page).last()).toContainText('Archived question 20');
	await expect(archivedSheet(page).getByTestId('archived-older')).toHaveCount(0);

	await archivedRows(page)
		.first()
		.getByRole('button', { name: `Unarchive ${NEWEST_ARCHIVED}` })
		.click();
	await expect(archivedRows(page)).toHaveCount(21);
	await archivedSheet(page).getByRole('button', { name: 'Close' }).click();
	await expect(threadRows(page)).toHaveCount(2);
	await expect(threadRows(page).filter({ hasText: NEWEST_ARCHIVED })).toHaveCount(1);
});

test('a fresh owner’s Archived list says there are no archived conversations', async ({
	page
}, testInfo) => {
	await gotoHydrated(page, '/coach');
	await openArchived(page);
	await expect(page.getByTestId('archived-empty')).toContainText('No archived conversations');
	await captureScreen(page, testInfo, 'coach-archived-empty');
});

test('the conversation sheets and an archived conversation have no WCAG A/AA violations', async ({
	page,
	request
}) => {
	const seeded = await seedCoach(request, 'archived-threads');
	await oneOpen();
	await gotoHydrated(page, '/coach');
	await auditManaging(page, seeded.threads.archived1!);
});

test.describe('with the network in the test’s hands', () => {
	// page.route never sees a request from a page the service worker controls on WebKit.
	test.use({ serviceWorkers: 'block' });

	test('rename is busy while it saves, then the new name persists after a reload', async ({
		page,
		request
	}, testInfo) => {
		await seedCoach(request, 'bench-month');
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		await page.route(ACTION, async (route) => {
			await held;
			await route.continue();
		});

		await gotoHydrated(page, '/coach');
		await openManage(page, BENCH_QUESTION);
		const field = manageSheet(page).getByRole('textbox', { name: 'Name' });
		await expect(field).toHaveValue(BENCH_QUESTION);
		await field.fill('Bench block');
		const save = manageSheet(page).getByRole('button', { name: 'Save name' });
		await save.click();
		await expect(save).toHaveAttribute('aria-busy', 'true');
		await page.evaluate(async () => {
			while (document.fonts.status !== 'loaded') await new Promise((r) => setTimeout(r, 20));
		});
		await captureScreen(page, testInfo, 'coach-rename-pending');
		release();

		await expect(manageSheet(page)).toBeHidden();
		await expect(threadRows(page).first()).toContainText('Bench block');
		await page.reload();
		await expect(threadRows(page).first()).toContainText('Bench block');
		await expect(threadRows(page).first()).not.toContainText(BENCH_QUESTION);
	});

	test('a failed rename says so, and Retry saves it', async ({ page, request }, testInfo) => {
		await seedCoach(request, 'bench-month');
		let answered = 0;
		await page.route(ACTION, async (route) => {
			answered += 1;
			if (answered === 1) return route.fulfill({ status: 500, body: '' });
			return route.continue();
		});
		await gotoHydrated(page, '/coach');
		await openManage(page, BENCH_QUESTION);
		await manageSheet(page).getByRole('textbox', { name: 'Name' }).fill('Bench block');
		await manageSheet(page).getByRole('button', { name: 'Save name' }).click();
		const failed = page.getByTestId('rename-failed');
		await expect(failed).toContainText('That didn’t go through');
		await captureScreen(page, testInfo, 'coach-rename-failed');
		await failed.getByRole('button', { name: 'Try again' }).click();
		await expect(manageSheet(page)).toBeHidden();
		await expect(threadRows(page).first()).toContainText('Bench block');
		expect(answered).toBe(2);
	});

	test('loading rows while the Archived list is held; a 500 offers Retry, which lists them', async ({
		page,
		request
	}, testInfo) => {
		await seedCoach(request, 'archived-threads');
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		let answered = 0;
		await page.route(LIST, async (route) => {
			answered += 1;
			if (answered === 1) {
				await held;
				return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
			}
			return route.continue();
		});

		await gotoHydrated(page, '/coach');
		await openArchived(page);
		const loading = page.getByTestId('archived-loading');
		await expect(loading).toHaveAttribute('aria-busy', 'true');
		await page.evaluate(async () => {
			while (document.fonts.status !== 'loaded') await new Promise((r) => setTimeout(r, 20));
		});
		await captureScreen(page, testInfo, 'coach-archived-loading');
		release();

		const failed = page.getByTestId('archived-failed');
		await expect(failed).toContainText('Couldn’t load your conversations');
		await captureScreen(page, testInfo, 'coach-archived-failed');
		await failed.getByRole('button', { name: 'Try again' }).click();
		await expect(archivedRows(page)).toHaveCount(3);
		await expect(failed).toHaveCount(0);
		expect(answered).toBe(2);
	});

	test('a failed unarchive says so on its row, and Retry unarchives it', async ({
		page,
		request
	}, testInfo) => {
		await seedCoach(request, 'archived-threads');
		let answered = 0;
		await page.route(ACTION, async (route) => {
			answered += 1;
			if (answered === 1) return route.fulfill({ status: 500, body: '' });
			return route.continue();
		});
		await gotoHydrated(page, '/coach');
		await openArchived(page);
		const row = archivedRows(page).first();
		await row.getByRole('button', { name: `Unarchive ${NEWEST_ARCHIVED}` }).click();
		await expect(row.getByTestId('unarchive-failed')).toContainText('That didn’t go through');
		await captureScreen(page, testInfo, 'coach-unarchive-failed');
		await row.getByRole('button', { name: `Try again ${NEWEST_ARCHIVED}` }).click();
		await expect(archivedRows(page)).toHaveCount(2);
		expect(answered).toBe(2);
	});
});

test.describe('on a desktop window', () => {
	test.use(DESKTOP);

	test('the Archived list is a centred dialog, with focus rings and hover on its links', async ({
		page,
		request
	}, testInfo) => {
		await seedCoach(request, 'archived-threads');
		await gotoHydrated(page, '/coach');
		await openArchived(page);
		await expect(archivedRows(page)).toHaveCount(3);

		const box = (await archivedSheet(page).locator('.sheet').boundingBox())!;
		const window = (await archivedSheet(page).boundingBox())!;
		expect(Math.abs(box.x + box.width / 2 - (window.x + window.width / 2))).toBeLessThanOrEqual(1);
		expect(box.y).toBeGreaterThan(0);

		// Tab from Close reaches the first conversation's link, which is what shows the ring.
		const link = archivedRows(page).first().getByRole('link');
		await archivedSheet(page).getByRole('button', { name: 'Close' }).focus();
		for (let i = 0; i < 10 && !(await link.evaluate((el) => el === document.activeElement)); i++)
			await page.keyboard.press('Tab');
		await expect(link).toBeFocused();
		await expect
			.poll(() => link.evaluate((el) => getComputedStyle(el).outlineStyle))
			.not.toBe('none');
		await page.mouse.move(0, 0);
		const title = link.locator('.title');
		await link.hover();
		await expect
			.poll(() => title.evaluate((el) => getComputedStyle(el).textDecorationLine))
			.toContain('underline');
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'coach-archived-desktop');
	});

	test('the sheets and an archived conversation have no WCAG A/AA violations on a desktop window', async ({
		page,
		request
	}, testInfo) => {
		const seeded = await seedCoach(request, 'archived-threads');
		await oneOpen();
		await gotoHydrated(page, '/coach');
		await auditManaging(page, seeded.threads.archived1!);
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'coach-archived-thread-desktop');
	});
});
