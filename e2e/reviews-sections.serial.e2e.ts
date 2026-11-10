/**
 * The weekly review's sections (src/routes/(app)/progress/reviews/[[key]]/ReviewSections.svelte)
 * on week-complete, the hard week: tonnage, hard sets per group, mileage against the week before,
 * average RPE, RPE against target per lift, and Muay Thai sessions, minutes and rounds equal the
 * SQL oracles; each conflict of the hard sparring's week shows its why. An edit to a logged set
 * makes the review out of date, and Refresh (busy while it posts) writes its next revision, both
 * rows kept.
 * On a phone each section collapses to its verdict line and opens on a tap; in a desktop window
 * every section shows in full. A chart whose frame fails to load says so, and Retry loads it.
 * Axe in both themes, and the screens at 393 × 659 and 1440 × 900.
 *
 * Serial: the history is the one owner's, which every browser and worker shares.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { addDays } from '../src/lib/domain/calendar';
import { INTERFERENCE_RULES } from '../src/lib/domain/programming/interference';
import { MUSCLE_GROUP_LABEL, type MuscleGroup } from '../src/lib/domain/training/vocabulary';
import { DESKTOP, expectNoSideScroll } from './desktop';
import { muayThaiWeeks } from './oracles/general';
import { liftRpe } from './oracles/review-rpe';
import { proposalChain, weeklyReviews } from './oracles/reviews';
import { weeklyRunning } from './oracles/running';
import { hardSetsByGroup, rpeSummary, weeklyTonnage } from './oracles/strength';
import {
	ANALYTICS_TZ,
	auditBothThemes,
	query,
	resetReviews,
	seedReview,
	type SeededReview
} from './review-support';
import { captureScreen, gotoHydrated } from './support';

test.use({ timezoneId: ANALYTICS_TZ });
test.describe.configure({ mode: 'serial' });

const LIST = '/progress/reviews';

let seeded: SeededReview;
const weekOf = () => (seeded.review.kind === 'weekly' ? seeded.review.weekStartsOn : '');
const reviewUrl = () => `${LIST}/w-${weekOf()}`;

const section = (page: Page, id: string) =>
	page.locator(`[data-testid="review-section"][data-section="${id}"]`);
const item = (page: Page, id: string) =>
	page.locator(`[data-testid="review-item"][data-id="${id}"]`);
/** A figure's canonical value (data-value), read whether or not its section is open. */
async function figure(scope: Locator, label: string): Promise<number> {
	const value = await scope.locator(`[data-label="${label}"]`).getAttribute('data-value');
	expect(value, label).not.toBeNull();
	return Number(value);
}
/** A chart's table-twin row by its label (server-rendered with its frame): its cells, as text. */
async function tableRow(scope: Locator, label: string): Promise<string[]> {
	const row = scope.getByTestId('chart-table').locator('tr', {
		has: scope.page().locator(`th[scope="row"]`, {
			hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
		})
	});
	await expect(row, label).toHaveCount(1);
	return (await row.locator('td').allTextContents()).map((t) => t.trim());
}

/** Create the week's review from the list, and open it. */
async function createReview(page: Page) {
	await gotoHydrated(page, LIST);
	const form = page.locator(`[data-testid="review-create"]:has(input[value="${weekOf()}"])`);
	await form.getByRole('button').click();
	await expect(page).toHaveURL(new RegExp(`${reviewUrl()}$`));
}

test.beforeAll(async ({ request }) => {
	seeded = await seedReview(request, 'week-complete');
});

test.afterAll(async ({ request }) => {
	await resetReviews(request);
});

test('the sections’ figures equal the oracles', async ({ page }) => {
	await createReview(page);
	const week = weekOf();
	const sunday = addDays(week, 6);
	const before = addDays(week, -7);

	// Volume: tonnage this week and the week before, and hard sets per group.
	const tonnage = await weeklyTonnage(seeded.today);
	const kgOf = (start: string) => tonnage.find((w) => w.weekStart === start)?.tonnageKg ?? 0;
	const volume = item(page, 'volume:tonnage');
	expect(await figure(volume, 'This week')).toBeCloseTo(kgOf(week), 1);
	expect(await figure(volume, 'The week before')).toBeCloseTo(kgOf(before), 1);
	const groups = (await hardSetsByGroup(seeded.today)).filter((g) => g.weekStart === week);
	expect(groups.length, 'the week has hard sets').toBeGreaterThan(0);
	for (const { group, hardSets } of groups) {
		const line = item(page, `volume:sets:${group}`);
		const done = (await line.count())
			? await figure(line, 'Done')
			: Number(
					(await tableRow(section(page, 'volume'), MUSCLE_GROUP_LABEL[group as MuscleGroup]))[0]
				);
		expect(done, group).toBeCloseTo(hardSets, 1);
	}

	// Running: distance this week and the week before.
	const running = await weeklyRunning(seeded.today);
	const metresOf = (start: string) => running.find((w) => w.weekStart === start)?.metres ?? 0;
	const mileage = item(page, 'running:mileage');
	expect(await figure(mileage, 'Done')).toBeCloseTo(metresOf(week), 0);
	expect(await figure(mileage, 'The week before')).toBeCloseTo(metresOf(before), 0);

	// RPE: the week's average, and each lift's actual, target and difference.
	const rpe = await rpeSummary(week, sunday);
	expect(await figure(item(page, 'rpe:average'), 'Mean')).toBeCloseTo(rpe.meanRpe!, 1);
	const lifts = await liftRpe(week, sunday);
	expect(
		lifts.some((l) => l.deviation < 0),
		'bench under target'
	).toBe(true);
	for (const lift of lifts) {
		const [actual, target, difference, status] = await tableRow(section(page, 'rpe'), lift.name);
		expect(Number(actual), `${lift.key} actual`).toBeCloseTo(lift.actual, 1);
		expect(Number(target), `${lift.key} target`).toBeCloseTo(lift.target, 1);
		expect(Number(difference!.replace('−', '-')), `${lift.key} difference`).toBeCloseTo(
			lift.deviation,
			1
		);
		expect(status).toBe(
			lift.deviation < -0.5 ? 'Easier' : lift.deviation > 0.5 ? 'Harder' : 'On target'
		);
	}

	// Muay Thai: sessions, minutes and rounds.
	const thai = (await muayThaiWeeks(seeded.today)).find((w) => w.weekStart === week)!;
	const load = item(page, 'muay_thai:load');
	expect(await figure(load, 'Sessions')).toBe(thai.sessions);
	expect((await figure(load, 'Time')) / 60).toBeCloseTo(thai.minutes, 1);
	expect(await figure(load, 'Rounds')).toBe(thai.rounds + thai.sparringRounds);
});

test('the hard sparring’s conflict shows its why', async ({ page }) => {
	await gotoHydrated(page, reviewUrl());
	const conflicts = section(page, 'conflicts');
	// The week as performed: heavy squats on Monday before Tuesday's hard class, and Thursday's
	// heavy deadlifts before Friday's hard sparring. Its five hard days have room for three apart
	// (Tuesday's class is a commitment), so hard_days_apart leaves Saturday's long run alone.
	await expect(conflicts.getByTestId('review-item')).toHaveCount(2);
	const rows = [
		[
			'conflicts:1:heavy_lower_before_hard',
			'Strength A on Monday, then Muay Thai class on Tuesday'
		],
		['conflicts:2:heavy_lower_before_hard', 'Strength B on Thursday, then Sparring on Friday']
	] as const;
	for (const [id, where] of rows) {
		const rule = id.split(':')[2] as keyof typeof INTERFERENCE_RULES;
		await expect(item(page, id).getByTestId('item-words'), id).toHaveText(
			`${where}. ${INTERFERENCE_RULES[rule].why}`
		);
	}
	await expect(conflicts.getByTestId('section-verdict')).toContainText(/^2 conflicts: /);
});

test('on a phone each section collapses to its verdict line, and a tap opens it', async ({
	page
}, testInfo) => {
	await page.setViewportSize({ width: 393, height: 659 });
	await gotoHydrated(page, reviewUrl());
	const running = section(page, 'running');
	await expect(running.getByTestId('section-verdict')).toBeVisible();
	await expect(item(page, 'running:mileage')).toBeHidden();
	await expectNoSideScroll(page);
	await captureScreen(page, testInfo, 'review-sections-phone');

	await running.locator('summary').click();
	await expect(item(page, 'running:mileage')).toBeVisible();
	await section(page, 'volume').locator('summary').click();
	await expect(section(page, 'volume').getByTestId('chart-plot')).toBeVisible();
	await auditBothThemes(page, 'Weekly review sections');
});

test.describe('in a desktop window', () => {
	test.use({ ...DESKTOP });

	test('every section shows in full, nothing scrolls sideways', async ({ page }, testInfo) => {
		await gotoHydrated(page, reviewUrl());
		for (const id of ['rpe', 'volume', 'running', 'muay_thai', 'recovery', 'conflicts', 'prs'])
			await expect(section(page, id), id).toBeVisible();
		await expect(item(page, 'running:mileage')).toBeVisible();
		await expect(section(page, 'rpe').getByTestId('diverging-chart')).toBeVisible();
		await expect(section(page, 'volume').getByTestId('range-chart')).toBeVisible();
		await expectNoSideScroll(page);
		await auditBothThemes(page, 'Weekly review sections, desktop');
		await captureScreen(page, testInfo, 'review-sections-desktop');
	});
});

test.describe('a chart whose frame fails to load', () => {
	// page.route sees requests from a page the service worker controls only when it is blocked.
	test.use({ ...DESKTOP, serviceWorkers: 'block' });

	test('says so in its room, with Retry, and Retry loads it', async ({ page }) => {
		let failing = true;
		await page.route('**/_app/immutable/**/*.js', async (route) => {
			const response = await route.fetch().catch(() => null);
			if (!response) return route.abort('internetdisconnected');
			const body = await response.text();
			// ChartFrame's chunk: on this route only the lazily loaded chart frame reaches it.
			if (failing && body.includes('Loading chart…')) return route.abort('internetdisconnected');
			return route.fulfill({ response, body });
		});
		await gotoHydrated(page, reviewUrl());
		const rpe = section(page, 'rpe');
		const retry = rpe.getByRole('button', { name: 'Retry' });
		await expect(retry).toBeVisible();
		await expect(rpe).toContainText('Couldn’t load this chart.');
		await expect(rpe.locator('[aria-busy="true"]')).toHaveCount(0);

		failing = false;
		await retry.click();
		await expect(rpe.getByTestId('diverging-chart')).toBeVisible({ timeout: 15_000 });
		await expect(rpe.getByRole('button', { name: 'Retry' })).toHaveCount(0);
	});
});

test.describe('out of date', () => {
	// page.route sees requests from a page the service worker controls only when it is blocked.
	test.use({ serviceWorkers: 'block' });

	test('an edit to a logged set makes it stale; Refresh writes the next revision and keeps both', async ({
		page
	}) => {
		const week = weekOf();
		const [first] = await weeklyReviews(week);
		expect(first, 'created above').toBeDefined();
		// Edit one of the week's logged sets, as editing its RPE in History does.
		await query(
			`update set_records set rpe = 9, updated_at = now() where id = (
				select s.id from set_records s
				join workouts w on w.id = s.workout_id
				join athlete_profiles p on p.owner_id = s.owner_id
				where w.status = 'completed' and w.deleted_at is null and s.deleted_at is null
					and not s.is_warmup and not s.is_skipped
					and (s.performed_at at time zone p.time_zone)::date between $1::date and $2::date
				order by s.performed_at, s.id limit 1)`,
			[week, addDays(week, 6)]
		);

		await gotoHydrated(page, reviewUrl());
		const stale = page.getByTestId('review-stale');
		await expect(stale).toContainText('Computed before 1 later change');
		const refresh = stale.getByTestId('review-refresh');

		let posts = 0;
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		await page.route(
			(url) => url.pathname === reviewUrl() && url.search === '?/refresh',
			async (route) => {
				posts += 1;
				await held;
				await route.continue();
			}
		);
		await refresh.click();
		await expect(refresh).toHaveAttribute('aria-busy', 'true');
		await refresh.dispatchEvent('click');
		release();
		await expect(stale).toHaveCount(0);
		expect(posts).toBe(1);

		const rows = await weeklyReviews(week);
		expect(rows.map((r) => [r.revision, r.live])).toEqual([
			[1, false],
			[2, true]
		]);
		expect(rows[0]!.supersededBy).toBe(rows[1]!.id);
		if (rows[0]!.proposalId) {
			const { chain } = await proposalChain(rows[0]!.proposalId);
			expect(chain[0]).toMatchObject({
				status: 'superseded',
				supersededReason: 'review_refreshed'
			});
		}
		await expect(page.getByTestId('review-summary')).toHaveText(rows[1]!.summary);
	});
});
