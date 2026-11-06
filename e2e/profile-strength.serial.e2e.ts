/**
 * Profile → Strength: optional 1RMs, each measured or estimated, or "I don't know my 1RMs".
 * Serial (one test at a time, after the functional suites): every test starts from a blank
 * training profile, which every browser and worker shares.
 */
import { expect, test, type Page } from '@playwright/test';
import { estimateOneRepMax } from '../src/lib/domain/e1rm';
import {
	captureScreen,
	gotoHydrated,
	profileAction,
	query,
	resetTrainingProfile,
	toastWith,
	trackConsoleErrors
} from './support';

/** The editor has loaded in place of the skeleton. */
async function editorReady(page: Page) {
	await expect(page.getByTestId('section-editor')).toHaveAttribute('aria-busy', 'false');
}

const unknownSwitch = (page: Page) => page.getByRole('switch', { name: 'I don’t know my 1RMs' });
const addButton = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const lift = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

/** The owner's current (not superseded) baselines, as stored. */
const currentLifts = () =>
	query(
		`select lift, custom_label, kind, source, value::float8 as value, unit,
			achieved_on::text as achieved_on, set_weight::float8 as set_weight, set_reps,
			set_rpe::float8 as set_rpe, method, confidence
		from strength_baselines where superseded_at is null order by lift`
	);

test.beforeEach(async () => {
	await resetTrainingProfile();
});

test('“I don’t know my 1RMs” shows the week-one explainer and stores no lifts', async ({
	page
}, testInfo) => {
	const errors = trackConsoleErrors(page);
	await gotoHydrated(page, '/profile');
	const row = page
		.getByRole('region', { name: 'Training profile' })
		.getByRole('link', { name: /Strength/ });
	await expect(row).toHaveAttribute('href', '/profile/strength');
	await row.click();
	await expect(page).toHaveURL('/profile/strength');
	await expect(page.getByRole('heading', { level: 1, name: 'Strength' })).toBeVisible();
	await editorReady(page);

	const explainer = page.getByTestId('baselines-explainer');
	await expect(unknownSwitch(page)).not.toBeChecked();
	await expect(explainer).toHaveCount(0);
	await unknownSwitch(page).check();
	await expect(
		explainer.getByRole('heading', { name: 'Week one finds your numbers' })
	).toBeVisible();
	await expect(explainer).toContainText('no maxing out');
	await expect(explainer).toContainText('how hard each set felt (RPE');
	// "I don't know" is the whole answer: there is nothing to add.
	await expect(addButton(page, 'Back squat')).toHaveCount(0);
	await captureScreen(page, testInfo, 'profile-strength-unknown');

	await page.getByTestId('save-section').click();
	await expect(toastWith(page, 'Saved')).toBeVisible();
	expect(await query('select baselines_unknown from athlete_profiles')).toEqual([
		{ baselines_unknown: true }
	]);
	expect(await query('select count(*)::int as n from strength_baselines')).toEqual([{ n: 0 }]);

	await page.reload();
	await editorReady(page);
	await expect(unknownSwitch(page)).toBeChecked();
	await expect(explainer).toBeVisible();
	const { scrollWidth, innerWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth
	}));
	expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
	expect(errors).toEqual([]);
});

test('a tested squat is stored as measured and a bench from a set as estimated, apart after a reload', async ({
	page
}, testInfo) => {
	await page.goto('/profile/strength');
	await editorReady(page);
	await addButton(page, 'Back squat').click();
	const squat = lift(page, 'Back squat');
	// The new lift takes focus, and leaves the add row; it has no kind until its source is set.
	await expect(squat.getByRole('heading', { name: 'Back squat' })).toBeFocused();
	await expect(addButton(page, 'Back squat')).toHaveCount(0);
	await expect(squat.getByTestId('baseline-kind')).toHaveCount(0);
	await squat.getByRole('radio', { name: 'Tested max' }).check();
	await expect(squat.getByTestId('baseline-kind')).toHaveText('Measured');
	await squat.getByRole('textbox', { name: '1RM' }).fill('140');
	await squat.getByLabel('When').fill('2026-10-12');

	await addButton(page, 'Bench press').click();
	const bench = lift(page, 'Bench press');
	await bench.getByRole('radio', { name: 'From a recent set' }).check();
	await expect(bench.getByTestId('baseline-kind')).toHaveText('Estimated');
	await expect(bench.getByRole('textbox', { name: '1RM' })).toHaveCount(0);
	await bench.getByRole('textbox', { name: 'Weight' }).fill('100');
	await bench.getByRole('textbox', { name: 'Reps' }).fill('5');
	await bench.getByRole('textbox', { name: 'RPE' }).fill('8');
	// Worked out live with the function the server stores it with (to the hundredth it keeps).
	const e1rm = estimateOneRepMax({ weight: 100, reps: 5, rpe: 8 })!;
	const stored = Math.round(e1rm.value * 100) / 100;
	const estimate = `≈ ${stored} kg estimated 1RM · ${e1rm.confidence} confidence`;
	await expect(bench.getByTestId('baseline-estimate')).toHaveText(estimate);

	await page.getByTestId('save-section').click();
	await expect(toastWith(page, 'Saved')).toBeVisible();
	expect(await currentLifts()).toEqual([
		{
			lift: 'back_squat',
			custom_label: '',
			kind: 'measured',
			source: 'tested',
			value: 140,
			unit: 'kg',
			achieved_on: '2026-10-12',
			set_weight: null,
			set_reps: null,
			set_rpe: null,
			method: null,
			confidence: null
		},
		{
			lift: 'bench_press',
			custom_label: '',
			kind: 'estimated',
			source: 'set',
			value: stored,
			unit: 'kg',
			achieved_on: null,
			set_weight: 100,
			set_reps: 5,
			set_rpe: 8,
			method: 'rpe-table',
			confidence: e1rm.confidence
		}
	]);
	expect(await query('select baselines_unknown from athlete_profiles')).toEqual([
		{ baselines_unknown: false }
	]);

	await page.reload();
	await editorReady(page);
	await expect(squat.getByTestId('baseline-kind')).toHaveText('Measured');
	await expect(squat.getByRole('radio', { name: 'Tested max' })).toBeChecked();
	await expect(squat.getByRole('textbox', { name: '1RM' })).toHaveValue('140');
	await expect(squat.getByLabel('When')).toHaveValue('2026-10-12');
	await expect(bench.getByTestId('baseline-kind')).toHaveText('Estimated');
	await expect(bench.getByRole('radio', { name: 'From a recent set' })).toBeChecked();
	// The computed 1RM is never offered as a max of the owner's: the set is what they edit.
	await expect(bench.getByRole('textbox', { name: '1RM' })).toHaveCount(0);
	await expect(bench.getByRole('textbox', { name: 'Weight' })).toHaveValue('100');
	await expect(bench.getByRole('textbox', { name: 'Reps' })).toHaveValue('5');
	await expect(bench.getByRole('textbox', { name: 'RPE' })).toHaveValue('8');
	await expect(bench.getByTestId('baseline-estimate')).toHaveText(estimate);
	// Every field stays inside its card: a date input is never squeezed into half a phone.
	for (const card of [squat, bench]) {
		const { x, width } = (await card.boundingBox())!;
		for (const field of await card.locator('input:not([type=radio])').all()) {
			const box = (await field.boundingBox())!;
			expect(box.x + box.width, await field.evaluate((el) => el.id)).toBeLessThanOrEqual(x + width);
		}
	}
	// Both kinds in one view: the measured squat, and the estimated bench below it.
	await squat.evaluate((el) => scrollTo(0, el.getBoundingClientRect().top + scrollY - 16));
	await captureScreen(page, testInfo, 'profile-strength');
});

test('a lift left blank shows its error until it is removed, and 600 kg is out of range', async ({
	page
}) => {
	await page.goto('/profile/strength');
	await editorReady(page);
	await addButton(page, 'Deadlift').click();
	await addButton(page, 'Back squat').click();
	const deadlift = lift(page, 'Deadlift');
	const squat = lift(page, 'Back squat');
	await squat.getByRole('radio', { name: 'Tested max' }).check();
	const squatMax = squat.getByRole('textbox', { name: '1RM' });
	await squatMax.fill('600');
	const save = page.getByTestId('save-section');
	await save.click();
	await expect(squat.getByRole('alert')).toHaveText('1RM between 1 and 500 kg');
	await expect(squatMax).toHaveAttribute('aria-invalid', 'true');
	await expect(deadlift.getByRole('alert')).toHaveText('How do you know this number?');

	await squatMax.fill('200');
	await save.click();
	await expect(page.getByTestId('save-error')).toBeVisible();
	await expect(squat.getByRole('alert')).toHaveCount(0);
	await expect(deadlift.getByRole('alert')).toHaveText('How do you know this number?');
	expect(await query('select count(*)::int as n from strength_baselines')).toEqual([{ n: 0 }]);

	// Removed from the keyboard: focus moves to the next lift, which keeps its place on screen,
	// its value and none of the removed lift's error.
	await squat.evaluate((el) => el.setAttribute('data-was-here', ''));
	await deadlift.getByRole('button', { name: 'Remove Deadlift' }).focus();
	await page.keyboard.press('Enter');
	await expect(deadlift).toHaveCount(0);
	await expect(squat.getByRole('button', { name: 'Remove Back squat' })).toBeFocused();
	await expect(page.getByRole('status').filter({ hasText: 'Removed Deadlift' })).toHaveCount(1);
	await expect(squat).toHaveAttribute('data-was-here', '');
	await expect(squat.getByRole('alert')).toHaveCount(0);
	await expect(squatMax).toHaveValue('200');

	await save.click();
	await expect(toastWith(page, 'Saved')).toBeVisible();
	expect(await currentLifts()).toMatchObject([
		{ lift: 'back_squat', kind: 'measured', source: 'tested', value: 200 }
	]);
});

test('lifts are added with buttons: suggestions for the disciplines, the rest on request, and one of your own', async ({
	page
}) => {
	// Weightlifting experience: its lifts are offered first.
	await query(
		`insert into discipline_experience (owner_id, discipline, level)
		select id, 'weightlifting', 'intermediate' from owners`
	);
	await page.goto('/profile/strength');
	await editorReady(page);
	const add = page.getByRole('region', { name: 'Add a lift you know' });
	await expect(add.getByRole('button')).toHaveText([
		'Snatch',
		'Clean & jerk',
		'Front squat',
		'Back squat',
		'Other lift',
		'More lifts'
	]);
	// Buttons, not radios: arrow keys move nothing and add nothing.
	await add.getByRole('button', { name: 'Snatch' }).focus();
	for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) {
		await page.keyboard.press(key);
	}
	await expect(page.getByTestId('baseline-lift')).toHaveCount(0);

	await add.getByRole('button', { name: 'More lifts' }).focus();
	await page.keyboard.press('Enter');
	await expect(add.getByRole('button', { name: 'Bench press' })).toBeFocused();
	await expect(add.getByRole('button')).toHaveText([
		'Snatch',
		'Clean & jerk',
		'Front squat',
		'Back squat',
		'Bench press',
		'Deadlift',
		'Overhead press',
		'Power clean',
		'Weighted pull-up',
		'Other lift'
	]);

	await add.getByRole('button', { name: 'Other lift' }).click();
	const own = page.getByTestId('baseline-lift');
	await own.getByRole('radio', { name: 'My best guess' }).check();
	await expect(own.getByTestId('baseline-kind')).toHaveText('Estimated');
	await own.getByRole('textbox', { name: '1RM' }).fill('90');
	await page.getByTestId('save-section').click();
	await expect(own.getByRole('alert')).toHaveText('Name the lift');
	await own.getByRole('textbox', { name: 'Lift name' }).fill('Zercher squat');
	await expect(lift(page, 'Zercher squat')).toBeVisible();
	await page.getByTestId('save-section').click();
	await expect(toastWith(page, 'Saved')).toBeVisible();
	expect(await currentLifts()).toMatchObject([
		{
			lift: 'custom',
			custom_label: 'Zercher squat',
			kind: 'estimated',
			source: 'estimate',
			value: 90
		}
	]);
});

test('switching back to “I don’t know” sets the saved lifts aside and keeps their history', async ({
	page,
	request
}) => {
	await profileAction(request, '/profile/strength?/save', {
		unknown: false,
		lifts: [
			{ lift: 'back_squat', source: 'tested', value: 140, unit: 'kg', achievedOn: '2026-10-12' },
			{ lift: 'bench_press', source: 'set', unit: 'kg', setWeight: 100, setReps: 5, setRpe: 8 }
		]
	});
	await page.goto('/profile/strength');
	await editorReady(page);
	await expect(page.getByTestId('baseline-lift')).toHaveCount(2);
	await unknownSwitch(page).check();
	await expect(page.getByTestId('baseline-lift')).toHaveCount(0);
	await expect(page.getByTestId('baselines-explainer')).toContainText(
		'any you saved before stay in your history'
	);
	await page.getByTestId('save-section').click();
	await expect(toastWith(page, 'Saved')).toBeVisible();
	expect(await query('select baselines_unknown from athlete_profiles')).toEqual([
		{ baselines_unknown: true }
	]);
	expect(
		await query(
			`select lift, kind, superseded_at is not null as superseded
			from strength_baselines order by lift`
		)
	).toEqual([
		{ lift: 'back_squat', kind: 'measured', superseded: true },
		{ lift: 'bench_press', kind: 'estimated', superseded: true }
	]);

	// After a reload the lifts are history: turning "I don't know" off starts from none.
	await page.reload();
	await editorReady(page);
	await expect(unknownSwitch(page)).toBeChecked();
	await unknownSwitch(page).uncheck();
	await expect(page.getByTestId('baseline-lift')).toHaveCount(0);
	await expect(addButton(page, 'Back squat')).toBeVisible();
});
