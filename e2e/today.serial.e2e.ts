/**
 * Today until onboarding is complete: a setup card with how many of the steps that apply are
 * done and Continue to the step to resume at, which is how the owner gets into onboarding after
 * first sign-in and back into it after a reload. The card is server-rendered and fails soft: a
 * read that fails is one statement with Try again, never a 500. Once it is complete, Today offers
 * to build the program, with no week until there is one (v2/06b); the goals and schedule live in
 * Profile. This week (v2/06a: moved from Today to the top of Progress) is sessions,
 * training load and distance from Monday to today against the same days last week (no data yet
 * before the first session, 0 for an empty week after it, a designed error with Retry when the
 * read fails). Serial (one test at a time, after the functional suites): every test starts from a blank
 * training profile, which every browser and worker shares, and the last one leaves it blank again.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { DESKTOP, expectMainCentred, expectNoSideScroll, tokenPx } from './desktop';
import {
	captureScreen,
	gotoHydrated,
	profileAction,
	query,
	resetTrainingProfile,
	SAME_ORIGIN,
	trackConsoleErrors
} from './support';
import { seedAnalytics } from './analytics-support';

const card = (page: Page) => page.getByTestId('today-setup');
const count = (page: Page) => page.getByTestId('today-setup-count');
const cta = (page: Page) => page.getByTestId('today-setup-continue');

/** The onboarding step's editor has loaded in place of its skeleton. */
async function stepReady(page: Page, step: string) {
	await expect(page.locator(`.step[data-step="${step}"]`)).toBeVisible();
	await expect(page.getByTestId('section-editor')).toHaveAttribute('aria-busy', 'false');
}

async function continueTo(page: Page, step: string) {
	await page.getByTestId('step-continue').click();
	await expect(page).toHaveURL(`/onboarding/${step}`);
	await stepReady(page, step);
}

/** The device's date `days` from now, as a stored calendar date (the browser shares its zone). */
function inDays(days: number): string {
	const d = new Date();
	d.setDate(d.getDate() + days);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A fight ten weeks out (ranked first), a marathon three weeks out, and a strength goal. */
const FIGHT = {
	kind: 'event',
	title: 'First Muay Thai fight',
	disciplines: ['muay_thai'],
	eventType: 'Muay Thai fight',
	eventDate: inDays(70)
};
const MARATHON = {
	kind: 'event',
	title: 'Valencia marathon',
	disciplines: ['distance_running', 'custom'],
	customDiscipline: 'Hill repeats',
	eventType: 'Marathon',
	eventDate: inDays(24)
};
const STRENGTH = {
	kind: 'general',
	title: 'Keep my strength',
	disciplines: ['strength'],
	focus: 'Hold squat and deadlift',
	measure: 'Top sets at RPE 8 stay within 5%'
};

/** Onboarding finished through the app's own actions: goals, schedule, then Finish on review. */
async function setUp(request: APIRequestContext) {
	for (const goal of [FIGHT, MARATHON, STRENGTH]) {
		await profileAction(request, '/profile/goals?/saveGoal', goal);
	}
	await profileAction(request, '/profile/schedule?/save', {
		daysPerWeek: 4,
		availableDays: ['mon', 'tue', 'thu', 'sat'],
		preferredTimes: [],
		sessionMinutes: 60,
		commitments: [
			{
				discipline: 'muay_thai',
				label: 'Muay Thai class',
				days: ['tue', 'thu'],
				timeOfDay: 'evening',
				durationMinutes: 90,
				intensity: 'hard'
			}
		]
	});
	const finish = await request.post('/onboarding/review?/complete', {
		headers: { ...SAME_ORIGIN, accept: 'application/json', 'x-sveltekit-action': 'true' },
		multipart: { payload: '{}' }
	});
	expect(await finish.json()).toMatchObject({ type: 'redirect', location: '/today' });
}

/** This week, on Progress. */
const thisWeek = (page: Page) => page.getByTestId('week-so-far');
const tiles = (page: Page) => thisWeek(page).getByTestId('week-stat');
const views = (page: Page) => page.getByRole('navigation', { name: 'Progress views' });

async function audit(page: Page) {
	await page.waitForFunction(() => document.fonts.status === 'loaded');
	await page.waitForTimeout(400);
	const { violations } = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.analyze();
	return violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
}

test.beforeEach(async () => {
	await resetTrainingProfile();
});

test.afterAll(async () => {
	await resetTrainingProfile();
});

test('from a blank profile Today starts setup, and after two steps resumes where it stopped, across a reload', async ({
	page
}, testInfo) => {
	test.setTimeout(90_000);
	const errors = trackConsoleErrors(page);
	await gotoHydrated(page, '/today');
	await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
	await expect(card(page).getByRole('heading', { level: 2 })).toHaveText(
		'Set up your training profile'
	);
	// No goal yet, so no running or Muay Thai specifics: 10 steps, review included.
	await expect(count(page)).toHaveText('0 of 10 steps done');
	await expect(cta(page)).toHaveText('Start setup');
	await expect(page.getByTestId('today-plan')).toHaveCount(0);
	await captureScreen(page, testInfo, 'today-setup');

	await cta(page).click();
	await expect(page).toHaveURL('/onboarding');
	await stepReady(page, 'welcome');
	await page.getByRole('textbox', { name: 'What should your coach call you?' }).fill('Niko');
	await page
		.getByRole('group', { name: 'Weights in' })
		.getByRole('radio', { name: 'Kilograms' })
		.check();
	await page
		.getByRole('group', { name: 'Distances in' })
		.getByRole('radio', { name: 'Kilometres' })
		.check();
	await continueTo(page, 'goals');

	await page.getByTestId('goal-path-event').click();
	const sheet = page.getByTestId('goal-sheet');
	await sheet.getByRole('textbox', { name: 'Goal', exact: true }).fill('First Muay Thai fight');
	await sheet.getByRole('checkbox', { name: 'Muay Thai' }).check();
	await sheet.getByRole('button', { name: 'Muay Thai fight', exact: true }).click();
	await sheet.getByLabel('Event date').fill('2027-03-14');
	await sheet.getByRole('button', { name: 'Save goal' }).click();
	await expect(sheet).toBeHidden();
	await continueTo(page, 'experience');

	// Finish later: Today now picks up from Experience, and counts the fight's specifics step.
	await page.getByTestId('finish-later').click();
	await expect(page).toHaveURL('/today');
	const resumed = async () => {
		await expect(card(page).getByRole('heading', { level: 2 })).toHaveText(
			'Finish setting up your profile'
		);
		await expect(count(page)).toHaveText('2 of 11 steps done');
		await expect(cta(page)).toHaveText('Continue: Experience');
		await expect(cta(page)).toHaveAttribute('href', '/onboarding/experience');
	};
	await resumed();
	await page.reload();
	await resumed();
	await captureScreen(page, testInfo, 'today-setup-resume');

	// Continue lands on Experience with nothing lost: the fight's discipline is there to rate.
	await cta(page).click();
	await expect(page).toHaveURL('/onboarding/experience');
	await stepReady(page, 'experience');
	await expect(page.getByTestId('experience-entry')).toHaveCount(1);
	await expect(page.getByTestId('experience-entry')).toContainText('Muay Thai');
	expect(
		await query(
			`select p.name, p.weight_unit, p.onboarding_completed, g.title
			   from athlete_profiles p join training_goals g using (owner_id)`
		)
	).toEqual([
		{
			name: 'Niko',
			weight_unit: 'kg',
			onboarding_completed: ['welcome', 'goals'],
			title: 'First Muay Thai fight'
		}
	]);
	expect(errors).toEqual([]);
});

test('once onboarding is complete, Today has no setup card: it offers to build the program', async ({
	page
}) => {
	await gotoHydrated(page, '/today');
	await expect(card(page)).toBeVisible();
	await query('update athlete_profiles set onboarding_completed_at = now()');
	await gotoHydrated(page, '/today');
	const build = page.getByTestId('today-build');
	await expect(build.getByRole('heading', { level: 2 })).toHaveText('Build my program');
	await expect(build).toContainText('Profile ready');
	await expect(page.getByTestId('today-build-cta')).toHaveText('Build my program');
	await expect(card(page)).toHaveCount(0);
});

test('once set up, Today offers the Build card alone; This week leads Progress', async ({
	page,
	request
}, testInfo) => {
	const errors = trackConsoleErrors(page);
	await setUp(request);
	await gotoHydrated(page, '/today');
	await expect(card(page)).toHaveCount(0);

	// The Build card alone: the goals and schedule are in Profile, This week on Progress.
	await expect(page.getByTestId('today-build')).toBeVisible();
	for (const gone of ['today-goals', 'today-schedule', 'today-side', 'today-week']) {
		await expect(page.getByTestId(gone)).toHaveCount(0);
	}
	// No week before a program (v2/06b): Paper's no-program Today draws none.
	await expect(page.getByRole('list', { name: 'This week' })).toHaveCount(0);
	await expect(page.getByTestId('week-dots')).toHaveCount(0);
	await expect(page.getByRole('link', { name: /Plate calculator/ })).toHaveCount(0);

	// On Progress, This week sits above the views: nothing logged yet, so no data yet.
	await gotoHydrated(page, '/progress');
	const week = (await thisWeek(page).boundingBox())!;
	expect(week.y + week.height).toBeLessThanOrEqual((await views(page).boundingBox())!.y);
	await expect(tiles(page)).toHaveText([
		/^Sessions\s*—\s*No data yet\s*$/,
		/^Training load\s*—\s*No data yet\s*$/,
		/^Distance\s*—\s*No data yet\s*$/
	]);
	await expect(thisWeek(page).getByTestId('week-context')).toHaveText(
		'Your week fills in as you log sessions.'
	);
	// The tiles carry no caption: no repeated 'this week', no 'AU'.
	expect((await tiles(page).allTextContents()).join(' ')).not.toMatch(/this week|\bAU\b/i);

	expect(await audit(page), 'dark').toEqual([]);
	await captureScreen(page, testInfo, 'progress-this-week-empty');
	await page.evaluate(() =>
		localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: 'light' }))
	);
	await gotoHydrated(page, '/progress');
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
	await expect(tiles(page)).toHaveCount(3);
	expect(await audit(page), 'light').toEqual([]);
	expect(errors).toEqual([]);
});

test('This week is server-rendered on Progress, so nothing moves after hydration', async ({
	page
}) => {
	// What the server-rendered page holds before any script runs, and where This week sits: once
	// hydrated, the same tiles are there and This week has not moved.
	await page.addInitScript(() => {
		const weekTop = () =>
			document.querySelector('[data-testid="week-so-far"]')!.getBoundingClientRect().top;
		document.addEventListener('DOMContentLoaded', () =>
			Object.assign(window, {
				__painted: {
					weekTop: weekTop(),
					tiles: document.querySelectorAll('[data-testid="week-stat"]').length
				}
			})
		);
		Object.assign(window, { __weekTop: weekTop });
	});
	await gotoHydrated(page, '/progress');
	await expect(tiles(page)).toHaveCount(3);
	type Measured = {
		__painted: { weekTop: number; tiles: number };
		__weekTop: () => number;
	};
	const painted = await page.evaluate(() => (window as unknown as Measured).__painted);
	expect(painted.tiles, 'This week in the server-rendered page').toBe(3);
	const now = await page.evaluate(() => (window as unknown as Measured).__weekTop());
	expect(Math.abs(now - painted.weekTop), 'This week does not move').toBeLessThanOrEqual(1);
});

test('once sessions are logged, This week shows real numbers for Monday to today, and explains training load', async ({
	page,
	request
}, testInfo) => {
	const errors = trackConsoleErrors(page);
	const seeded = await seedAnalytics(request, 'twelve-weeks');
	// The oracle: completed, undeleted workouts on the owner's days Monday to today, by SQL.
	const [week] = await query<{ sessions: number; load: number | null }>(
		`select count(*)::int as sessions,
			sum(coalesce(w.duration_s, r.duration_s, o.duration_minutes * 60)::float8 / 60
				* coalesce(w.session_rpe, r.rpe, o.rpe)::float8)::float8 as load
		   from workouts w
		   left join run_records r on r.workout_id = w.id
		   left join other_session_records o on o.workout_id = w.id
		  where w.status = 'completed' and w.deleted_at is null
		    and (w.started_at at time zone $1)::date between $2::date and $3::date`,
		[seeded.timeZone, seeded.weekStart, seeded.today]
	);
	await gotoHydrated(page, '/progress');
	await expect(tiles(page)).toHaveCount(3);
	const load = Math.round(week!.load ?? 0).toLocaleString('en-US');
	await expect(tiles(page).nth(0)).toHaveText(new RegExp(`^Sessions\\s*${week!.sessions}\\s*$`));
	await expect(tiles(page).nth(1)).toHaveText(new RegExp(`^Training load\\s*${load}\\s*$`));
	await expect(tiles(page).nth(2)).toHaveText(/^Distance\s*[\d,]+(\.\d)?\s*km\s*$/);
	await expect(thisWeek(page)).not.toContainText('No data yet');
	await expect(thisWeek(page).getByTestId('week-context')).toHaveText(
		/^(By \w+day last week: \d+ sessions?, (training load [\d,]+, )?[\d.,]+ km\.|Nothing logged by \w+day last week\.)$/
	);

	const how = thisWeek(page).getByText('How it’s worked out');
	const box = (await how.boundingBox())!;
	expect(box.height).toBeGreaterThanOrEqual(44);
	await how.click();
	await expect(thisWeek(page)).toContainText('minutes × its session RPE');
	expect(await audit(page), 'dark').toEqual([]);
	await captureScreen(page, testInfo, 'progress-this-week');
	await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
	expect(await audit(page), 'light').toEqual([]);
	expect(errors).toEqual([]);
});

test('a This week read that fails is a designed error with Retry, and Retry recovers', async ({
	page
}, testInfo) => {
	// The table This week reads runs from is out of reach while the screen loads.
	await query('alter table run_records rename to run_records_away');
	try {
		await gotoHydrated(page, '/progress');
		const failed = page.getByTestId('week-so-far-error');
		await expect(failed).toContainText('Couldn’t load this week’s numbers.');
		await expect(tiles(page)).toHaveCount(3);
		const retry = failed.getByRole('button', { name: 'Try again' });
		expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
		expect(await audit(page), 'dark').toEqual([]);
		await captureScreen(page, testInfo, 'progress-this-week-error');
	} finally {
		await query('alter table run_records_away rename to run_records');
	}
	await page.getByTestId('week-so-far-error').getByRole('button', { name: 'Try again' }).click();
	await expect(page.getByTestId('week-so-far-error')).toHaveCount(0);
	await expect(thisWeek(page).getByTestId('week-context')).toHaveText(
		'Your week fills in as you log sessions.'
	);
});

test('reordering goals in Profile saves the new order', async ({ page, request }) => {
	await setUp(request);
	await gotoHydrated(page, '/profile/goals');
	await expect(page.getByTestId('section-editor')).toHaveAttribute('aria-busy', 'false');
	await page.getByRole('button', { name: 'Move Valencia marathon up', exact: true }).click();
	await expect(page.getByTestId('goal-order-status')).toHaveText(
		'Valencia marathon is now priority 1 of 3'
	);
	await expect
		.poll(() => query<{ title: string }>('select title from training_goals order by priority'))
		.toEqual([
			{ title: 'Valencia marathon' },
			{ title: 'First Muay Thai fight' },
			{ title: 'Keep my strength' }
		]);
});

test('a setup read that fails is one statement with Try again inside the shell, which recovers', async ({
	page
}, testInfo) => {
	await gotoHydrated(page, '/today');
	await expect(card(page)).toBeVisible();
	const before = await query<{ n: number }>(
		`select count(*)::int as n from app_errors where context->>'load' = 'todaySetup'`
	);
	// The table the read needs is out of reach while the screen loads (renamed, then restored).
	await query('alter table athlete_profiles rename to athlete_profiles_away');
	try {
		await page.reload();
		const failed = page.getByTestId('today-setup-error');
		await expect(failed.getByRole('heading', { level: 2 })).toHaveText('Couldn’t load today');
		await expect(failed).toContainText('Your profile is safe.');
		await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
		await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
		await expect(page.locator('body')).not.toContainText(/500|internal error/i);
		await expect(card(page)).toHaveCount(0);
		const retry = failed.getByRole('button', { name: 'Try again' });
		const target = (await retry.boundingBox())!;
		expect(target.height).toBeGreaterThanOrEqual(44);
		await captureScreen(page, testInfo, 'today-setup-error');
		expect(
			await query<{ n: number }>(
				`select count(*)::int as n from app_errors where context->>'load' = 'todaySetup'`
			)
		).toEqual([{ n: before[0]!.n + 1 }]);
	} finally {
		await query('alter table athlete_profiles_away rename to athlete_profiles');
	}
	await page.getByTestId('today-setup-error').getByRole('button', { name: 'Try again' }).click();
	await expect(count(page)).toHaveText('0 of 10 steps done');
	await expect(page.getByTestId('today-setup-error')).toHaveCount(0);
});

test.describe('in a desktop window', () => {
	test.use(DESKTOP);

	test('the setup card sits in the readable column, and its Continue has a hover state', async ({
		page
	}, testInfo) => {
		await gotoHydrated(page, '/today');
		await expect(card(page)).toBeVisible();
		await expectMainCentred(page, await tokenPx(page, '--content-readable'));
		await expectNoSideScroll(page);
		const main = (await page.locator('main#main').boundingBox())!;
		const box = (await card(page).boundingBox())!;
		expect(box.x).toBeGreaterThanOrEqual(main.x - 1);
		expect(box.x + box.width).toBeLessThanOrEqual(main.x + main.width + 1);
		const background = () => cta(page).evaluate((el) => getComputedStyle(el).backgroundColor);
		const resting = await background();
		await cta(page).hover();
		await expect.poll(background).not.toBe(resting);
		await captureScreen(page, testInfo, 'today-setup-desktop');
	});
});
