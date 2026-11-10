/**
 * Brief journey 4 (M4 acceptance 6), end to end against the real server: M3's 'workout-day'
 * program, seeded this week, has an interval run and a Muay Thai class today.
 * - From Today, the run is started and logged on /workout/run, every one of its 14 segments with
 *   its actual distance and time, then finished; the class is started from Today and logged on
 *   /workout/session with its minutes, RPE, rounds and sparring, then finished.
 * - Both sync: Postgres has the run's record and its 14 segments, each with its pace, and the
 *   class's record with rounds 6 and sparred true.
 * - Both are in History: the list, the run's detail with its segments and the class's with its
 *   metrics; then, at 1440 × 900, the list beside the run's detail.
 * Every state is captured. Serial: it stores a program, which empties the workouts. No request is
 * held or faked, so the service worker stays on.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { CustomMetric } from '../src/lib/domain/training/types';
import { DESKTOP, expectNoSideScroll } from './desktop';
import { PROGRAM_TZ, seedProgram, type SeededProgram } from './program-support';
import { captureScreen, gotoHydrated, query } from './support';
import { readOutbox } from './workout-support';

test.use({ timezoneId: PROGRAM_TZ });
// The desktop test reads the workouts the journey left: it runs only after the journey passed.
test.describe.configure({ mode: 'serial' });

const RUN = 'Intervals';
const CLASS = 'Muay Thai class';
const HISTORY = '/progress/workouts';

/** The workouts the journey finished, by client id, for the desktop test. */
const finished = { run: '', thai: '' };

/** Today's session titled `title`: its card. */
const todaySession = (page: Page, title: string) =>
	page.getByTestId('today-session').filter({ has: page.getByText(title, { exact: true }) });

/** Today, once it has read the device and saved today's kits (on idle). */
async function openToday(page: Page) {
	await gotoHydrated(page, '/today');
	await expect(page.locator('[data-testid="today-plan"][data-kits="saved"]')).toBeAttached({
		timeout: 10_000
	});
}

const synced = (page: Page) => expect.poll(() => readOutbox(page), { timeout: 15_000 }).toEqual([]);

async function type(field: Locator, text: string) {
	await field.click();
	await field.fill(text);
	await field.press('Enter');
}

const runEntry = (page: Page) => page.getByTestId('run-entry');
const segmentHeading = (page: Page) => runEntry(page).getByRole('heading', { level: 2 });
const runStepper = (page: Page, which: 'distance' | 'time') =>
	runEntry(page).getByTestId(`segment-${which}`).getByRole('spinbutton');

/** Logs the segment on screen: `heading` first, then the distance and time typed (km, m:ss). */
async function logSegment(page: Page, heading: string, distance: string, time: string) {
	await expect(segmentHeading(page)).toHaveText(heading);
	await type(runStepper(page, 'distance'), distance);
	await type(runStepper(page, 'time'), time);
	await runEntry(page).getByTestId('log-segment').click();
}

/** Finishes the workout on screen from the header's menu; Done opens its History detail. */
async function finish(page: Page, testInfo: Parameters<typeof captureScreen>[1], name: string) {
	await page.getByTestId('workout-menu-button').click();
	await page.getByTestId('workout-menu').getByTestId('menu-finish').click();
	const sheet = page.getByTestId('finish-sheet');
	await expect(sheet.getByTestId('workout-summary')).toBeVisible();
	await captureScreen(page, testInfo, name);
	await sheet.getByTestId('finish-done').click();
	await page.waitForURL(/\/progress\/workouts\/[0-9a-f-]{36}$/);
	await expect(page.getByTestId('workout-detail')).toBeVisible();
	return new URL(page.url()).pathname.split('/').at(-1)!;
}

const statusOf = async (clientId: string) =>
	(
		await query<{ status: string }>('select status from workouts where client_id = $1', [clientId])
	)[0]?.status;

test('a structured run and a Muay Thai class: logged from Today, synced, and in History', async ({
	page,
	request
}, testInfo) => {
	// Fourteen segments typed one by one, two finishes and four History screens, on WebKit too.
	test.setTimeout(180_000);
	const seeded: SeededProgram = await seedProgram(request, {
		fixture: 'workout-day',
		start: 'this_week'
	});
	// Onboarding complete, so Today shows the plan rather than the setup card.
	await query('update athlete_profiles set onboarding_completed_at = now()');
	const lineageOf = (title: string) =>
		seeded.sessions.find((s) => s.title === title && s.date === seeded.today)!.lineage;

	await test.step('Today starts the interval run on /workout/run', async () => {
		await openToday(page);
		const start = todaySession(page, RUN).getByTestId('start-workout');
		await expect(start).toHaveAttribute('href', `/workout?start=${lineageOf(RUN)}`);
		await captureScreen(page, testInfo, 'journey-run-today');
		await start.click();
		await expect(page).toHaveURL(/\/workout\/run$/);
		await expect(page.getByTestId('run-segment')).toHaveCount(14);
		await expect(runEntry(page)).toContainText('Segment 1 of 14');
		await captureScreen(page, testInfo, 'journey-run-start');
	});

	await test.step('every segment logged with its actual distance and time', async () => {
		await logSegment(page, 'Warm-up', '1.8', '10:00');
		for (let round = 1; round <= 6; round++) {
			await logSegment(page, `Interval ${round} of 6`, '0.4', '1:30');
			await logSegment(page, `Recovery ${round} of 6`, '0.2', '1:30');
			if (round === 3) await captureScreen(page, testInfo, 'journey-run-midway');
		}
		await logSegment(page, 'Cool-down', '1.6', '10:00');
		await expect(page.getByTestId('run-segment').filter({ hasText: 'Done' })).toHaveCount(14);
		// 1.8 km + 6 × 400 m + 6 × 200 m + 1.6 km in 10:00 + 12 × 1:30 + 10:00.
		const totals = page.getByTestId('run-totals');
		await expect(totals).toContainText('7 km');
		await expect(totals).toContainText('38:00');
		await synced(page);
		await expect(page.getByTestId('sync-pill')).toHaveText('Saved');
		await captureScreen(page, testInfo, 'journey-run-logged');
	});

	await test.step('the run finished; Postgres has it and its 14 segments, each with its pace', async () => {
		finished.run = await finish(page, testInfo, 'journey-run-summary');
		expect(await statusOf(finished.run)).toBe('completed');
		const runs = await query<{ distance: number; duration: number; pace: number }>(
			`select r.distance_m::float8 as distance, r.duration_s as duration,
			        r.pace_s_per_km::float8 as pace
			   from run_records r join workouts w on w.id = r.workout_id where w.client_id = $1`,
			[finished.run]
		);
		expect(runs).toEqual([{ distance: 7000, duration: 2280, pace: expect.any(Number) }]);
		expect(runs[0]!.pace).toBeCloseTo(2280 / 7, 0);
		const segments = await query<{
			position: number;
			kind: string;
			distance: number;
			duration: number;
			pace: number | null;
		}>(
			`select s.position, s.kind, s.distance_m::float8 as distance, s.duration_s as duration,
			        s.pace_s_per_km::float8 as pace
			   from run_record_segments s join workouts w on w.id = s.workout_id
			  where w.client_id = $1 order by s.position`,
			[finished.run]
		);
		expect(segments.map((s) => s.position)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
		expect(segments.map((s) => s.kind)).toEqual([
			'warm_up',
			...Array.from({ length: 6 }, () => ['interval', 'recovery']).flat(),
			'cool_down'
		]);
		for (const s of segments) {
			expect(s.pace, `segment ${s.position}'s pace`).not.toBeNull();
			expect(s.pace!, `segment ${s.position}'s pace`).toBeCloseTo(
				s.duration / (s.distance / 1000),
				2
			);
		}
	});

	await test.step('Today shows the run done and starts the class on /workout/session', async () => {
		await openToday(page);
		await expect(todaySession(page, RUN).getByTestId('done-workout')).toHaveText('Done · View');
		const start = todaySession(page, CLASS).getByTestId('start-workout');
		await expect(start).toHaveAttribute('href', `/workout?start=${lineageOf(CLASS)}`);
		await start.click();
		await expect(page).toHaveURL(/\/workout\/session$/);
		await expect(page.getByTestId('session-entry').getByRole('heading', { level: 2 })).toHaveText(
			CLASS
		);
		await captureScreen(page, testInfo, 'journey-thai-start');
	});

	await test.step('the class logged: 90 min, RPE 8, rounds 6, sparred, and saved', async () => {
		const entry = page.getByTestId('session-entry');
		const stepper = (testId: string) => entry.getByTestId(testId).getByRole('spinbutton');
		await type(stepper('session-duration'), '90');
		await entry.getByRole('radio', { name: '8', exact: true }).check();
		await type(stepper('metric-rounds'), '6');
		await entry.getByRole('switch', { name: 'Sparred' }).check();
		await page.getByTestId('save-session').click();
		await expect(page.getByTestId('session-status')).toHaveText(/^Saved/);
		await synced(page);
		await expect(page.getByTestId('sync-pill')).toHaveText('Saved');
		await captureScreen(page, testInfo, 'journey-thai-logged');
	});

	await test.step('the class finished; Postgres has rounds 6 and sparred true', async () => {
		finished.thai = await finish(page, testInfo, 'journey-thai-summary');
		expect(await statusOf(finished.thai)).toBe('completed');
		const records = await query<{
			kind: string;
			minutes: number;
			rpe: number;
			metrics: CustomMetric[];
		}>(
			`select o.kind, o.duration_minutes as minutes, o.rpe::float8 as rpe, o.metrics
			   from other_session_records o join workouts w on w.id = o.workout_id
			  where w.client_id = $1`,
			[finished.thai]
		);
		expect(records).toEqual([
			{
				kind: 'class',
				minutes: 90,
				rpe: 8,
				metrics: [
					{ key: 'rounds', label: 'Rounds', unit: null, value: 6 },
					{ key: 'sparred', label: 'Sparred', unit: null, value: true }
				]
			}
		]);
	});

	await test.step('History lists both, and each detail shows its segments or metrics', async () => {
		await gotoHydrated(page, HISTORY);
		const rows = page.getByTestId('workout-row');
		await expect(rows).toHaveCount(2);
		// Newest first: the class, started after the run.
		await expect(rows.nth(0)).toHaveAttribute('href', `${HISTORY}/${finished.thai}`);
		await expect(rows.nth(0)).toContainText(CLASS);
		await expect(rows.nth(1)).toHaveAttribute('href', `${HISTORY}/${finished.run}`);
		await expect(rows.nth(1)).toContainText(RUN);
		await expect(rows.nth(1)).toContainText('7 km');
		await captureScreen(page, testInfo, 'journey-history-list');

		await rows.nth(1).click();
		await expect(page).toHaveURL(`${HISTORY}/${finished.run}`);
		const detail = page.getByTestId('workout-detail');
		const segments = detail.getByTestId('workout-segment');
		await expect(segments).toHaveCount(14);
		await expect(segments.nth(0)).toHaveText(/1\. Warm-up\s*1\.8 km · 10:00 · 5:33 \/km/);
		await expect(segments.nth(1)).toHaveText(/2\. Interval\s*0\.4 km · 1:30 · 3:45 \/km/);
		await expect(segments.nth(2)).toHaveText(/3\. Recovery\s*0\.2 km · 1:30 · 7:30 \/km/);
		await expect(segments.nth(13)).toHaveText(/14\. Cool-down\s*1\.6 km · 10:00 · 6:15 \/km/);
		await expect(detail.getByTestId('workout-stats')).toContainText('7 km');
		await captureScreen(page, testInfo, 'journey-history-run');

		await page.getByTestId('back-to-list').click();
		await rows.nth(0).click();
		await expect(page).toHaveURL(`${HISTORY}/${finished.thai}`);
		await expect(detail).toContainText('Class ·');
		const metrics = detail.getByTestId('workout-metrics');
		await expect(metrics).toContainText(/Rounds\s*6/);
		await expect(metrics).toContainText(/Sparred\s*Yes/);
		await expect(detail.getByTestId('workout-segment')).toHaveCount(0);
		await captureScreen(page, testInfo, 'journey-history-thai');
	});
});

test.describe('on a desktop window', () => {
	test.use(DESKTOP);

	test('History: the list beside the run’s detail with its 14 segments, then the class’s metrics', async ({
		page
	}, testInfo) => {
		await gotoHydrated(page, `${HISTORY}/${finished.run}`);
		await expectNoSideScroll(page);
		const rows = page.getByTestId('workout-row');
		const detail = page.getByTestId('workout-detail');
		await expect(rows).toHaveCount(2);
		await expect(detail.getByTestId('workout-segment')).toHaveCount(14);
		const run = page.locator(`[data-testid="workout-row"][href="${HISTORY}/${finished.run}"]`);
		await expect(run).toHaveAttribute('aria-current', 'page');
		const list = (await run.boundingBox())!;
		const shown = (await detail.boundingBox())!;
		expect(list.x + list.width, 'the list is left of the detail').toBeLessThanOrEqual(shown.x);
		await captureScreen(page, testInfo, 'desktop-journey-history-run');

		await page.locator(`[data-testid="workout-row"][href="${HISTORY}/${finished.thai}"]`).click();
		await expect(page).toHaveURL(`${HISTORY}/${finished.thai}`);
		await expect(detail.getByTestId('workout-metrics')).toContainText(/Sparred\s*Yes/);
		await expect(rows).toHaveCount(2);
		await captureScreen(page, testInfo, 'desktop-journey-history-thai');
	});
});
