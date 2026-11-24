/**
 * Logging an other session on /workout/session against the real server (sync 'real'): the
 * fixture's Muay Thai class, seeded as an ad-hoc workout, saved with its minutes, effort and
 * metrics and stored in Postgres; the page is the duration's stepper and rows, each opening its
 * sheet (What kind, Effort, Notes, More to keep and a metric's own); a change after it synced edits the one record with one audit row; an
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
/** The session's title: the workout header's. */
const title = (page: Page) => page.getByTestId('workout-header').getByRole('heading', { level: 1 });
const sheet = (page: Page, name: string) => page.getByRole('dialog', { name, exact: true });
const effortSheet = (page: Page) => sheet(page, 'How hard was it');
const keepSheet = (page: Page) => sheet(page, 'More to keep');
const save = (page: Page) => page.getByTestId('save-session');
const pill = (page: Page) => page.getByTestId('sync-pill');
const synced = (page: Page) => expect.poll(() => readOutbox(page), { timeout: 15_000 }).toEqual([]);

async function type(field: Locator, text: string) {
	await field.click();
	await field.fill(text);
	await field.press('Enter');
}

/** Closes the open sheets, the top one first, back to the page. */
async function closeSheets(page: Page) {
	const open = page.locator('dialog[open]');
	for (let n = await open.count(); n > 0; n--) {
		await page.keyboard.press('Escape');
		await expect(open).toHaveCount(n - 1);
	}
}

/** Effort `n` from its row's sheet, which stays open until closed. */
async function effort(page: Page, n: string) {
	await page.getByTestId('session-effort').click();
	await effortSheet(page).getByRole('radio', { name: n, exact: true }).check();
	await closeSheets(page);
}

/** More to keep's sheet, opened from its row. */
async function keep(page: Page) {
	await page.getByTestId('session-keep').click();
	await expect(keepSheet(page)).toBeVisible();
	return keepSheet(page);
}

/** A metric's own sheet, opened from its row in More to keep: its control (MetricField). */
async function metric(page: Page, key: string) {
	await (await keep(page)).getByTestId(`keep-${key}`).click();
	const field = page.getByTestId(`metric-${key}`);
	await expect(field).toBeVisible();
	return field;
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
		await expect(title(page)).toHaveText('Muay Thai class');
		// Ad hoc: its own line, not a plan's.
		await expect(page.getByTestId('session-line')).toHaveText(/ · your own session$/);
		await expect(page.getByTestId('session-plan')).toHaveCount(0);
		await expect(page.getByTestId('session-kind')).toContainText('Class');
		// The stopwatch's minutes until changed: the workout started 12 minutes ago.
		await expect(stepper(entry(page), 'session-duration')).toHaveValue('12');
		await expect(page.getByTestId('session-effort')).toContainText('Add');
		await expect(page.getByTestId('session-keep')).toContainText('Rounds, sparred');
		await expect((await metric(page, 'rounds')).getByRole('spinbutton')).toHaveValue('6');
		await expect(keepSheet(page).getByTestId('keep-sparred')).toContainText('No');
		await audit(page, 'a metric’s sheet over More to keep');
		await closeSheets(page);
		await expect(page.getByTestId('session-status')).toHaveText('Not saved yet');

		// What kind is a pick: a tap picks and closes, and the row says it.
		await page.getByTestId('session-kind').click();
		await sheet(page, 'What kind').getByRole('radio', { name: 'Sparring' }).click();
		await expect(sheet(page, 'What kind')).toBeHidden();
		await expect(page.getByTestId('session-kind')).toContainText('Sparring');
		await page.getByTestId('session-kind').click();
		await sheet(page, 'What kind').getByRole('radio', { name: 'Class' }).click();
		await expect(page.getByTestId('session-kind')).toContainText('Class');

		await type(stepper(entry(page), 'session-duration'), '90');
		await page.getByTestId('session-effort').click();
		await effortSheet(page).getByRole('radio', { name: '8', exact: true }).check();
		await expect(effortSheet(page).getByRole('status')).toHaveText(
			'8 is hard. It shows as Hard on the session.'
		);
		await audit(page, 'the effort sheet');
		await closeSheets(page);
		await expect(page.getByTestId('session-effort')).toContainText('Hard');
		await (await metric(page, 'sparred')).getByRole('switch', { name: 'Sparred' }).check();
		await expect(keepSheet(page).getByTestId('keep-sparred')).toContainText('Yes');
		await closeSheets(page);
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

		await type((await metric(page, 'rounds')).getByRole('spinbutton'), '7');
		await closeSheets(page);
		await expect(page.getByTestId('session-keep')).toContainText('Rounds, sparred');
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
		await expect(page.getByTestId('session-keep')).toContainText('Add');
		const kept = await keep(page);
		await expect(kept).toContainText('Name it once and pick number, yes or no, or a few words.');
		await kept.getByTestId('add-metric').click();
		const adding = sheet(page, 'Track something else');
		// A name it cannot use is said at the field, and nothing is added.
		await adding.getByTestId('confirm-metric').click();
		await expect(adding).toContainText('Name the metric');
		await adding.getByTestId('metric-name').fill('Bike calories');
		await adding.getByTestId('confirm-metric').click();
		await expect(adding).toBeHidden();
		await kept.getByTestId('keep-bike_calories').click();
		// A fraction typed into a new metric (it starts at 0, a whole number) is kept, not rounded.
		const calories = page.getByTestId('metric-bike_calories');
		await type(calories.getByRole('spinbutton'), '120.5');
		await expect(calories.getByRole('spinbutton')).toHaveValue('120.5');
		await closeSheets(page);
		await expect(page.getByTestId('session-keep')).toContainText('Bike calories');
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
		await effort(page, '6');
		await (await metric(page, 'sparred')).getByRole('switch', { name: 'Sparred' }).check();
		await closeSheets(page);
		await page.getByTestId('session-notes-row').click();
		await page.getByTestId('session-notes').fill('Clinch work');
		await closeSheets(page);
		await expect(page.getByTestId('session-notes-row')).toContainText('Edit');
		// Typed and still focused: no Enter, no blur, yet each number is kept as it is typed.
		await (await metric(page, 'rounds')).getByRole('spinbutton').fill('5');
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
		await expect(page.getByTestId('session-effort')).toContainText('Moderate');
		await page.getByTestId('session-effort').click();
		await expect(effortSheet(page).getByRole('radio', { name: '6', exact: true })).toBeChecked();
		await closeSheets(page);
		await expect((await metric(page, 'rounds')).getByRole('spinbutton')).toHaveValue('5');
		await closeSheets(page);
		await expect(
			(await metric(page, 'sparred')).getByRole('switch', { name: 'Sparred' })
		).toBeChecked();
		await closeSheets(page);
		await page.getByTestId('session-notes-row').click();
		await expect(page.getByTestId('session-notes')).toHaveValue('Clinch work');
		await closeSheets(page);
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

	test('one readable column, centred; the steppers, the Toggle and the effort by keyboard; hover and focus states', async ({
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
		const rounds = (await metric(page, 'rounds')).getByRole('spinbutton');
		await rounds.focus();
		await rounds.press('ArrowUp');
		await expect(rounds).toHaveAttribute('aria-valuenow', '7');
		await closeSheets(page);

		// The Toggle, in its sheet: Space flips it.
		const sparred = (await metric(page, 'sparred')).getByRole('switch', { name: 'Sparred' });
		await sparred.focus();
		await page.keyboard.press('Space');
		await expect(sparred).toBeChecked();
		await closeSheets(page);

		// Effort by keyboard: Enter opens its sheet, a centred dialog; the arrows move the pick, and
		// Escape gives the focus back to the row.
		const effortRow = page.getByTestId('session-effort');
		await effortRow.focus();
		await page.keyboard.press('Enter');
		const scale = effortSheet(page);
		await expect(scale).toBeVisible();
		const panel = await boxOf(scale.locator('.sheet'));
		expect(panel.width).toBeLessThanOrEqual(481);
		await scale.getByRole('radio', { name: '7', exact: true }).check();
		await scale.getByRole('radio', { name: '7', exact: true }).press('ArrowRight');
		await expect(scale.getByRole('radio', { name: '8', exact: true })).toBeChecked();
		await page.keyboard.press('Escape');
		await expect(scale).toBeHidden();
		await expect(effortRow).toBeFocused();
		await expect(effortRow).toContainText('Hard');

		await save(page).focus();
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('session-status')).toHaveText(/^Saved/);

		// Hover tints a row.
		await page.mouse.move(0, 0);
		const background = () => effortRow.evaluate((el) => getComputedStyle(el).backgroundColor);
		const resting = await background();
		await effortRow.hover();
		await expect.poll(background).not.toBe(resting);
		expect((await boxOf(effortRow)).height).toBeGreaterThanOrEqual(44);

		await captureScreen(page, testInfo, 'desktop-workout-muay-thai');
		await audit(page, 'the session on a desktop');
	});
});
