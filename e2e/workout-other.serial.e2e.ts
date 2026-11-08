/**
 * Logging an other session on /workout/session against the real server (sync 'real'): the
 * fixture's Muay Thai class, seeded as an ad-hoc workout, saved with its minutes, RPE and metrics
 * and stored in Postgres; a change after it synced edits the one record with one audit row; an
 * ad-hoc conditioning session takes a metric of the owner's own; a refused other.log on a planned
 * class is fixed from the sync sheet; a reload restores what was changed but not saved. Each test
 * asserts only its own workout's rows, by client id. Serial, with the other workout specs that
 * write Postgres (the refused change's test stores a program, which empties the workouts).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { CustomMetric } from '../src/lib/domain/training/types';
import type { OtherKit } from '../src/lib/domain/workout';
import { createMutation } from '../src/lib/domain/workout/mutations';
import { BELOW_DESKTOP_WIDTH, boxOf, DESKTOP, DESKTOP_WIDTHS, expectNoSideScroll } from './desktop';
import { layoutWidth, tokenPx } from './desktop';
import { seedProgram } from './program-support';
import { captureScreen, query } from './support';
import {
	gotoWorkout,
	injectMutation,
	readOutbox,
	readWorkout,
	seedWorkout,
	workoutDay
} from './workout-support';

let planned: OtherKit;
let kit: OtherKit;
test.beforeAll(async () => {
	planned = (await workoutDay()).other;
	// Ad hoc: the fixture's planned session is not in this database.
	kit = { ...planned, plannedLineage: null, plannedSessionId: null, programId: null };
});

const entry = (page: Page) => page.getByTestId('session-entry');
const stepper = (scope: Locator, testId: string) =>
	scope.getByTestId(testId).getByRole('spinbutton');
const rpe = (page: Page, label: string) =>
	entry(page).getByRole('radio', { name: label, exact: true });
const save = (page: Page) => page.getByTestId('save-session');
const pill = (page: Page) => page.getByTestId('sync-pill');
const synced = (page: Page) => expect.poll(() => readOutbox(page), { timeout: 15_000 }).toEqual([]);

async function type(field: Locator, text: string) {
	await field.click();
	await field.fill(text);
	await field.press('Enter');
}

/** Opens the session page against the real server, the store connected. */
async function open(page: Page) {
	await gotoWorkout(page, 'other', { sync: 'real' });
	await expect(page.locator('main#main[data-store]')).toBeAttached();
}

const recordOf = async (workoutId: string) =>
	query<{
		id: string;
		kind: string;
		minutes: number;
		rpe: number | null;
		metrics: CustomMetric[];
		notes: string | null;
	}>(
		`select w.id::text as id, o.kind, o.duration_minutes as minutes, o.rpe::float8 as rpe,
		        o.metrics, o.notes
		   from other_session_records o join workouts w on w.id = o.workout_id
		  where w.client_id = $1`,
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

const ROUNDS = { key: 'rounds', label: 'Rounds', unit: null } as const;
const SPARRED = { key: 'sparred', label: 'Sparred', unit: null } as const;

test.describe('logging an other session', () => {
	test('the class: 90 min, RPE 8, rounds 6, sparred yes, and Postgres has those metrics', async ({
		page
	}, testInfo) => {
		const workoutId = await seedWorkout(page, kit);
		await open(page);
		await expect(entry(page).getByRole('heading', { level: 2 })).toHaveText('Muay Thai class');
		await expect(page.getByTestId('session-plan')).toHaveText('Class · 90 min · RPE 7');
		await expect(entry(page).getByRole('radio', { name: 'Class', exact: true })).toBeChecked();
		// The stopwatch's minutes until changed: the workout started 12 minutes ago.
		await expect(stepper(entry(page), 'session-duration')).toHaveValue('12');
		await expect(stepper(entry(page), 'metric-rounds')).toHaveValue('6');
		await expect(page.getByTestId('session-status')).toHaveText('Not saved yet');

		await type(stepper(entry(page), 'session-duration'), '90');
		await rpe(page, '8').check();
		await entry(page).getByRole('switch', { name: 'Sparred' }).check();
		await save(page).click();
		await expect(page.getByTestId('session-status')).toHaveText(/^Saved/);
		await expect(save(page)).toBeDisabled();

		await synced(page);
		await expect(pill(page)).toHaveText('Saved');
		expect(await recordOf(workoutId)).toEqual([
			{
				id: expect.any(String),
				kind: 'class',
				minutes: 90,
				rpe: 8,
				metrics: [
					{ ...ROUNDS, value: 6 },
					{ ...SPARRED, value: true }
				],
				notes: null
			}
		]);

		await captureScreen(page, testInfo, 'workout-muay-thai');
		await audit(page, 'the session');
	});

	test('rounds changed to 7 after it synced: one record with rounds 7, and one audit row', async ({
		page
	}) => {
		const workoutId = await seedWorkout(page, kit);
		await open(page);
		await type(stepper(entry(page), 'session-duration'), '90');
		await save(page).click();
		await synced(page);
		expect(await recordOf(workoutId)).toEqual([
			expect.objectContaining({
				metrics: [
					{ ...ROUNDS, value: 6 },
					{ ...SPARRED, value: false }
				]
			})
		]);

		await type(stepper(entry(page), 'metric-rounds'), '7');
		await expect(page.getByTestId('session-status')).toHaveText('Changes not saved');
		await expect(save(page)).toHaveText('Save changes');
		await save(page).click();
		await synced(page);

		const records = await recordOf(workoutId);
		expect(records).toEqual([
			expect.objectContaining({
				minutes: 90,
				metrics: [
					{ ...ROUNDS, value: 7 },
					{ ...SPARRED, value: false }
				]
			})
		]);
		const audits = await query(
			`select 1 from training_audit where table_name = 'other_session_records' and row_id = $1`,
			[records[0]!.id]
		);
		expect(audits).toHaveLength(1);
	});

	test('an ad-hoc conditioning session with a metric of the owner’s own: Bike calories 120', async ({
		page
	}) => {
		const workoutId = await seedWorkout(page, {
			...kit,
			title: 'Conditioning',
			sessionType: 'conditioning',
			discipline: 'athletic',
			other: { kind: 'conditioning', durationMinutes: 30, targetRpe: null, metrics: [] }
		});
		await open(page);
		await expect(entry(page).getByTestId('session-metrics')).toContainText(
			'Add what you want to keep'
		);
		await entry(page).getByTestId('add-metric').click();
		await entry(page).getByTestId('metric-name').fill('Bike calories');
		await entry(page).getByTestId('confirm-metric').click();
		// A fraction typed into a new metric (it starts at 0, a whole number) is kept, not rounded.
		await type(stepper(entry(page), 'metric-bike_calories'), '120.5');
		await expect(stepper(entry(page), 'metric-bike_calories')).toHaveValue('120.5');
		await save(page).click();

		await synced(page);
		expect(await recordOf(workoutId)).toEqual([
			expect.objectContaining({
				kind: 'conditioning',
				metrics: [{ key: 'bike_calories', label: 'Bike calories', unit: null, value: 120.5 }]
			})
		]);
	});

	test('a reload restores what was changed and not saved, and nothing was sent', async ({
		page
	}) => {
		const workoutId = await seedWorkout(page, kit);
		await open(page);
		await synced(page);
		const drafted = () => readWorkout(page, workoutId).then((w) => w?.device);
		await rpe(page, '6').check();
		await entry(page).getByRole('switch', { name: 'Sparred' }).check();
		await entry(page).getByTestId('session-notes').fill('Clinch work');
		// Typed and still focused: no Enter, no blur, yet each number is kept as it is typed.
		await stepper(entry(page), 'metric-rounds').fill('5');
		await expect.poll(drafted).toMatchObject({
			session: {
				metrics: expect.arrayContaining([expect.objectContaining({ key: 'rounds', value: 5 })])
			}
		});
		await page.reload();
		await expect(page.locator('main#main[data-ready]')).toBeAttached();
		await expect(page.locator('main#main[data-store]')).toBeAttached();
		await stepper(entry(page), 'session-duration').fill('75');
		await expect.poll(drafted).toMatchObject({ session: { durationMinutes: 75 } });

		await page.reload();
		await expect(page.locator('main#main[data-ready]')).toBeAttached();
		await expect(stepper(entry(page), 'session-duration')).toHaveValue('75');
		await expect(rpe(page, '6')).toBeChecked();
		await expect(stepper(entry(page), 'metric-rounds')).toHaveValue('5');
		await expect(entry(page).getByRole('switch', { name: 'Sparred' })).toBeChecked();
		await expect(entry(page).getByTestId('session-notes')).toHaveValue('Clinch work');
		await expect(page.getByTestId('session-status')).toHaveText('Not saved yet');
		expect(await readOutbox(page)).toEqual([]);
		expect(await recordOf(workoutId)).toEqual([]);
	});

	test('a refused other.log on a planned class: Fix opens the fields with the error at that metric, and the corrected change lands once', async ({
		page,
		request
	}) => {
		const seeded = await seedProgram(request, { fixture: 'today', start: 'this_week' });
		const lineage = seeded.sessions.find((s) => s.title === 'Muay Thai class')!.lineage;
		const [session] = await query<{ id: string; metrics: CustomMetric[] }>(
			`select s.id, d.metrics from planned_sessions s
			   join planned_session_details d on d.session_id = s.id
			  where s.lineage_id = $1`,
			[lineage]
		);
		const workoutId = await seedWorkout(page, {
			...planned,
			plannedSessionId: session!.id,
			plannedLineage: lineage,
			programId: seeded.programId,
			other: { ...planned.other, metrics: session!.metrics }
		});
		await open(page);
		await synced(page);
		const rounds = session!.metrics.find((m) => m.key === 'rounds')!;
		const bad = createMutation('other.log', {
			workoutId,
			at: new Date().toISOString(),
			payload: {
				kind: 'class',
				durationMinutes: 90,
				rpe: 8,
				metrics: [rounds, { key: 'kicks', label: 'Kicks', unit: null, value: 40 }],
				notes: null
			}
		});
		await injectMutation(page, bad);

		await expect(pill(page)).toHaveText('1 needs attention');
		await pill(page).click();
		const issue = page.getByTestId('sync-sheet').getByTestId('sync-issue');
		await expect(issue).toContainText('Session details');
		await expect(issue).toContainText('Metric: Kicks is not one of this session’s metrics');
		await issue.getByTestId('fix-change').click();

		const fix = page.getByTestId('other-fix');
		await expect(fix.getByTestId('fix-reason')).toContainText('Kicks is not one of');
		await expect(fix.getByTestId('metric-kicks')).toContainText(
			'Kicks is not one of this session’s metrics'
		);
		// A metric the plan has stays; only the one it lacks can go.
		await expect(fix.getByTestId('metric-rounds').getByTestId('remove-metric')).toHaveCount(0);
		await audit(page, 'the Fix editor');
		await fix.getByTestId('metric-kicks').getByTestId('remove-metric').click();
		await fix.getByTestId('save-fix').click();

		await synced(page);
		await expect(pill(page)).toHaveText('Saved');
		expect(await recordOf(workoutId)).toEqual([
			expect.objectContaining({ kind: 'class', minutes: 90, rpe: 8, metrics: [rounds] })
		]);
		const ledger = await query(`select 1 from sync_mutations where mutation_id = $1`, [bad.id]);
		expect(ledger).toHaveLength(1);
	});
});

test.describe('on a desktop window', () => {
	test.use(DESKTOP);

	test('one readable column, centred; the steppers and the Toggle by keyboard; hover and focus states', async ({
		page
	}, testInfo) => {
		await seedWorkout(page, kit);
		await open(page);

		const main = await boxOf(page.getByTestId('session-main'));
		const readable = await tokenPx(page, '--content-readable');
		expect(Math.abs(main.width - readable), `the column is ${main.width}px`).toBeLessThanOrEqual(1);
		const right = (await layoutWidth(page)) - (main.x + main.width);
		expect(Math.abs(main.x - right), `gaps ${main.x} and ${right}`).toBeLessThanOrEqual(1);
		for (const width of [...DESKTOP_WIDTHS, BELOW_DESKTOP_WIDTH]) {
			await page.setViewportSize({ width, height: 900 });
			await expectNoSideScroll(page);
		}
		await page.setViewportSize(DESKTOP.viewport);

		// The duration by keyboard: arrows nudge a minute, PageUp five, and minutes typed.
		const minutes = stepper(entry(page), 'session-duration');
		await minutes.focus();
		expect(await minutes.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
		const from = Number(await minutes.getAttribute('aria-valuenow'));
		await minutes.press('ArrowUp');
		await expect(minutes).toHaveAttribute('aria-valuenow', String(from + 1));
		await minutes.press('PageUp');
		await expect(minutes).toHaveAttribute('aria-valuenow', String(from + 6));
		const rounds = stepper(entry(page), 'metric-rounds');
		await rounds.focus();
		await rounds.press('ArrowUp');
		await expect(rounds).toHaveAttribute('aria-valuenow', '7');

		// The Toggle: Space flips it.
		const sparred = entry(page).getByRole('switch', { name: 'Sparred' });
		await sparred.focus();
		await page.keyboard.press('Space');
		await expect(sparred).toBeChecked();
		await save(page).focus();
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('session-status')).toHaveText(/^Saved/);

		// Hover tints a secondary button.
		const add = entry(page).getByTestId('add-metric');
		const background = () => add.evaluate((el) => getComputedStyle(el).backgroundColor);
		const resting = await background();
		await add.hover();
		await expect.poll(background).not.toBe(resting);
		expect((await boxOf(add)).height).toBeGreaterThanOrEqual(44);

		await captureScreen(page, testInfo, 'desktop-workout-muay-thai');
		await audit(page, 'the session on a desktop');
	});
});
