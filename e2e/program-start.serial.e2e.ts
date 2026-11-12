/**
 * When a program starts (owner decision 2026-11-12): a new owner sees no running program before
 * finishing setup, on Today, Train or Train's Start date screen, and the build refuses one; once
 * built, moving its start on Start date updates Train, Today and History together. On an iPhone
 * and in a desktop window. Serial: each test resets and builds the one owner's training profile
 * through the app's own actions, and the last leaves it blank again.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { addDays, mondayOf } from '../src/lib/domain/calendar';
import { localDay } from '../src/lib/domain/dates';
import { longDate, shortDate } from '../src/lib/ui/program/words';
import { DESKTOP, expectMainCentred, expectNoSideScroll } from './desktop';
import {
	captureScreen,
	gotoHydrated,
	profileAction,
	query,
	resetTrainingProfile,
	SAME_ORIGIN,
	toastWith,
	trackConsoleErrors
} from './support';

const ZONE = 'Europe/London';
test.use({ timezoneId: ZONE });

/** Today where the owner is, as the server counts it from the zone the browser sends. */
const today = () => localDay(new Date(), ZONE);
/** Week 1's first day for 'Next Monday': today when it is a Monday. */
function nextMonday(day: string): string {
	const monday = mondayOf(day);
	return monday === day ? day : addDays(monday, 7);
}

/** The least a finished setup needs: one goal and a schedule, then Finish. */
async function finishSetup(request: APIRequestContext) {
	await profileAction(request, '/profile/goals?/saveGoal', {
		kind: 'general',
		title: 'Stay strong',
		disciplines: ['strength'],
		focus: 'Stay strong',
		measure: 'Train every planned week'
	});
	await profileAction(request, '/profile/schedule?/save', {
		daysPerWeek: 3,
		availableDays: [],
		preferredTimes: [],
		sessionMinutes: 60,
		commitments: []
	});
	const finish = await request.post('/onboarding/review?/complete', {
		headers: { ...SAME_ORIGIN, accept: 'application/json', 'x-sveltekit-action': 'true' },
		multipart: { payload: '{}' }
	});
	expect(await finish.json()).toMatchObject({ type: 'redirect', location: '/today' });
}

/** Today's Build card, then Start week 1 for next Monday: Train opens on the program. */
async function buildOnToday(page: Page) {
	await gotoHydrated(page, '/today');
	await page.locator('[data-testid="today-build-cta"]:not([data-served] *)').click();
	await expect(page.getByTestId('build-preview-ready')).toBeVisible({ timeout: 15_000 });
	await page.getByTestId('build-start').click();
	await expect(page).toHaveURL('/train');
}

async function audit(page: Page) {
	await page.waitForFunction(() => document.fonts.status === 'loaded');
	await page.waitForTimeout(400);
	const { violations } = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.analyze();
	return violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
}

const versions = () =>
	query<{ number: number; starts_on: string; first_planned_day: string; summary: string }>(
		`select v.number, v.starts_on::text, v.first_planned_day::text, v.summary
		   from programs p join program_versions v on v.program_id = p.id order by v.number`
	);

test.beforeEach(async () => {
	await resetTrainingProfile();
});

test.afterAll(async () => {
	await resetTrainingProfile();
});

test('before setup is finished there is no running program anywhere, and the build refuses one', async ({
	page,
	request
}, testInfo) => {
	const errors = trackConsoleErrors(page);
	await gotoHydrated(page, '/today');
	await expect(page.getByTestId('today-setup')).toBeVisible();
	await expect(page.getByTestId('today-plan')).toHaveCount(0);

	await gotoHydrated(page, '/train');
	await expect(page.getByTestId('train-empty')).toContainText('Finish your training profile first');
	await expect(page.getByTestId('program-header')).toHaveCount(0);

	await gotoHydrated(page, '/train/start');
	await expect(page.getByTestId('start-setup')).toContainText('Finish setting up first');
	await expect(page.getByTestId('start-next')).toHaveAttribute('href', '/today');
	await expect(page.getByTestId('start-choices')).toHaveCount(0);
	expect(await audit(page)).toEqual([]);
	await captureScreen(page, testInfo, 'train-start-setup');

	// Asked directly, the server refuses to plan or build anything.
	for (const name of ['preview', 'build']) {
		const response = await request.post(`/today?/${name}`, {
			headers: { ...SAME_ORIGIN, accept: 'application/json', 'x-sveltekit-action': 'true' },
			multipart: { payload: JSON.stringify({ timeZone: ZONE, start: 'next_monday' }) }
		});
		const body = await response.json();
		expect(body, name).toMatchObject({ type: 'failure', status: 400 });
		if (name === 'preview')
			expect(JSON.stringify(body)).toContain('Finish setting up your profile first');
	}
	expect(await query('select id from programs')).toEqual([]);
	expect(errors).toEqual([]);
});

/** Build, then move the start a week later on Start date: Train, Today and History follow. */
async function moveAWeekLater(page: Page, request: APIRequestContext) {
	await finishSetup(request);
	await buildOnToday(page);
	const built = nextMonday(today());
	const moved = addDays(built, 7);

	// Train offers Start date until the program has started.
	await page.getByTestId('open-start').click();
	await expect(page).toHaveURL('/train/start');
	await expect(page.getByTestId('start-current')).toHaveText(`Week 1 starts ${longDate(built)}.`);
	const choices = page.getByTestId('start-choices');
	const current = choices.getByRole('radio', {
		name: new RegExp(`${shortDate(built)}.*Your current start`)
	});
	await expect(current).toBeChecked();
	// Nothing to move until another start is picked.
	await expect(page.getByTestId('move-start')).toBeDisabled();
	await choices.getByRole('radio', { name: shortDate(moved), exact: true }).check();
	await page.getByTestId('move-start').click();

	await expect(toastWith(page, `Start moved to ${shortDate(moved)} · version 2`)).toBeVisible();
	await expect(page).toHaveURL('/train');
	await expect(page.getByTestId('program-status')).toHaveText(`Starts ${shortDate(moved)}`);

	// Today shows the new first day.
	await gotoHydrated(page, '/today');
	await expect(page.getByTestId('today-starts')).toContainText(`Week 1 begins ${longDate(moved)}`);

	// History lists the move as version 2, by the owner, with its why.
	await gotoHydrated(page, '/train/history');
	const newest = page.getByTestId('version').first();
	await expect(newest).toContainText('Version 2');
	await expect(newest).toContainText(`Moved the start to ${shortDate(moved)}`);

	expect(await versions()).toEqual([
		{ number: 1, starts_on: built, first_planned_day: built, summary: 'Your first program' },
		{
			number: 2,
			starts_on: moved,
			first_planned_day: moved,
			summary: `Moved the start to ${shortDate(moved)}`
		}
	]);
	return { built, moved };
}

test('moving the start a week later updates Train, Today and History', async ({
	page,
	request
}, testInfo) => {
	test.setTimeout(90_000);
	const errors = trackConsoleErrors(page);
	const { built } = await moveAWeekLater(page, request);

	// Moving back undoes it, as version 3; Today offers the way there too.
	await gotoHydrated(page, '/today');
	await page.getByTestId('today-change-start').click();
	await expect(page).toHaveURL('/train/start');
	expect(await audit(page)).toEqual([]);
	await captureScreen(page, testInfo, 'train-start');
	await page
		.getByTestId('start-choices')
		.getByRole('radio', {
			name: built === today() ? `Today, ${shortDate(built)}` : shortDate(built),
			exact: true
		})
		.check();
	await page.getByTestId('move-start').click();
	await expect(toastWith(page, `Start moved to ${shortDate(built)} · version 3`)).toBeVisible();
	expect((await versions()).map((v) => [v.number, v.first_planned_day])).toEqual([
		[1, built],
		[2, addDays(built, 7)],
		[3, built]
	]);
	expect(errors).toEqual([]);
});

test.describe('in a desktop window', () => {
	test.use(DESKTOP);

	test('moving the start updates Train, Today and History; Start date sits in the readable column', async ({
		page,
		request
	}, testInfo) => {
		test.setTimeout(90_000);
		const errors = trackConsoleErrors(page);
		await moveAWeekLater(page, request);
		await gotoHydrated(page, '/train/start');
		await expect(page.getByTestId('start-choices')).toBeVisible();
		await expectMainCentred(page);
		await expectNoSideScroll(page);
		expect(await audit(page)).toEqual([]);
		await captureScreen(page, testInfo, 'train-start-desktop');
		expect(errors).toEqual([]);
	});
});
