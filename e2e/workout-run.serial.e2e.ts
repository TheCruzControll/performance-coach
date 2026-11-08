/**
 * Logging a run on /workout/run against the real server (sync 'real'): the fixture's interval
 * run, seeded as an ad-hoc workout, logged segment by segment with its pace worked out as typed,
 * restored by a reload, stored in Postgres with its totals; a correction after sync lands once
 * with one audit row; a refused segment is fixed from the sync sheet; an entry made offline
 * syncs once; and a run's workout opened at /workout lands here. Each test asserts only its own
 * workout's rows, by client id. Serial, with the other workout specs that write Postgres.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { RunKit, RunSegmentFields } from '../src/lib/domain/workout';
import { createMutation } from '../src/lib/domain/workout/mutations';
import { BELOW_DESKTOP_WIDTH, boxOf, DESKTOP, DESKTOP_WIDTHS, expectNoSideScroll } from './desktop';
import { captureScreen, query } from './support';
import {
	gotoWorkout,
	injectMutation,
	readOutbox,
	seedWorkout,
	workoutDay
} from './workout-support';

let kit: RunKit;
test.beforeAll(async () => {
	const { run } = await workoutDay();
	// Ad hoc: the fixture's planned session is not in this database.
	kit = { ...run, plannedLineage: null, plannedSessionId: null, programId: null };
});

const entry = (page: Page) => page.getByTestId('run-entry');
const heading = (page: Page) => entry(page).getByRole('heading', { level: 2 });
const rows = (page: Page) => page.getByTestId('run-segment');
const stepper = (page: Page, which: 'distance' | 'time') =>
	entry(page).getByTestId(`segment-${which}`).getByRole('spinbutton');
const pill = (page: Page) => page.getByTestId('sync-pill');
const synced = (page: Page) => expect.poll(() => readOutbox(page), { timeout: 15_000 }).toEqual([]);

async function type(field: Locator, text: string) {
	await field.click();
	await field.fill(text);
	await field.press('Enter');
}

/** Logs the segment on screen, typing what is given and keeping the rest of its prefill. */
async function logSegment(page: Page, values: { distance?: string; time?: string; hr?: string }) {
	if (values.distance) await type(stepper(page, 'distance'), values.distance);
	if (values.time) await type(stepper(page, 'time'), values.time);
	if (values.hr) await entry(page).getByTestId('segment-hr').fill(values.hr);
	const before = await heading(page).textContent();
	await entry(page).getByTestId('log-segment').click();
	return before;
}

/** Opens the run page against the real server, the store connected. */
async function open(page: Page) {
	await gotoWorkout(page, 'run', { sync: 'real' });
	await expect(page.locator('main#main[data-store]')).toBeAttached();
}

const runRow = async (workoutId: string) =>
	query<{ distance: number; duration: number; avg_hr: number | null; pace: number }>(
		`select r.distance_m::float8 as distance, r.duration_s as duration, r.avg_hr,
		        r.pace_s_per_km::float8 as pace
		   from run_records r join workouts w on w.id = r.workout_id where w.client_id = $1`,
		[workoutId]
	);

const segmentRows = async (workoutId: string) =>
	query<{
		id: string;
		row: string;
		position: number;
		distance: number | null;
		duration: number | null;
		avg_hr: number | null;
		pace: number | null;
	}>(
		`select s.client_mutation_id as id, s.id::text as row, s.position,
		        s.distance_m::float8 as distance, s.duration_s as duration, s.avg_hr,
		        s.pace_s_per_km::float8 as pace
		   from run_record_segments s join workouts w on w.id = s.workout_id
		  where w.client_id = $1 order by s.position`,
		[workoutId]
	);

/** axe in both themes: the page as it is, then in the light theme. */
async function audit(page: Page, what: string) {
	for (const theme of ['dark', 'light']) {
		await page.evaluate((t) => {
			if (t === 'light') document.documentElement.dataset.theme = t;
			else delete document.documentElement.dataset.theme;
		}, theme);
		await page.waitForFunction(() =>
			document
				.getAnimations()
				.every(
					(a) => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity
				)
		);
		const { violations } = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();
		const found = violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
		expect(found, `${what}, ${theme}`).toEqual([]);
	}
	await page.evaluate(() => delete document.documentElement.dataset.theme);
}

/** A segment's create, as another tab's dispatch would leave it in the outbox. */
const segmentOf = (workoutId: string, fields: RunSegmentFields) =>
	createMutation('run.segment', { workoutId, at: new Date().toISOString(), payload: fields });

const SEGMENT = { distanceMetres: null, avgHr: null, rpe: null } as const;

test.describe('logging a run', () => {
	test('the interval run segment by segment: pace as typed, a reload restores it, Postgres has the totals and 14 segments', async ({
		page
	}, testInfo) => {
		const workoutId = await seedWorkout(page, kit);
		await open(page);
		await expect(rows(page)).toHaveCount(14);
		await expect(heading(page)).toHaveText('Warm-up');
		await expect(entry(page)).toContainText('Segment 1 of 14');
		await expect(stepper(page, 'time')).toHaveValue('10:00');

		await logSegment(page, { distance: '1.8', hr: '135' });
		for (let round = 1; round <= 6; round++) {
			await expect(heading(page)).toHaveText(`Interval ${round} of 6`);
			if (round === 1) {
				// 400 m in 1:33, the middle of 3:45–4:00 /km, until the owner's own time.
				await expect(stepper(page, 'time')).toHaveValue('1:33');
				await expect(entry(page).getByTestId('segment-pace')).toContainText('3:53 /km');
				await stepper(page, 'time').click();
				await stepper(page, 'time').fill('1:29');
				// As typed, before Enter: the field still has the focus.
				await expect(entry(page).getByTestId('segment-pace')).toContainText('3:43 /km');
				await expect(stepper(page, 'time')).toBeFocused();
				await stepper(page, 'time').press('Enter');
				await expect(entry(page).getByTestId('segment-pace')).toContainText('3:43 /km');
			}
			// To the second, and round 4 as a phone's decimal keypad types it.
			await logSegment(page, { time: round === 4 ? '1.32' : `1:${28 + round}` });
			await expect(heading(page)).toHaveText(`Recovery ${round} of 6`);
			await logSegment(page, { distance: '0.2' });

			if (round === 3) {
				const shown = await rows(page).allTextContents();
				const totals = await page.getByTestId('run-totals').textContent();
				await page.reload();
				await expect(page.locator('main#main[data-ready]')).toBeAttached();
				await expect(heading(page)).toHaveText('Interval 4 of 6');
				expect(await rows(page).allTextContents()).toEqual(shown);
				await expect(page.getByTestId('run-totals')).toHaveText(totals!);
				await expect(page.locator('main#main[data-store]')).toBeAttached();
			}
		}
		await expect(heading(page)).toHaveText('Cool-down');
		await logSegment(page, { distance: '1.6' });
		await expect(rows(page).filter({ hasText: 'Done' })).toHaveCount(14);
		await expect(rows(page).nth(1)).toContainText('400 m · 1:29 · 3:43 /km');

		const totals = page.getByTestId('run-totals');
		await expect(totals).toContainText('7 km');
		await expect(totals).toContainText('38:09');
		await expect(totals).toContainText('5:27 /km');
		await expect(totals).toContainText('135 bpm');

		await synced(page);
		await expect(pill(page)).toHaveText('Saved');
		// 1.8 km + 6 × 400 m + 6 × 200 m + 1.6 km; 10:00 + 1:29…1:34 + 6 × 1:30 + 10:00.
		expect(await runRow(workoutId)).toEqual([
			{ distance: 7000, duration: 2289, avg_hr: 135, pace: 327 }
		]);
		const segments = await segmentRows(workoutId);
		expect(segments.map((s) => s.position)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
		for (const s of segments) {
			expect(s.pace, `segment ${s.position}'s pace`).toBeCloseTo(
				s.duration! / (s.distance! / 1000),
				2
			);
		}
		// Only the warm-up was given a heart rate: a blank one is stored as null.
		expect(segments.map((s) => s.avg_hr)).toEqual([135, ...Array.from({ length: 13 }, () => null)]);

		await captureScreen(page, testInfo, 'workout-run');
		await audit(page, 'the run');
	});

	test('pace in min/mi for a profile in miles, and the distance stored in metres', async ({
		page
	}) => {
		const workoutId = await seedWorkout(page, { ...kit, units: { ...kit.units, distance: 'mi' } });
		await open(page);
		await expect(rows(page).nth(1)).toContainText('0.25 mi · 6:02–6:26 /mi');
		await type(stepper(page, 'distance'), '1');
		await expect(entry(page).getByTestId('segment-pace')).toContainText('10:00 /mi');
		await logSegment(page, {});
		await expect(rows(page).first()).toContainText('1 mi · 10:00 · 10:00 /mi');

		await synced(page);
		const [warmUp] = await segmentRows(workoutId);
		expect(warmUp!.distance).toBeCloseTo(1609.344, 3);
		expect(warmUp!.pace).toBeCloseTo(600 / 1.609344, 2);
	});

	test('interval 3 corrected after it synced: the new value once, and one audit row for it', async ({
		page
	}) => {
		const workoutId = await seedWorkout(page, kit);
		const kinds = ['warm_up', 'interval', 'recovery', 'interval', 'recovery', 'interval'] as const;
		const created = kinds.map((kind, i) =>
			segmentOf(workoutId, {
				...SEGMENT,
				position: i + 1,
				kind,
				...(kind === 'interval'
					? { distanceMetres: 400, durationSeconds: 90 }
					: { durationSeconds: kind === 'warm_up' ? 600 : 90 })
			})
		);
		for (const m of created) await injectMutation(page, m);
		await open(page);
		await synced(page);

		await rows(page).nth(5).click();
		await expect(heading(page)).toHaveText('Interval 3 of 6');
		await expect(stepper(page, 'time')).toHaveValue('1:30');
		await type(stepper(page, 'time'), '1:25');
		await expect(entry(page).getByTestId('log-segment')).toHaveText('Save changes');
		await entry(page).getByTestId('log-segment').click();
		await expect(heading(page)).toHaveText('Interval 3 of 6');

		await synced(page);
		const third = (await segmentRows(workoutId)).filter((s) => s.id === created[5]!.id);
		expect(third).toEqual([expect.objectContaining({ duration: 85, pace: 212.5 })]);
		const audits = await query(
			`select 1 from training_audit where table_name = 'run_record_segments' and row_id = $1`,
			[third[0]!.row]
		);
		expect(audits).toHaveLength(1);
	});

	test('a refused segment: Fix opens it with the server’s error, and the corrected value lands once', async ({
		page
	}) => {
		const workoutId = await seedWorkout(page, kit);
		await open(page);
		await synced(page);
		const bad = segmentOf(workoutId, {
			...SEGMENT,
			position: 1,
			kind: 'warm_up',
			durationSeconds: 0
		});
		await injectMutation(page, bad);

		await expect(pill(page)).toHaveText('1 needs attention');
		await pill(page).click();
		const issue = page.getByTestId('sync-sheet').getByTestId('sync-issue');
		await expect(issue).toContainText('Run segment 1');
		await expect(issue).toContainText('Time: Up to a day');
		await issue.getByTestId('fix-change').click();

		const fix = page.getByTestId('run-fix');
		await expect(fix.getByTestId('fix-reason')).toHaveText('Not synced · Time: Up to a day');
		await audit(page, 'the Fix editor');
		await type(fix.getByTestId('segment-time').getByRole('spinbutton'), '10:00');
		await fix.getByTestId('save-fix').click();

		await synced(page);
		await expect(pill(page)).toHaveText('Saved');
		expect(await segmentRows(workoutId)).toEqual([
			expect.objectContaining({ id: bad.id, duration: 600 })
		]);
		// The run's totals follow the fixed segment.
		expect(await runRow(workoutId)).toEqual([expect.objectContaining({ duration: 600 })]);
		await page.reload();
		await expect(page.locator('main#main[data-ready]')).toBeAttached();
		await expect(page.getByTestId('run-totals')).toContainText('10:00');
	});

	test('at 150 % text the segment on screen still fits: nothing scrolls sideways', async ({
		page
	}) => {
		await seedWorkout(page, kit);
		await open(page);
		await page.evaluate(() => (document.documentElement.style.fontSize = '150%'));
		await expect(heading(page)).toHaveText('Warm-up');
		await expectNoSideScroll(page);
		const log = await boxOf(entry(page).getByTestId('log-segment'));
		expect(log.x + log.width).toBeLessThanOrEqual(page.viewportSize()!.width);
	});

	test('a run’s workout opened at /workout lands on /workout/run', async ({ page }) => {
		await seedWorkout(page, kit);
		await page.goto('/workout');
		await expect(page).toHaveURL(/\/workout\/run$/);
		await expect(heading(page)).toHaveText('Warm-up');
	});
});

test.describe('a run logged offline', () => {
	// Playwright emulates offline for service-worker traffic only in Chromium.
	test.skip(({ browserName }) => browserName !== 'chromium', 'offline emulation is Chromium-only');

	test('syncs once back online, and an offline reload restores it from the precache', async ({
		page,
		context
	}) => {
		await page.goto('/workout/run');
		await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
			timeout: 15_000
		});
		const workoutId = await seedWorkout(page, kit);
		await open(page);
		await synced(page);

		await context.setOffline(true);
		await page.waitForFunction(() => !navigator.onLine);
		await logSegment(page, { distance: '1.8' });
		await expect(pill(page)).toHaveText('Offline · 2 pending');

		await page.goto('/workout/run');
		await expect(page.locator('main#main[data-ready]')).toBeAttached();
		await expect(heading(page)).toHaveText('Interval 1 of 6');
		await expect(rows(page).first()).toContainText('1.8 km · 10:00');

		await context.setOffline(false);
		await synced(page);
		expect(await segmentRows(workoutId)).toEqual([
			expect.objectContaining({ position: 1, distance: 1800, duration: 600 })
		]);
	});
});

test.describe('on a desktop window', () => {
	test.use(DESKTOP);

	test('the segments sit beside the entry, nothing scrolls sideways, and it all works by keyboard', async ({
		page
	}, testInfo) => {
		await seedWorkout(page, kit);
		await open(page);

		const side = await boxOf(page.getByTestId('run-side'));
		const main = await boxOf(entry(page));
		expect(side.x + side.width, 'the segments end before the entry').toBeLessThan(main.x);
		expect(Math.abs(side.y - main.y), 'both start at the same height').toBeLessThanOrEqual(1);
		for (const width of [...DESKTOP_WIDTHS, BELOW_DESKTOP_WIDTH]) {
			await page.setViewportSize({ width, height: 900 });
			await expectNoSideScroll(page);
		}
		await page.setViewportSize(DESKTOP.viewport);

		// The time by keyboard: arrows nudge 1 s, PageDown a minute, and mm:ss typed.
		const time = stepper(page, 'time');
		await time.focus();
		await time.press('ArrowUp');
		await expect(time).toHaveAttribute('aria-valuenow', '601');
		await time.press('PageDown');
		await expect(time).toHaveAttribute('aria-valuenow', '541');
		await time.blur();
		await time.focus();
		await time.fill('9:30');
		await time.press('Enter');
		await expect(time).toHaveAttribute('aria-valuenow', '570');
		await entry(page).getByTestId('segment-hr').focus();
		await page.keyboard.type('140');
		await entry(page).getByTestId('log-segment').focus();
		await page.keyboard.press('Enter');
		await expect(heading(page)).toHaveText('Interval 1 of 6');
		await expect(rows(page).first()).toContainText('9:30 · 140 bpm');

		// The list: focus moves with the arrows, Enter makes a segment current.
		const first = rows(page).first();
		await first.focus();
		expect(await first.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('ArrowDown');
		await expect(rows(page).nth(2)).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(heading(page)).toHaveText('Recovery 1 of 6');
		await expect(rows(page).nth(2)).toHaveAttribute('aria-current', 'step');

		// Hover tints a row that is not current.
		const row = rows(page).nth(4);
		const background = () => row.evaluate((el) => getComputedStyle(el).backgroundColor);
		const resting = await background();
		await row.hover();
		await expect.poll(background).not.toBe(resting);
		const box = await boxOf(row);
		expect(box.height).toBeGreaterThanOrEqual(44);

		await captureScreen(page, testInfo, 'desktop-workout-run');
		await audit(page, 'the run on a desktop');
	});
});
