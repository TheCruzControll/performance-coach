/**
 * Set actions on /workout (PRD §7–§8): edit a logged set, delete it after a confirmation, skip
 * the set at hand, record missed reps, and add an extra set. Each is a mutation the outbox keeps
 * in order. From the shared kit fixture seeded in IndexedDB; sync is held ('hold'), so nothing
 * here writes Postgres: the outbox is the assertion. The desktop dialog and the keyboard are
 * workout-sets.desktop.e2e.ts.
 */
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Mutation, MutationType, StrengthKit } from '../src/lib/domain/workout';
import { createMutation } from '../src/lib/domain/workout/mutations';
import { DB_NAME, STORES } from '../src/lib/client/workout/names';
import { captureScreen } from './support';
import {
	gotoWorkout,
	injectMutation,
	readOutbox,
	seedWorkout,
	workoutDay
} from './workout-support';

let kit: StrengthKit;
test.beforeAll(async () => {
	kit = (await workoutDay()).strength;
});

/** The build under test's client output. */
const CLIENT = '../.svelte-kit/output/client';
/** The editor's chunk, from Vite's manifest. */
const editorChunk = () => {
	const manifest = JSON.parse(
		readFileSync(path.resolve(import.meta.dirname, CLIENT, '.vite/manifest.json'), 'utf8')
	) as Record<string, { file: string }>;
	return manifest['src/routes/workout/SetEditor.svelte']!.file;
};

const BACK_SQUAT = 1;
const LEG_PRESS = 2;
const PLANK = 5;

async function setPosition(page: Page, workoutId: string, position: number) {
	await page.evaluate(
		async ({ name, store, workoutId, position }) => {
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open(name);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			const objects = db.transaction(store, 'readwrite').objectStore(store);
			const read = objects.get(workoutId);
			await new Promise((resolve) => (read.onsuccess = resolve));
			const record = read.result as { device: { position: number } };
			record.device.position = position;
			objects.put(record);
			await new Promise((resolve) => (objects.transaction.oncomplete = resolve));
			db.close();
		},
		{ name: DB_NAME, store: STORES.workouts, workoutId, position }
	);
}

/** Seeds the workout at `position` (with `before` run on it first), opens /workout. */
async function open(
	page: Page,
	position = BACK_SQUAT,
	before?: (workoutId: string) => Promise<void>
): Promise<string> {
	const workoutId = await seedWorkout(page, kit);
	await before?.(workoutId);
	if (position !== 1) await setPosition(page, workoutId, position);
	await gotoWorkout(page);
	await expect(page.locator('main#main[data-store]')).toBeAttached();
	await expect(logger(page)).toBeVisible();
	return workoutId;
}

const logger = (page: Page) => page.getByTestId('set-logger');
const rows = (page: Page) => page.getByTestId('workout-main').getByTestId('set');
const editButton = (page: Page, index: number) => rows(page).nth(index).getByRole('button');
const editor = (page: Page) => page.getByTestId('set-editor');
const stepper = (page: Page, id: string) => page.getByTestId(id).getByRole('spinbutton');

/** Types a value into a stepper, as the owner does by tapping it. */
async function enter(page: Page, id: string, value: string) {
	const field = stepper(page, id);
	await field.click();
	await field.fill(value);
	await field.press('Enter');
}

const complete = (page: Page) => logger(page).getByTestId('complete-set').click();

async function outboxOf<T extends MutationType>(page: Page, type: T) {
	return (await readOutbox(page))
		.map((entry) => entry.envelope)
		.filter((m): m is Extract<Mutation, { type: T }> => m.type === type);
}

async function audit(page: Page): Promise<string[]> {
	const { violations } = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.analyze();
	return violations.flatMap((v) =>
		v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${n.failureSummary}`)
	);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test.describe('set actions (IndexedDB only)', () => {
	// gotoWorkout holds /api/workouts/* with page.route, which WebKit applies only without a worker.
	test.use({ serviceWorkers: 'block' });

	test('edit reps 5 → 4: the row shows 4, and one absolute set.edit is queued after its set.log', async ({
		page
	}, testInfo) => {
		const workoutId = await open(page);
		await complete(page);
		await expect(rows(page).first()).toContainText('100 kg × 5 reps · RPE 7');
		await expect.poll(async () => (await outboxOf(page, 'set.log')).length).toBe(1);

		await editButton(page, 0).click();
		await expect(editor(page).getByRole('heading', { name: 'Edit set 1' })).toBeVisible();
		await expect(editor(page)).toContainText('Back squat');
		await expect(stepper(page, 'edit-load')).toHaveAttribute('aria-valuenow', '100');
		await expect(stepper(page, 'edit-amount')).toHaveAttribute('aria-valuenow', '5');
		await expect(editor(page).getByRole('radio', { name: '7', exact: true })).toBeChecked();
		await captureScreen(page, testInfo, 'workout-set-edit');
		await enter(page, 'edit-amount', '4');
		await editor(page).getByTestId('save-set').click();
		await expect(editor(page)).toBeHidden();
		await expect(rows(page).first()).toContainText('100 kg × 4 reps · RPE 7');

		// The edit, made before its set.log left the outbox (sync is held), stays queued after it.
		await expect.poll(async () => (await outboxOf(page, 'set.edit')).length).toBe(1);
		const outbox = await readOutbox(page);
		expect(outbox.map((entry) => entry.envelope.type)).toEqual([
			'workout.start',
			'set.log',
			'set.edit'
		]);
		const [log] = await outboxOf(page, 'set.log');
		const [edit] = await outboxOf(page, 'set.edit');
		expect(edit).toMatchObject({ v: 1, workoutId, entityId: log!.entityId });
		expect(edit!.id).toMatch(UUID);
		expect(edit!.id).not.toBe(log!.id);
		expect(edit!.payload).toEqual({
			reps: 4,
			seconds: null,
			metres: null,
			weight: 100,
			assistance: null,
			unit: 'kg',
			rpe: 7,
			missedReps: 0,
			isWarmup: false,
			isExtra: false
		});

		await page.reload();
		await expect(page.locator('main#main[data-ready]')).toBeAttached();
		await expect(rows(page).first()).toContainText('100 kg × 4 reps · RPE 7');
	});

	test('skip: a set.skip, the row reads Skipped; deleting the skip makes it the set at hand again', async ({
		page
	}, testInfo) => {
		const workoutId = await open(page, LEG_PRESS);
		await expect(logger(page).getByTestId('logger-secondary')).toHaveText('Skip set');
		await logger(page).getByTestId('logger-secondary').click();
		await expect(rows(page).first()).toHaveAttribute('data-state', 'skipped');
		await expect(rows(page).first()).toContainText('Skipped');
		await expect(rows(page).nth(1)).toHaveAttribute('data-state', 'current');
		await expect(logger(page)).toContainText('Set 2 of 3');

		await expect.poll(async () => (await outboxOf(page, 'set.skip')).length).toBe(1);
		const [skip] = await outboxOf(page, 'set.skip');
		const press = kit.exercises[LEG_PRESS - 1]!;
		expect(skip).toMatchObject({ workoutId, entityId: skip!.id });
		expect(skip!.payload).toEqual({
			position: LEG_PRESS,
			plannedLineage: press.plannedLineage,
			setIndex: 1,
			exerciseId: press.exercise.id,
			unit: 'kg'
		});
		// The row above the logger, as the owner scrolls to it.
		await rows(page)
			.first()
			.evaluate((el) => el.scrollIntoView({ block: 'start' }));
		await captureScreen(page, testInfo, 'workout-set-skipped');

		await page.reload();
		await expect(page.locator('main#main[data-store]')).toBeAttached();
		await expect(rows(page).first()).toHaveAttribute('data-state', 'skipped');

		// A skipped set has nothing to edit: its sheet offers Delete skip, after a confirmation.
		await editButton(page, 0).click();
		await expect(editor(page).getByRole('heading', { name: 'Set 1 · Skipped' })).toBeVisible();
		await expect(editor(page).getByTestId('save-set')).toHaveCount(0);
		await editor(page).getByTestId('delete-set').click();
		await expect(editor(page).getByRole('alert')).toHaveText(
			"Delete the skip of set 1? There's no undo."
		);
		await editor(page).getByTestId('confirm-delete').click();
		await expect(editor(page)).toBeHidden();
		await expect(rows(page).first()).toHaveAttribute('data-state', 'current');
		const [remove] = await outboxOf(page, 'set.delete');
		expect(remove).toMatchObject({ entityId: skip!.id, payload: {} });
	});

	test('3 of 5 reps: Missed reps opens prefilled from the target, and the set.log records 2', async ({
		page
	}) => {
		await open(page);
		const toggle = logger(page).getByTestId('missed-toggle');
		await expect(toggle).toHaveAttribute('aria-expanded', 'false');
		await expect(page.getByTestId('logger-missed')).toHaveCount(0);
		await enter(page, 'logger-amount', '3');
		await toggle.click();
		await expect(toggle).toHaveAttribute('aria-expanded', 'true');
		await expect(stepper(page, 'logger-missed')).toHaveAttribute('aria-valuenow', '2');
		// It follows the reps until the owner sets it.
		await enter(page, 'logger-amount', '4');
		await expect(stepper(page, 'logger-missed')).toHaveAttribute('aria-valuenow', '1');
		await enter(page, 'logger-amount', '3');
		await complete(page);
		await expect(rows(page).first()).toHaveAttribute('data-state', 'missed');
		await expect(rows(page).first()).toContainText('2 missed');

		// The next set starts with it closed: a set records no misses unless asked.
		await expect(toggle).toHaveAttribute('aria-expanded', 'false');
		await complete(page);
		await expect.poll(async () => (await outboxOf(page, 'set.log')).length).toBe(2);
		const logs = await outboxOf(page, 'set.log');
		expect(logs.map((m) => [m.payload.reps, m.payload.missedReps])).toEqual([
			[3, 2],
			[5, 0]
		]);
	});

	test('an extra set: is_extra in its set.log; deleted after the confirmation, its row goes', async ({
		page
	}) => {
		await open(page, LEG_PRESS);
		await enter(page, 'logger-load', '100');
		for (let set = 0; set < 3; set += 1) await complete(page);
		await expect(page.getByTestId('exercise-done')).toHaveText('All sets logged');
		await expect(rows(page)).toHaveCount(3);

		await page.getByTestId('add-set').click();
		await expect(logger(page)).toContainText('Set 4 · Extra');
		await expect(page.locator('#logger-heading')).toBeFocused();
		await expect(stepper(page, 'logger-load')).toHaveAttribute('aria-valuenow', '100');
		// Cancel puts it away; Add a set brings it back.
		await logger(page).getByTestId('logger-secondary').click();
		await expect(logger(page)).toBeHidden();
		await expect(page.getByTestId('add-set')).toBeFocused();
		await page.getByTestId('add-set').click();
		await complete(page);
		await expect(rows(page)).toHaveCount(4);
		await expect(rows(page).nth(3)).toHaveAttribute('data-state', 'extra');
		await expect(rows(page).nth(3)).toContainText('Extra set');
		await expect(page.getByTestId('add-set')).toBeFocused();

		await expect.poll(async () => (await outboxOf(page, 'set.log')).length).toBe(4);
		const extra = (await outboxOf(page, 'set.log'))[3]!;
		expect(extra.payload).toMatchObject({ setIndex: 4, isExtra: true, weight: 100, reps: 10 });

		await editButton(page, 3).click();
		await expect(editor(page).getByRole('heading', { name: 'Edit set 4' })).toBeVisible();
		await editor(page).getByTestId('delete-set').click();
		await expect(editor(page).getByRole('alert')).toHaveText("Delete set 4? There's no undo.");
		await expect(editor(page).getByTestId('keep-set')).toBeFocused();
		expect(await outboxOf(page, 'set.delete')).toEqual([]);
		// Keep it goes back to the editor; the second ask deletes.
		await editor(page).getByTestId('keep-set').click();
		await expect(editor(page).getByRole('alert')).toHaveCount(0);
		await editor(page).getByTestId('delete-set').click();
		await editor(page).getByTestId('confirm-delete').click();
		await expect(editor(page)).toBeHidden();
		await expect(rows(page)).toHaveCount(3);

		await expect.poll(async () => (await outboxOf(page, 'set.delete')).length).toBe(1);
		const [remove] = await outboxOf(page, 'set.delete');
		expect(remove).toMatchObject({ entityId: extra.entityId, payload: {} });
		expect(remove!.id).toMatch(UUID);
		expect(remove!.id).not.toBe(extra.id);

		await page.reload();
		await expect(page.locator('main#main[data-ready]')).toBeAttached();
		await expect(rows(page)).toHaveCount(3);
	});

	test("the plank's editor offers its time and an added weight, never a weight, reps or missed reps", async ({
		page
	}) => {
		const plank = kit.exercises[PLANK - 1]!;
		await open(page, PLANK, (workoutId) =>
			injectMutation(
				page,
				createMutation('set.log', {
					workoutId,
					at: new Date().toISOString(),
					payload: {
						position: PLANK,
						plannedLineage: plank.plannedLineage,
						setIndex: 1,
						exerciseId: plank.exercise.id,
						reps: null,
						seconds: 45,
						metres: null,
						weight: null,
						assistance: null,
						unit: 'kg',
						rpe: null,
						missedReps: 0,
						isWarmup: false,
						isExtra: false
					}
				})
			)
		);
		await expect(rows(page).first()).toContainText('0:45');
		await editButton(page, 0).click();
		await expect(editor(page).getByTestId('edit-amount')).toContainText('Time');
		await expect(stepper(page, 'edit-amount')).toHaveValue('0:45');
		// A bodyweight hold: an optional added weight, never a weight it needs, reps or misses.
		await expect(editor(page).getByTestId('edit-load')).toContainText('Added weight');
		await expect(stepper(page, 'edit-load')).toHaveAttribute('aria-valuenow', '0');
		await expect(editor(page).getByText('Weight', { exact: true })).toHaveCount(0);
		await expect(editor(page).getByText('Reps', { exact: true })).toHaveCount(0);
		await expect(editor(page).getByTestId('edit-missed')).toHaveCount(0);
		await enter(page, 'edit-amount', '1:00');
		await editor(page).getByTestId('save-set').click();
		await expect(rows(page).first()).toContainText('1:00');
		await expect.poll(async () => (await outboxOf(page, 'set.edit')).length).toBe(1);
		const [edit] = await outboxOf(page, 'set.edit');
		expect(edit!.payload).toMatchObject({ seconds: 60, reps: null, weight: null, missedReps: 0 });
	});

	test("the editor's code is fetched only on intent, and Close returns focus to the row", async ({
		page
	}) => {
		const file = editorChunk();
		const fetched: string[] = [];
		page.on('request', (r) => {
			if (new URL(r.url()).pathname === `/${file}`) fetched.push(r.url());
		});
		await open(page);
		await complete(page);
		await expect(rows(page).first()).toHaveAttribute('data-state', 'done');
		expect(fetched).toEqual([]);

		await editButton(page, 0).hover();
		await expect.poll(() => fetched.length).toBe(1);
		await editButton(page, 0).click();
		await expect(editor(page).getByRole('heading', { name: 'Edit set 1' })).toBeVisible();
		await editor(page).getByRole('button', { name: 'Close' }).click();
		await expect(editor(page)).toBeHidden();
		await expect(editButton(page, 0)).toBeFocused();
		// A draft is not kept: the next tap starts from the set again.
		await editButton(page, 0).click();
		await expect(stepper(page, 'edit-amount')).toHaveAttribute('aria-valuenow', '5');
		expect(fetched).toHaveLength(1);
	});

	for (const theme of ['dark', 'light'] as const) {
		test(`no WCAG A/AA violations with the editor open, or when its code is gone (${theme} theme)`, async ({
			page
		}, testInfo) => {
			await page.addInitScript(
				(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
				theme
			);
			await open(page);
			await complete(page);
			await editButton(page, 0).click();
			await expect(editor(page).getByRole('heading', { name: 'Edit set 1' })).toBeVisible();
			expect(await audit(page), 'editor').toEqual([]);
			await editor(page).getByTestId('delete-set').click();
			expect(await audit(page), 'confirmation').toEqual([]);

			// A deploy removed this build's chunk: the page says so, never a broken sheet.
			await page.reload();
			await expect(page.locator('main#main[data-store]')).toBeAttached();
			await expect(logger(page)).toBeVisible();
			await page.route(`**/${editorChunk()}`, (route) => route.abort());
			// The tap alone: a pointer moved onto the row first asks for the chunk too, and its failure
			// can replace the row before the click lands (WebKit).
			await editButton(page, 0).dispatchEvent('click');
			const updated = page.getByTestId('workout-app-updated');
			await expect(updated).toContainText('App updated — reload to continue');
			await expect(editor(page)).toHaveCount(0);
			if (theme === 'dark') await captureScreen(page, testInfo, 'workout-app-updated-sheet');
			expect(await audit(page), 'app updated').toEqual([]);

			// Reload picks up where it left off: the set is still there.
			await page.unroute(`**/${editorChunk()}`);
			await updated.getByRole('button', { name: 'Reload' }).click();
			await expect(page.locator('main#main[data-store]')).toBeAttached();
			await expect(rows(page).first()).toHaveAttribute('data-state', 'done');
		});
	}
});
