/**
 * Progress → General (src/routes/(app)/progress/GeneralView.svelte), server-rendered from the
 * general service. On the twelve-weeks history the adherence rate, its counts and each week's
 * rate, the sessions and minutes of each discipline by week, the weekly load and Muay Thai's
 * sessions and rounds equal the SQL oracles (e2e/oracles/general.ts); the acute:chronic caveat
 * is visible; the load legend names every series in the one stack order and strength never
 * touches Muay Thai without the surface gap; a note with markup prints as text; period links keep
 * the view; no plan and a first week are told what appears and when; axe is clean in both themes
 * on a phone and in a desktop window, with and without JavaScript.
 *
 * Serial: the history is the one owner's, which every browser and worker shares.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { addDays } from '../src/lib/domain/calendar';
import {
	ANALYTICS_TZ,
	auditBothThemes,
	query,
	resetAnalytics,
	seedAnalytics,
	type SeededAnalytics
} from './analytics-support';
import { barBody, barMarks } from './charts';
import { DESKTOP, boxOf, expectNoSideScroll } from './desktop';
import { adherence, disciplineWeeks, muayThaiWeeks, weeklyLoad } from './oracles/general';
import { captureScreen, gotoHydrated } from './support';

test.use({ timezoneId: ANALYTICS_TZ });
test.describe.configure({ mode: 'serial' });

const GENERAL = '/progress?view=general';
/** The fixture's note, and what replaces it to prove notes print as text. */
const NOTE = 'Legs heavy after the long run';
const MARKUP = '<b>Legs</b> heavy <img src=x onerror="document.title=1">';

/** A discipline's column in the stacked charts: its colour group's name. */
const COLUMN: Record<string, string> = {
	strength: 'Strength',
	powerlifting: 'Strength',
	weightlifting: 'Strength',
	hypertrophy: 'Hypertrophy',
	running: 'Running',
	distance_running: 'Running',
	muay_thai: 'Muay Thai',
	athletic: 'Conditioning',
	custom: 'Conditioning'
};

const periodLink = (page: Page, name: string) =>
	page.getByRole('navigation', { name: 'Period', exact: true }).getByRole('link', { name });
const tableOf = (page: Page, id: string) => page.getByTestId(id).getByTestId('chart-table');
const valueOf = async (locator: Locator) => Number(await locator.getAttribute('data-value'));

/** The period's complete weeks' Mondays, then this week's. */
const mondaysOf = (seeded: SeededAnalytics, weeks: number) =>
	Array.from({ length: weeks + 1 }, (_, i) => addDays(seeded.weekStart, -7 * (weeks - i)));

/** A table twin's cells by column header ('Strength'), a row a week; '—' is null. */
async function cells(page: Page, id: string): Promise<Record<string, (number | null)[]>> {
	const table = tableOf(page, id);
	const headers = (await table.locator('thead th').allTextContents()).slice(1);
	const rows = await table
		.locator('tbody tr')
		.evaluateAll((trs) =>
			trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent!.trim()))
		);
	return Object.fromEntries(
		headers.map((header, c) => [
			header.replace(/\s*\(.*\)$/, '').trim(),
			rows.map((row) => (row[c]!.startsWith('—') ? null : Number(row[c]!.replace(/,/g, ''))))
		])
	);
}

/** Adherence: the tile's rate, the period's counts and each week's rate, from the oracle. */
async function expectAdherence(page: Page, seeded: SeededAnalytics, weeks: number) {
	const mondays = mondaysOf(seeded, weeks);
	const oracle = await adherence(mondays[0]!, addDays(seeded.weekStart, -1), seeded.today);
	const sum = (key: 'completed' | 'skipped' | 'missed' | 'extra') =>
		oracle.reduce((total, w) => total + w[key], 0);
	const due = sum('completed') + sum('skipped') + sum('missed');
	expect(await valueOf(page.getByTestId('tile-adherence'))).toBeCloseTo(
		(sum('completed') * 100) / due,
		1
	);
	const counts = page.getByTestId('adherence-counts');
	for (const key of ['completed', 'skipped', 'missed', 'extra'] as const)
		expect(await valueOf(counts.locator(`[data-key="${key}"]`)), key).toBe(sum(key));

	const rates = (await cells(page, 'chart-adherence'))['Adherence']!;
	expect(rates).toHaveLength(weeks + 1);
	for (const [i, monday] of mondays.slice(0, -1).entries()) {
		const pct = oracle.find((w) => w.weekStart === monday)?.pct ?? null;
		if (pct === null) expect(rates[i], `week of ${monday}`).toBeNull();
		else expect(Math.abs(rates[i]! - pct), `week of ${monday}`).toBeLessThanOrEqual(0.5);
	}
}

/** Sessions and minutes by discipline, a row a week (this week so far last), from the oracle. */
async function expectDisciplines(page: Page, seeded: SeededAnalytics, weeks: number) {
	const mondays = mondaysOf(seeded, weeks);
	const oracle = await disciplineWeeks(seeded.today);
	const [sessions, minutes] = [
		await cells(page, 'chart-sessions'),
		await cells(page, 'chart-time')
	];
	for (const [i, monday] of mondays.entries()) {
		const theirs = oracle.filter((w) => w.weekStart === monday);
		const by = (key: 'sessions' | 'minutes') => {
			const out: Record<string, number> = {};
			for (const w of theirs)
				out[COLUMN[w.discipline]!] = (out[COLUMN[w.discipline]!] ?? 0) + w[key];
			return out;
		};
		for (const [column, count] of Object.entries(by('sessions')))
			expect(sessions[column]?.[i] ?? 0, `${column} sessions, week of ${monday}`).toBe(count);
		for (const [column, total] of Object.entries(by('minutes')))
			expect(
				Math.abs((minutes[column]?.[i] ?? 0) - total),
				`${column} minutes, week of ${monday}`
			).toBeLessThanOrEqual(0.5);
	}
}

/** Each week's session-RPE load, the stack's total, from the oracle. */
async function expectLoad(page: Page, seeded: SeededAnalytics, weeks: number) {
	const mondays = mondaysOf(seeded, weeks);
	const oracle = await weeklyLoad(seeded.today);
	const totals = (await cells(page, 'chart-load'))['Total']!;
	for (const [i, monday] of mondays.entries()) {
		const au = oracle.find((w) => w.weekStart === monday)?.loadAu ?? 0;
		expect(Math.abs((totals[i] ?? 0) - au), `load, week of ${monday}`).toBeLessThanOrEqual(0.1);
	}
}

/** Muay Thai's sessions and rounds (sparring included) over the period's complete weeks. */
async function expectMuayThai(page: Page, seeded: SeededAnalytics, weeks: number) {
	const complete = new Set(mondaysOf(seeded, weeks).slice(0, -1));
	const oracle = (await muayThaiWeeks(seeded.today)).filter((w) => complete.has(w.weekStart));
	const count = (key: string) =>
		valueOf(page.getByTestId('mt-count').and(page.locator(`[data-key="${key}"]`)));
	expect(await count('sessions')).toBe(oracle.reduce((n, w) => n + w.sessions, 0));
	expect(await count('rounds')).toBe(oracle.reduce((n, w) => n + w.rounds + w.sparringRounds, 0));
	expect(await count('minutes')).toBeCloseTo(
		oracle.reduce((n, w) => n + w.minutes, 0),
		6
	);
}

async function expectFigures(page: Page, seeded: SeededAnalytics, weeks: number) {
	await expectAdherence(page, seeded, weeks);
	await expectDisciplines(page, seeded, weeks);
	await expectLoad(page, seeded, weeks);
	await expectMuayThai(page, seeded, weeks);
}

test.describe('twelve weeks', () => {
	let seeded: SeededAnalytics;

	test.beforeAll(async ({ request }) => {
		seeded = await seedAnalytics(request, 'twelve-weeks');
	});

	test('adherence, sessions and minutes by discipline, load and Muay Thai equal the oracles', async ({
		page
	}) => {
		await gotoHydrated(page, '/progress');
		await page
			.getByRole('navigation', { name: 'Progress views' })
			.getByRole('link', { name: 'General' })
			.click();
		await expect(page).toHaveURL(/\/progress\?view=general$/);
		await expect(page.getByTestId('general')).toHaveAttribute('data-stage', 'history');
		await expectFigures(page, seeded, 12);
		await expect(page.getByTestId('adherence-so-far')).toContainText('This week so far:');
	});

	test('the acute:chronic ratio carries its caveat in words, with today’s ratio', async ({
		page
	}) => {
		await gotoHydrated(page, GENERAL);
		await expect(page.getByTestId('acwr-caveat')).toBeVisible();
		await expect(page.getByTestId('acwr-caveat')).toContainText('not an injury predictor');
		await expect(page.getByTestId('acwr-caveat')).toContainText('rules of thumb');
		expect(await valueOf(page.getByTestId('acwr-current'))).toBeGreaterThan(0);
		await expect(page.getByTestId('chart-acwr')).toContainText('Typical range shaded');
	});

	test('the load legend names every series in the one order, and strength never touches Muay Thai', async ({
		page
	}) => {
		await gotoHydrated(page, GENERAL);
		await page.getByTestId('chart-load').scrollIntoViewIfNeeded();
		const legend = barBody(page, 'chart-load').getByTestId('bar-legend').locator('li');
		await expect(legend).toHaveText(['Strength', 'Muay Thai', 'Running', 'So far']);
		const stacks = await barMarks(page, 'chart-load').evaluateAll((els) => {
			const bySlot = new Map<string, { key: string; top: number; bottom: number }[]>();
			for (const el of els) {
				const { top, bottom } = el.getBoundingClientRect();
				const slot = el.getAttribute('data-slot')!;
				const part = { key: el.getAttribute('data-series')!, top, bottom };
				bySlot.set(slot, [...(bySlot.get(slot) ?? []), part]);
			}
			// From the baseline up: the lowest part has the largest bottom on screen.
			return [...bySlot.values()].map((parts) => parts.sort((a, b) => b.bottom - a.bottom));
		});
		expect(stacks.length).toBeGreaterThan(0);
		const order = ['strength', 'hypertrophy', 'conditioning', 'combat', 'running'];
		for (const stack of stacks) {
			const keys = stack.map((part) => part.key);
			expect(keys).toEqual(order.filter((key) => keys.includes(key)));
			// Where strength and Muay Thai meet, the 2 px surface gap and their labels part them.
			stack.slice(1).forEach((upper, i) => {
				const lower = stack[i]!;
				if ([lower.key, upper.key].sort().join() !== 'combat,strength') return;
				expect(lower.top - upper.bottom, 'gap between strength and Muay Thai').toBeGreaterThan(1.5);
			});
		}
		await expect(
			barMarks(page, 'chart-load').and(page.locator('[data-series="combat"]')).first()
		).toHaveAttribute('aria-label', /Muay Thai/);
	});

	test('a note with markup prints as text, never as markup', async ({ page }) => {
		await query(`update recovery_notes set note = $1 where note = $2`, [MARKUP, NOTE]);
		try {
			await gotoHydrated(page, GENERAL);
			const note = page.getByTestId('recovery-note').filter({ hasText: 'heavy' });
			await expect(note).toContainText(MARKUP);
			await expect(note.locator('b, img')).toHaveCount(0);
			await expect(page).not.toHaveTitle('1');
		} finally {
			await query(`update recovery_notes set note = $1 where note = $2`, [NOTE, MARKUP]);
		}
	});

	test('a period link keeps the view and the figures follow', async ({ page }) => {
		await gotoHydrated(page, GENERAL);
		await periodLink(page, 'Last 4 weeks').click();
		await expect(page).toHaveURL(/\/progress\?view=general&period=4w$/);
		await expect(page.getByTestId('period-content')).toHaveAttribute('aria-busy', 'false');
		await expectFigures(page, seeded, 4);

		await page.goBack();
		await expect(page).toHaveURL(/\/progress\?view=general$/);
		await expectAdherence(page, seeded, 12);
	});

	test('axe is clean in both themes; the phone screen is captured, and 320 px fits', async ({
		page
	}, testInfo) => {
		await page.setViewportSize({ width: 393, height: 659 });
		await gotoHydrated(page, GENERAL);
		await auditBothThemes(page, 'Progress general');
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'progress-general-phone');
		await page.setViewportSize({ width: 320, height: 640 });
		await expectNoSideScroll(page);
	});

	test.describe('in a desktop window', () => {
		test.use({ ...DESKTOP });

		test('sessions and training time share a row, and so do the ratio and its tiles', async ({
			page
		}, testInfo) => {
			await gotoHydrated(page, GENERAL);
			const [sessions, time] = [
				await boxOf(page.getByTestId('general-sessions')),
				await boxOf(page.getByTestId('general-time'))
			];
			expect(Math.abs(sessions.y - time.y), 'sessions and time share a row').toBeLessThan(1);
			const [ratio, monotony] = [
				await boxOf(page.getByTestId('acwr-caveat')),
				await boxOf(page.getByTestId('tile-monotony'))
			];
			expect(monotony.x, 'the tiles sit beside the ratio').toBeGreaterThan(ratio.x + ratio.width);
			await expectNoSideScroll(page);
			await auditBothThemes(page, 'Progress general, desktop');
			await captureScreen(page, testInfo, 'progress-general-desktop');
		});
	});

	test.describe('without JavaScript', () => {
		test.use({ javaScriptEnabled: false });

		test('the server renders the figures and the table twins hold the oracle values', async ({
			page
		}) => {
			await page.goto(GENERAL);
			await expectFigures(page, seeded, 12);
			await expect(page.getByTestId('acwr-caveat')).toBeVisible();
			await expect(page.getByTestId('chart-load').getByTestId('chart-no-js')).toHaveText(
				'Chart needs JavaScript'
			);
			await periodLink(page, 'Last 4 weeks').click();
			await expect(page).toHaveURL(/\/progress\?view=general&period=4w$/);
			await expectAdherence(page, seeded, 4);
		});
	});
});

test.describe('before any history', () => {
	test.afterAll(async () => {
		await resetAnalytics();
	});

	test('with no plan: what appears and when, and no chart', async ({ page, request }) => {
		await seedAnalytics(request, 'new-user');
		await gotoHydrated(page, GENERAL);
		await expect(page.getByTestId('general')).toHaveAttribute('data-stage', 'new');
		await expect(
			page.getByRole('heading', { name: 'Your training trends start with your first session' })
		).toBeVisible();
		await expect(page.getByTestId('general-no-plan')).toContainText('Adherence needs a plan');
		await expect(page.getByTestId('chart-plot')).toHaveCount(0);
		await auditBothThemes(page, 'Progress general, no plan');
	});

	test('in the first week: the week so far, and no chart', async ({ page, request }) => {
		const seeded = await seedAnalytics(request, 'first-week');
		await gotoHydrated(page, GENERAL);
		await expect(page.getByTestId('chart-plot')).toHaveCount(0);
		const view = page.getByTestId('general');
		// The fixture logs up to yesterday: on a Monday nothing is logged yet.
		if (seeded.today === seeded.weekStart) {
			await expect(view).toHaveAttribute('data-stage', 'new');
			return;
		}
		await expect(view).toHaveAttribute('data-stage', 'first_week');
		await expect(
			page.getByRole('heading', { name: 'Your first week of training is under way' })
		).toBeVisible();
		await expect(page.getByTestId('tile-sessions').getByTestId('so-far')).toContainText(
			'This week so far:'
		);
		await expect(page.getByTestId('adherence-so-far')).toContainText('done');
		await auditBothThemes(page, 'Progress general, first week');
	});
});
