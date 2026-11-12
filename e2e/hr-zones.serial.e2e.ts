/**
 * Heart rate in Profile → Running & Muay Thai and in onboarding's specifics step, which share the
 * editor: max, resting and threshold heart rate as optional whole bpm, saved and read back, with
 * the schema's range and order messages at their fields. A run session then reads its zones in
 * beats per minute ('Zone 2 · 134–148 bpm'), and the zone alone once the rates are cleared. On
 * the iPhone and at the desktop window, both themes audited. Serial: the one owner's training
 * profile and program (e2e/program-support.ts).
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { auditBothThemes } from './analytics-support';
import { DESKTOP, expectNoSideScroll } from './desktop';
import { PROGRAM_TZ, seedProgram } from './program-support';
import {
	captureScreen,
	gotoHydrated,
	profileAction,
	query,
	resetTrainingProfile,
	toastWith,
	trackConsoleErrors
} from './support';

test.use({ timezoneId: PROGRAM_TZ });

test.beforeEach(async () => {
	await resetTrainingProfile();
});

test.afterAll(async () => {
	await resetTrainingProfile();
});

/** A running goal, straight into the table the goal services write: it brings the running part. */
async function seedRunningGoal() {
	await query(
		`insert into training_goals (owner_id, kind, title, disciplines, priority, focus)
		 select id, 'general', 'Run more', array['running'], 1, 'Get better at it' from owners`
	);
}

/** The heart rates stored on the running profile, as numbers. */
const storedRates = () =>
	query<{ max: number | null; resting: number | null; threshold: number | null }>(
		`select max_hr as max, resting_hr as resting, threshold_hr as threshold from running_profiles`
	);

const KINDS = ['Max', 'Resting', 'Threshold'] as const;
const rates = (page: Page) => page.getByRole('region', { name: 'Running', exact: true });
const rate = (scope: Locator, kind: (typeof KINDS)[number]) =>
	scope.getByRole('textbox', { name: `${kind} heart rate`, exact: true });

/** Type the three rates; '' leaves a field blank. */
async function fillRates(page: Page, [max, resting, threshold]: [string, string, string]) {
	const group = rates(page);
	await rate(group, 'Max').fill(max);
	await rate(group, 'Resting').fill(resting);
	await rate(group, 'Threshold').fill(threshold);
}

async function editorReady(page: Page) {
	await expect(page.getByTestId('section-editor')).toHaveAttribute('aria-busy', 'false');
}

for (const [viewport, options] of [
	['iphone', {}],
	['desktop', DESKTOP]
] as const) {
	test.describe(`heart rate (${viewport})`, () => {
		test.use(options);

		test('Profile saves the three rates, which persist across a reload', async ({
			page
		}, testInfo) => {
			const errors = trackConsoleErrors(page);
			await seedRunningGoal();
			await gotoHydrated(page, '/profile/specifics');
			await editorReady(page);
			const group = rates(page);
			// Playwright cannot show the iOS keypad: the attribute that opens the numeric one.
			for (const kind of KINDS) {
				await expect(rate(group, kind)).toHaveAttribute('inputmode', 'numeric');
				await expect(rate(group, kind)).toHaveAccessibleDescription(
					'bpm Optional — sets your heart-rate zones'
				);
			}
			await fillRates(page, ['190', '50', '']);
			await page.getByTestId('save-section').click();
			await expect(toastWith(page, 'Saved')).toBeVisible();
			expect(await storedRates()).toEqual([{ max: 190, resting: 50, threshold: null }]);

			await page.reload();
			await editorReady(page);
			await expect(rate(group, 'Max')).toHaveValue('190');
			await expect(rate(group, 'Resting')).toHaveValue('50');
			await expect(rate(group, 'Threshold')).toHaveValue('');
			await expectNoSideScroll(page);
			await rate(group, 'Threshold').scrollIntoViewIfNeeded();
			await captureScreen(page, testInfo, `hr-fields-${viewport}`);
			await auditBothThemes(page, 'Profile heart rate');
			expect(errors).toEqual([]);
		});

		test('rates out of range or out of order are refused at their fields', async ({ page }) => {
			await seedRunningGoal();
			await gotoHydrated(page, '/profile/specifics');
			await editorReady(page);
			const group = rates(page);
			await fillRates(page, ['170', '20', '180']);
			await page.getByTestId('save-section').click();
			await expect(page.getByTestId('save-error')).toContainText('Check the highlighted fields');
			await expect(group.getByRole('alert')).toHaveText([
				'Resting heart rate between 30 and 110',
				'Threshold heart rate must be below your max'
			]);
			await expect(rate(group, 'Resting')).toHaveAttribute('aria-invalid', 'true');
			await expect(rate(group, 'Threshold')).toHaveAttribute('aria-invalid', 'true');
			await expect(rate(group, 'Max')).not.toHaveAttribute('aria-invalid', 'true');
			expect(await storedRates()).toEqual([]);
			await auditBothThemes(page, 'heart rate errors');

			await rate(group, 'Resting').fill('48');
			await rate(group, 'Threshold').fill('160');
			await page.getByTestId('save-section').click();
			await expect(toastWith(page, 'Saved')).toBeVisible();
			await expect(group.getByRole('alert')).toHaveCount(0);
			expect(await storedRates()).toEqual([{ max: 170, resting: 48, threshold: 160 }]);
		});

		test('a run session shows its zone in bpm, and the zone alone once cleared', async ({
			page,
			request
		}, testInfo) => {
			const seeded = await seedProgram(request, { fixture: 'hybrid', start: 'next_week' });
			const run = seeded.sessions.find((s) => s.title === 'Intervals')!;
			await profileAction(request, '/profile/specifics?/save', {
				running: { unit: 'km', races: [], heartRate: { max: 190, resting: 50, threshold: null } },
				muayThai: null
			});
			await gotoHydrated(page, `/train/session/${run.lineage}`);
			const coolDown = page.getByTestId('run-step').last();
			await expect(coolDown).toHaveText(/^\s*Cool-down 10:00\s*Zone 2 · 134–148 bpm\s*$/);
			await expectNoSideScroll(page);
			await captureScreen(page, testInfo, `hr-session-${viewport}`);
			await auditBothThemes(page, 'run session in zones');

			// Cleared in the editor: all three blank clears what was saved.
			await gotoHydrated(page, '/profile/specifics');
			await editorReady(page);
			await fillRates(page, ['', '', '']);
			await page.getByTestId('save-section').click();
			await expect(toastWith(page, 'Saved')).toBeVisible();
			expect(await storedRates()).toEqual([{ max: null, resting: null, threshold: null }]);
			await gotoHydrated(page, `/train/session/${run.lineage}`);
			await expect(coolDown).toHaveText(/^\s*Cool-down 10:00\s*Zone 2\s*$/);
		});

		test('onboarding’s specifics step takes the same fields, and Continue saves them', async ({
			page
		}, testInfo) => {
			await seedRunningGoal();
			await gotoHydrated(page, '/onboarding/specifics');
			await expect(page.locator('.step[data-step="specifics"]')).toBeVisible();
			await editorReady(page);
			for (const kind of KINDS) {
				await expect(rate(rates(page), kind)).toHaveAttribute('inputmode', 'numeric');
			}
			await fillRates(page, ['186', '', '168']);
			await expectNoSideScroll(page);
			await auditBothThemes(page, 'onboarding heart rate');
			await captureScreen(page, testInfo, `hr-onboarding-${viewport}`);
			await page.getByTestId('step-continue').click();
			await expect(page).toHaveURL('/onboarding/equipment');
			expect(await storedRates()).toEqual([{ max: 186, resting: null, threshold: 168 }]);

			// Back on the step, they read back as saved.
			await gotoHydrated(page, '/onboarding/specifics');
			await editorReady(page);
			await expect(rate(rates(page), 'Max')).toHaveValue('186');
			await expect(rate(rates(page), 'Threshold')).toHaveValue('168');
		});
	});
}
