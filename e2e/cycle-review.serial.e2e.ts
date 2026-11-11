/**
 * The cycle review (src/routes/(app)/progress/reviews/[[key]]/CycleReview.svelte), on block-end:
 * - Create from the list: the running block is not reviewable yet (week-almost-complete, with
 *   when and why); the finished block's Create is busy while it posts, a second tap posts nothing,
 *   and it opens /progress/reviews/c-<id>
 * - each lift's estimated 1RM change over the block equals the strength oracle over the block's
 *   dates; planned against achieved hard sets per group equal the hard-set oracle and the stored
 *   snapshot; the block's planned, completed, skipped and missed sessions equal the adherence oracle
 * - the effectiveness table says each exercise's stored words, leading to Keep or Rotate
 * - an earlier cycle's link opens that review, read-only
 * - without JavaScript, /progress/reviews/c-<id> shows goal progress, the figures and each
 *   chart's table twin with the oracle values
 * - axe in both themes, and the screens at 393 × 659 and 1440 × 900
 *
 * Serial: the history is the one owner's, which every browser and worker shares.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { METRICS } from '../src/lib/domain/analytics/metrics';
import { addDays } from '../src/lib/domain/calendar';
import { DESKTOP, expectNoSideScroll } from './desktop';
import { adherence } from './oracles/general';
import { cycleReviews } from './oracles/reviews';
import { e1rmChange, hardSetsByGroup } from './oracles/strength';
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
const NOT_REVIEWABLE =
	'Your cycle review is ready once the block ends, or once its last week is done';

const cycleCreate = (page: Page) =>
	page.locator('[data-testid="review-create"]:has(input[name="blockLineage"])');
const isCreateCycle = (url: URL) => url.pathname === LIST && url.search === '?/createCycle';
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

interface StoredCycle {
	id: string;
	snapshot: {
		block: { from: string; to: string };
		volume: { group: string; planned: number | null; achieved: number }[];
		brief: { findings: { id: string; label: string; verdict: { words: string } }[] };
	};
}

/** The live review of the seeded block, read in SQL. */
async function stored(seeded: SeededReview): Promise<StoredCycle> {
	const lineage = seeded.review.kind === 'cycle' ? seeded.review.blockLineageId : '';
	const [row] = await query<StoredCycle>(
		`select id::text, snapshot from cycle_reviews
		where block_lineage_id = $1::uuid and superseded_at is null`,
		[lineage]
	);
	return row!;
}

let seeded: SeededReview;
const reviewUrl = async () => `${LIST}/c-${(await stored(seeded)).id}`;

/** The figures on the screen equal the oracles: lifts, hard sets and the block's sessions. */
async function expectFigures(page: Page) {
	const review = await stored(seeded);
	const { from, to } = review.snapshot.block;

	// Each lift's estimated 1RM over the block, its first and last session and the change.
	const lifts = Object.entries(seeded.exercises);
	expect(lifts.length, 'the block lifts').toBeGreaterThan(0);
	for (const [key, id] of lifts) {
		const oracle = await e1rmChange(key, from, to);
		const line = item(page, `progression:${id}`);
		if (!oracle) {
			await expect(line, key).toHaveCount(0);
			continue;
		}
		expect(await figure(line, 'First session'), key).toBeCloseTo(oracle.first, 1);
		expect(await figure(line, 'Last session'), key).toBeCloseTo(oracle.last, 1);
		expect(await figure(line, 'Change'), key).toBeCloseTo(oracle.change, 1);
	}

	// Hard sets per group: achieved over the block equals the oracle, planned the snapshot's.
	const weeks = (await hardSetsByGroup(to)).filter((w) => w.weekStart >= from && w.weekStart <= to);
	const groups = [...new Set(review.snapshot.volume.map((r) => r.group))];
	expect(groups.length, 'the block has hard sets').toBeGreaterThan(0);
	for (const group of groups) {
		const line = item(page, `volume:sets:${group}`);
		const achieved = weeks.filter((w) => w.group === group).reduce((n, w) => n + w.hardSets, 0);
		expect(await figure(line, 'Achieved'), group).toBeCloseTo(achieved, 1);
		const rows = review.snapshot.volume.filter((r) => r.group === group);
		if (rows.some((r) => r.planned !== null))
			expect(await figure(line, 'Planned'), group).toBeCloseTo(
				rows.reduce((n, r) => n + (r.planned ?? 0), 0),
				1
			);
	}

	// The block's sessions: planned, completed, skipped and missed.
	const oracle = await adherence(from, to, seeded.today);
	for (const label of ['planned', 'completed', 'skipped', 'missed'] as const) {
		const total = oracle.reduce((n, w) => n + w[label], 0);
		await expect(page.getByTestId(`review-count-${label}`), label).toHaveAttribute(
			'data-value',
			String(total)
		);
	}
}

/** The effectiveness table: each exercise's stored words, then Keep or Rotate. */
async function expectEffectiveness(page: Page) {
	const findings = (await stored(seeded)).snapshot.brief.findings.filter((f) =>
		f.id.startsWith('effectiveness:')
	);
	expect(findings.length, 'the block judged its exercises').toBeGreaterThan(0);
	const table = section(page, 'effectiveness').getByTestId('section-table');
	for (const f of findings) {
		const row = table.locator('tr', { has: page.locator('th[scope="row"]', { hasText: f.label }) });
		const cells = (await row.locator('td').allTextContents()).map((t) => t.trim());
		expect(cells[0], f.label).toBe(f.verdict.words);
		expect(cells[1], f.label).toMatch(/^(Keep|Rotate)\b/);
	}
}

test.afterAll(async ({ request }) => {
	await resetReviews(request);
});

test('a running block: Create says when it is ready, and why', async ({ page, request }) => {
	await seedReview(request, 'week-almost-complete');
	await gotoHydrated(page, LIST);
	const form = cycleCreate(page);
	await expect(form).toHaveAttribute('data-state', 'in_progress');
	await form.getByRole('button').click();
	await expect(form.getByTestId('create-refused')).toContainText(NOT_REVIEWABLE);
	await expect(form.getByTestId('create-refused')).toContainText(/Ready \w{3} \d+ \w{3}/);
	expect(await query(`select id from cycle_reviews`)).toHaveLength(0);
});

test.describe('block-end', () => {
	test.beforeAll(async ({ request }) => {
		seeded = await seedReview(request, 'block-end');
	});

	test.describe('with requests held', () => {
		// page.route sees requests from a page the service worker controls only when it is blocked.
		test.use({ serviceWorkers: 'block' });

		test('Create is busy while it posts, a second tap posts nothing, and it opens the review', async ({
			page
		}) => {
			await gotoHydrated(page, LIST);
			let posts = 0;
			let release!: () => void;
			const held = new Promise<void>((resolve) => (release = resolve));
			await page.route(isCreateCycle, async (route) => {
				posts += 1;
				await held;
				await route.continue();
			});
			const form = cycleCreate(page);
			await expect(form).toHaveAttribute('data-state', 'due');
			const button = form.getByRole('button');
			await button.click();
			await expect(button).toHaveAttribute('aria-busy', 'true');
			await button.dispatchEvent('click');
			release();

			await expect(page.getByTestId('cycle-review')).toBeVisible();
			expect(posts).toBe(1);
			const lineage = seeded.review.kind === 'cycle' ? seeded.review.blockLineageId : '';
			const rows = await cycleReviews(lineage);
			expect(rows).toHaveLength(1);
			await expect(page).toHaveURL(new RegExp(`${LIST}/c-${rows[0]!.id}$`));
			await expect(page.getByTestId('review-summary')).toHaveText(rows[0]!.summary);
		});
	});

	test('its figures equal the oracles, and the effectiveness table leads to Keep or Rotate', async ({
		page
	}) => {
		await gotoHydrated(page, await reviewUrl());
		await expectFigures(page);
		await expectEffectiveness(page);
		await expect(section(page, 'goals')).toBeAttached();
		await expect(page.getByTestId('review-write-up')).toBeAttached();
	});

	test('an earlier cycle’s link opens that review, read-only', async ({ page }) => {
		const current = await stored(seeded);
		const { from, to } = current.snapshot.block;
		// An earlier block's review, written before M6: it reads as its summary alone.
		const [older] = await query<{ id: string }>(
			`insert into cycle_reviews (owner_id, program_id, block_lineage_id, snapshot, summary,
				block_starts_on, block_ends_on)
			select owner_id, program_id, gen_random_uuid(), '{}'::jsonb, 'An earlier block.',
				$2::date, $3::date
			from cycle_reviews where id = $1::uuid returning id::text`,
			[current.id, addDays(from, -28), addDays(to, -28)]
		);
		await gotoHydrated(page, await reviewUrl());
		const link = page.getByTestId('earlier-cycles').getByTestId('review-row');
		await expect(link).toHaveCount(1);
		await link.click();
		await expect(page).toHaveURL(new RegExp(`${LIST}/c-${older!.id}$`));
		const review = page.getByTestId('cycle-review');
		await expect(review.getByTestId('review-summary')).toHaveText('An earlier block.');
		await expect(review.locator('form, button')).toHaveCount(0);
	});

	test.describe('without JavaScript', () => {
		test.use({ ...DESKTOP, javaScriptEnabled: false });

		test('the server renders goal progress, the figures and each chart’s table twin', async ({
			page
		}) => {
			await page.goto(await reviewUrl());
			await expect(section(page, 'goals').getByTestId('section-verdict')).not.toBeEmpty();
			await expectFigures(page);
			await expectEffectiveness(page);
			// Each lift's chart: its table twin, the first and last session in the profile's kg.
			const { from, to } = (await stored(seeded)).snapshot.block;
			const strength = section(page, 'strength');
			for (const key of Object.keys(seeded.exercises)) {
				const oracle = await e1rmChange(key, from, to);
				if (!oracle) continue;
				const twin = strength.getByTestId('chart-table').filter({ hasText: 'estimated 1RM' });
				await expect(twin.first()).toBeAttached();
				const cells = await strength.getByTestId('chart-table').locator('td').allTextContents();
				expect(cells.map((c) => parseFloat(c))).toEqual(
					expect.arrayContaining([
						Math.round(oracle.first * 10) / 10,
						Math.round(oracle.last * 10) / 10
					])
				);
			}
			const volume = section(page, 'volume').getByTestId('chart-table');
			await expect(volume).toContainText('Hard sets a week by muscle group');
		});
	});

	test('on a phone: sections collapse to their verdicts; axe is clean and the screen captured', async ({
		page
	}, testInfo) => {
		await page.setViewportSize({ width: 393, height: 659 });
		await gotoHydrated(page, await reviewUrl());
		await expect(page.getByTestId('cycle-review')).toBeVisible();
		await expect(section(page, 'fatigue').getByTestId('section-verdict')).toBeVisible();
		await expect(item(page, 'fatigue')).toBeHidden();
		await expectNoSideScroll(page);
		await auditBothThemes(page, 'Cycle review');
		await captureScreen(page, testInfo, 'cycle-review-phone');

		await section(page, 'strength').locator('summary').click();
		await expect(section(page, 'strength').getByTestId('line-chart').first()).toBeVisible();
		await auditBothThemes(page, 'Cycle review, a section open');
	});

	test.describe('in a desktop window', () => {
		test.use({ ...DESKTOP });

		test('the list beside the review, every section in full, nothing scrolls sideways', async ({
			page
		}, testInfo) => {
			await gotoHydrated(page, await reviewUrl());
			for (const id of ['goals', 'strength', 'endurance', 'fatigue', 'volume', 'effectiveness'])
				await expect(section(page, id), id).toBeVisible();
			// The ACWR, when the block had enough history for one, carries its caveat in view.
			if (await item(page, 'fatigue:acwr').count())
				await expect(item(page, 'fatigue:acwr')).toContainText(METRICS.acwr.caveat!);
			await expect(section(page, 'volume').getByTestId('range-chart')).toBeVisible();
			const cycles = page.getByRole('list', { name: 'Cycle reviews' });
			await expect(cycles.locator('[aria-current="page"]')).toHaveCount(1);
			await expectNoSideScroll(page);
			await auditBothThemes(page, 'Cycle review, desktop');
			await captureScreen(page, testInfo, 'cycle-review-desktop');
		});
	});
});
