/**
 * The text and number input primitives on /design → Inputs (NumberField, TextArea, the date
 * TextField): phone keypads, sanitising, blank-stays-blank, labels, descriptions and errors.
 * Runs on Chromium and WebKit; axe for the same panel lives in a11y.e2e.ts.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { captureScreen, trackConsoleErrors } from './support';

async function openInputs(page: Page) {
	await page.goto('/design');
	// The tabs only switch once the page has hydrated; network idle stands in for that.
	await page.waitForLoadState('networkidle');
	await page.getByRole('tab', { name: 'Inputs' }).click();
	await expect(page.getByRole('heading', { name: 'Number field' })).toBeVisible();
}

/** Ids that the control's aria-describedby names but the document does not contain. */
function missingDescribedBy(control: Locator) {
	return control.evaluate((el) =>
		(el.getAttribute('aria-describedby') ?? '')
			.split(/\s+/)
			.filter((id) => id && !document.getElementById(id))
	);
}

test.describe('/design → Inputs: text and numbers', () => {
	test('NumberField opens the right keypad, keeps a clean number and stays blank when cleared', async ({
		page
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		await openInputs(page);
		const oneRm = page.getByRole('textbox', { name: /^Back squat 1RM/ });
		const rounds = page.getByRole('textbox', { name: 'Rounds', exact: true });
		const target = page.getByRole('textbox', { name: 'Target weight', exact: true });

		await expect(oneRm).toHaveAttribute('inputmode', 'decimal');
		await expect(oneRm).toHaveAttribute('enterkeyhint', 'next');
		await expect(rounds).toHaveAttribute('inputmode', 'numeric');
		await expect(rounds).toHaveAttribute('enterkeyhint', 'done');

		// Blank to start with, showing the placeholder rather than a made-up 0.
		await expect(oneRm).toHaveValue('');
		await expect(oneRm).toHaveAttribute('placeholder', '—');

		// Typed key by key: letters never land, a comma is a decimal point, and "82." survives
		// on the way to 82.5.
		await oneRm.pressSequentially('8a2,5');
		await expect(oneRm).toHaveValue('82.5');
		await oneRm.fill('');
		await oneRm.pressSequentially('1.2.5');
		await expect(oneRm).toHaveValue('1.25');

		// Whole numbers only: the decimal point is dropped.
		await rounds.fill('');
		await rounds.pressSequentially('8.5');
		await expect(rounds).toHaveValue('85');

		// Cleared means no number (null), not 0: 0 would be out of range and show the error.
		await target.fill('');
		await expect(target).toHaveValue('');
		await expect(target).not.toHaveAttribute('aria-invalid');
		await expect(page.getByText('Between 25 and 350 kg')).toHaveCount(0);

		await oneRm.scrollIntoViewIfNeeded();
		await captureScreen(page, testInfo, 'design-inputs-numbers');
		expect(errors).toEqual([]);
	});

	test('NumberField is named by its label, describes its unit and announces its error', async ({
		page
	}) => {
		await openInputs(page);
		const body = page.getByRole('textbox', { name: 'Body weight', exact: true });
		await expect(body).toHaveAccessibleName('Body weight');
		await expect(body).toHaveAccessibleDescription('kg');
		await expect(body).toHaveValue('81.4');

		const oneRm = page.getByRole('textbox', { name: /^Back squat 1RM/ });
		await expect(oneRm).toHaveAccessibleName(/^Back squat 1RM\s+Optional$/);
		await expect(oneRm).toHaveAccessibleDescription('kg Blank is fine: week one finds it.');

		// The error replaces the hint, and the description follows what is on screen.
		const target = page.getByRole('textbox', { name: 'Target weight', exact: true });
		await expect(target).toHaveValue('400');
		await expect(target).toHaveAttribute('aria-invalid', 'true');
		await expect(
			page.getByRole('alert').filter({ hasText: 'Between 25 and 350 kg' })
		).toBeVisible();
		await expect(page.getByText('Where you want to be.')).toHaveCount(0);
		await expect(target).toHaveAccessibleDescription('kg Between 25 and 350 kg');
		expect(await missingDescribedBy(target)).toEqual([]);

		await target.fill('80');
		await expect(target).not.toHaveAttribute('aria-invalid');
		await expect(page.getByRole('alert').filter({ hasText: 'Between 25 and 350 kg' })).toHaveCount(
			0
		);
		await expect(target).toHaveAccessibleDescription('kg Where you want to be.');
		expect(await missingDescribedBy(target)).toEqual([]);
	});

	test('TextArea has a label, an Optional marker, a character limit and an announced error', async ({
		page,
		browserName
	}, testInfo) => {
		await openInputs(page);
		const notes = page.getByRole('textbox', { name: /^Notes for the coach/ });
		await expect(notes).toHaveAccessibleName(/^Notes for the coach\s+Optional$/);
		await expect(notes).toHaveAccessibleDescription('Up to 300 characters.');
		await expect(notes).toHaveValue('');

		// Typing stops at the limit.
		await notes.fill('x'.repeat(298));
		await notes.pressSequentially('abcd');
		await expect(notes).toHaveValue(`${'x'.repeat(298)}ab`);

		if (browserName === 'chromium') {
			// `field-sizing: content` (Chromium; WebKit keeps `rows` and a resize handle).
			await notes.fill('');
			const empty = (await notes.boundingBox())!.height;
			await notes.fill('One\nTwo\nThree\nFour\nFive\nSix');
			expect((await notes.boundingBox())!.height).toBeGreaterThan(empty);
		}

		const limits = page.getByRole('textbox', { name: 'Limitations', exact: true });
		await expect(limits).toHaveValue(/^Left shoulder/);
		await expect(limits).not.toHaveAttribute('aria-describedby');

		const injury = page.getByRole('textbox', { name: 'Injury', exact: true });
		await expect(injury).toHaveAttribute('aria-invalid', 'true');
		await expect(
			page.getByRole('alert').filter({ hasText: 'Say what hurts so the plan can work around it' })
		).toBeVisible();
		expect(await missingDescribedBy(injury)).toEqual([]);
		await injury.fill('Left knee, sore on deep squats since March');
		await expect(injury).not.toHaveAttribute('aria-invalid');
		await expect(injury).toHaveAccessibleDescription('What hurts, and since when.');
		expect(await missingDescribedBy(injury)).toEqual([]);

		await injury.scrollIntoViewIfNeeded();
		await captureScreen(page, testInfo, 'design-inputs-text');
	});

	test('the date TextField takes an ISO date, keeps the field height and announces its error', async ({
		page
	}, testInfo) => {
		await openInputs(page);
		const raceDay = page.getByLabel(/^Race day/);
		await expect(raceDay).toHaveAttribute('type', 'date');
		await expect(raceDay).toHaveAccessibleName(/^Race day\s+Optional$/);
		await expect(raceDay).toHaveValue('');

		// Blank and filled date inputs are as tall as every other field (56 px).
		expect(Math.round((await raceDay.boundingBox())!.height)).toBe(56);
		await raceDay.fill('2027-03-14');
		await expect(raceDay).toHaveValue('2027-03-14');
		expect(Math.round((await raceDay.boundingBox())!.height)).toBe(56);

		const eventDate = page.getByLabel('Event date', { exact: true });
		await expect(eventDate).toHaveAttribute('aria-invalid', 'true');
		await expect(page.getByRole('alert').filter({ hasText: 'Pick the event date' })).toBeVisible();
		expect(await missingDescribedBy(eventDate)).toEqual([]);
		await eventDate.fill('2027-03-14');
		await expect(eventDate).toHaveValue('2027-03-14');
		await expect(eventDate).not.toHaveAttribute('aria-invalid');
		await expect(eventDate).toHaveAccessibleDescription('The plan counts down to it.');
		expect(await missingDescribedBy(eventDate)).toEqual([]);

		await raceDay.scrollIntoViewIfNeeded();
		await captureScreen(page, testInfo, 'design-inputs-dates');
	});
});
