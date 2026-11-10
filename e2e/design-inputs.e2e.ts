/**
 * The input primitives on /design → Inputs. NumberField, TextArea and the date TextField: phone
 * keypads, sanitising, blank-stays-blank, labels, descriptions and errors. NumberStepper: its
 * error. ChoiceGroup and
 * DayPicker: keyboard, value order, selection marks, errors and hit areas. Toggle: a switch
 * the whole row flips. TagInput: adding, refusing, removing, suggestions, limits and what it
 * announces.
 * Runs on Chromium and WebKit; axe for the same panel lives in a11y-suite.ts.
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

	test('NumberStepper marks its value invalid and announces its error until it is fixed', async ({
		page
	}, testInfo) => {
		await openInputs(page);
		const days = page.getByRole('spinbutton', { name: 'Training days', exact: true });
		const message = 'Only 3 days are free: 5 won’t fit';
		await expect(days).toHaveAttribute('aria-valuenow', '5');
		await expect(days).toHaveAttribute('aria-invalid', 'true');
		await expect(page.getByRole('alert').filter({ hasText: message })).toBeVisible();
		// The error replaces the hint, and the description follows what is on screen.
		await expect(page.getByText('Tue, Thu and Sat are free.')).toHaveCount(0);
		await expect(days).toHaveAccessibleDescription(message);
		expect(await missingDescribedBy(days)).toEqual([]);
		await days.scrollIntoViewIfNeeded();
		await captureScreen(page, testInfo, 'design-inputs-stepper-error');

		// Still too many: the new count is announced.
		await page.getByRole('button', { name: 'Decrease Training days' }).click();
		await expect(
			page.getByRole('alert').filter({ hasText: 'Only 3 days are free: 4 won’t fit' })
		).toBeVisible();
		await page.getByRole('button', { name: 'Decrease Training days' }).click();
		await expect(days).toHaveAttribute('aria-valuenow', '3');
		await expect(days).not.toHaveAttribute('aria-invalid');
		await expect(page.getByRole('alert').filter({ hasText: 'Only 3 days are free' })).toHaveCount(
			0
		);
		await expect(days).toHaveAccessibleDescription('Tue, Thu and Sat are free.');
		expect(await missingDescribedBy(days)).toEqual([]);

		// A stepper with no hint and no error is described by nothing.
		await expect(page.getByRole('spinbutton', { name: 'Reps' })).not.toHaveAttribute(
			'aria-describedby'
		);
	});
});

const WEEK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** The drawn part (`.tick`, `.mark`) of the option whose input is `control`. */
function optionPart(control: Locator, part: '.tick' | '.mark') {
	return control.locator(`xpath=following-sibling::*[1]`).locator(part);
}

/** A colour token as the browser computes it, to compare with a computed border. */
function tokenColor(page: Page, token: string) {
	return page.evaluate((t) => {
		const probe = document.createElement('span');
		probe.style.color = `var(${t})`;
		document.body.append(probe);
		const color = getComputedStyle(probe).color;
		probe.remove();
		return color;
	}, token);
}

test.describe('/design → Inputs: choices and days', () => {
	test('a single ChoiceGroup is named by its legend, is one tab stop and moves with arrow keys', async ({
		page,
		browserName
	}) => {
		const errors = trackConsoleErrors(page);
		await openInputs(page);
		const level = page.getByRole('group', { name: 'Level', exact: true });
		await expect(level.getByRole('radio')).toHaveCount(3);
		const novice = level.getByRole('radio', { name: 'Novice' });
		const intermediate = level.getByRole('radio', { name: 'Intermediate' });
		const advanced = level.getByRole('radio', { name: 'Advanced' });
		await expect(intermediate).toBeChecked();

		// Selected is a tick as well as a colour.
		await expect(optionPart(intermediate, '.tick')).toBeVisible();
		await expect(optionPart(novice, '.tick')).toBeHidden();

		await intermediate.focus();
		if (browserName === 'chromium') {
			// Tab leaves the group and comes back to the selected option, not the first one.
			// (macOS WebKit tabs only between text fields unless Full Keyboard Access is on.)
			await page.keyboard.press('Shift+Tab');
			await expect(level.getByRole('radio').and(page.locator(':focus'))).toHaveCount(0);
			await page.keyboard.press('Tab');
			await expect(intermediate).toBeFocused();
		}

		await page.keyboard.press('ArrowRight');
		await expect(advanced).toBeFocused();
		await expect(advanced).toBeChecked();
		await page.keyboard.press('ArrowLeft');
		await page.keyboard.press('ArrowLeft');
		await expect(novice).toBeChecked();
		await expect(level.getByRole('radio', { checked: true })).toHaveCount(1);
		await expect(optionPart(novice, '.tick')).toBeVisible();
		await expect(optionPart(intermediate, '.tick')).toBeHidden();

		// An optional single choice is an explicit "Any" that the caller stores as null.
		const time = page.getByRole('group', { name: 'Best time to train' });
		await expect(time).toHaveAccessibleDescription('Any leaves it to the coach.');
		await expect(time.getByRole('radio', { name: 'Any' })).toBeChecked();
		await expect(page.getByTestId('time-value')).toHaveText('value: null');
		await time.getByRole('radio', { name: 'Morning' }).check();
		await expect(page.getByTestId('time-value')).toHaveText('value: "morning"');
		await time.getByRole('radio', { name: 'Any' }).check();
		await expect(page.getByTestId('time-value')).toHaveText('value: null');
		expect(errors).toEqual([]);
	});

	test("a multiple ChoiceGroup keeps the options' order whatever order they are tapped in", async ({
		page,
		browserName
	}) => {
		await openInputs(page);
		const group = page.getByRole('group', { name: 'Disciplines' });
		await expect(group).toHaveAccessibleDescription('Pick any that apply.');
		const value = page.getByTestId('disciplines-value');
		await expect(value).toHaveText('value: ["strength"]');
		const strength = group.getByRole('checkbox', { name: 'Strength' });
		const running = group.getByRole('checkbox', { name: 'Running' });

		await group.getByRole('checkbox', { name: 'Hypertrophy' }).click();
		await running.click();
		await expect(value).toHaveText('value: ["strength","running","hypertrophy"]');
		await expect(optionPart(running, '.tick')).toBeVisible();
		await expect(
			optionPart(group.getByRole('checkbox', { name: 'Muay Thai' }), '.tick')
		).toBeHidden();

		// Every option is its own tab stop (asserted on Chromium, as above), and Space toggles it.
		await strength.focus();
		await page.keyboard.press('Space');
		await expect(strength).not.toBeChecked();
		if (browserName === 'chromium') {
			await page.keyboard.press('Tab');
			await expect(running).toBeFocused();
		} else {
			await running.focus();
		}
		await page.keyboard.press('Space');
		await expect(value).toHaveText('value: ["hypertrophy"]');
	});

	test('a selected card shows a filled mark, and card errors are announced until one is picked', async ({
		page
	}, testInfo) => {
		await openInputs(page);
		// The mark fills (a thick ring) when its card is selected; the others stay a hairline.
		const ring = (card: Locator) =>
			optionPart(card, '.mark').evaluate((el) => parseFloat(getComputedStyle(el).borderTopWidth));
		const gym = page.getByRole('group', { name: 'Where do you train most?' });
		const commercial = gym.getByRole('radio', { name: /^Commercial gym/ });
		const home = gym.getByRole('radio', { name: /^Home or garage gym/ });
		await expect(commercial).toBeChecked();
		expect(await ring(commercial)).toBeGreaterThan(4);
		expect(await ring(home)).toBeLessThan(2);
		await home.click();
		await expect(home).toBeChecked();
		await expect.poll(() => ring(home)).toBeGreaterThan(4);
		await expect.poll(() => ring(commercial)).toBeLessThan(2);

		const equipment = page.getByRole('group', { name: 'Equipment at home' });
		const cards = equipment.getByRole('checkbox');
		await expect(cards).toHaveCount(2);
		const message = 'Pick at least one so the plan uses only what you have';
		const alert = page.getByRole('alert').filter({ hasText: message });
		await expect(alert).toBeVisible();
		await expect(equipment).toHaveAccessibleDescription(message);
		for (const card of await cards.all())
			await expect(card).toHaveAttribute('aria-invalid', 'true');
		expect(await missingDescribedBy(equipment)).toEqual([]);

		await equipment.scrollIntoViewIfNeeded();
		await captureScreen(page, testInfo, 'design-inputs-choices');

		const dumbbells = equipment.getByRole('checkbox', { name: /^Dumbbells/ });
		await dumbbells.click();
		await expect(dumbbells).toBeChecked();
		await expect(alert).toHaveCount(0);
		for (const card of await cards.all()) await expect(card).not.toHaveAttribute('aria-invalid');
		await expect(equipment).not.toHaveAttribute('aria-describedby');
		await expect.poll(() => ring(dumbbells)).toBeGreaterThan(4);
	});

	test('every choice option is at least 44 px tall', async ({ page }) => {
		await openInputs(page);
		const options = page.getByRole('region', { name: 'Choice group' }).locator('input');
		await expect(options).toHaveCount(15);
		for (const option of await options.all()) {
			const box = (await option.boundingBox())!;
			expect(box.height).toBeGreaterThanOrEqual(44);
			expect(box.width).toBeGreaterThanOrEqual(44);
		}
	});

	test('DayPicker names seven days Monday first and keeps its value in week order', async ({
		page
	}) => {
		await openInputs(page);
		const picker = page.getByRole('group', { name: 'Days you can train' });
		const days = picker.getByRole('checkbox');
		await expect(days).toHaveCount(7);
		for (const [i, day] of WEEK.entries()) await expect(days.nth(i)).toHaveAccessibleName(day);
		await expect(picker).toHaveAccessibleDescription('Tap every day that works.');
		const value = page.getByTestId('days-value');
		await expect(value).toHaveText('value: ["tue","thu","sat"]');
		// A picked day shows a tick as well as the fill.
		const monday = picker.getByRole('checkbox', { name: 'Monday' });
		const thursday = picker.getByRole('checkbox', { name: 'Thursday' });
		await expect(optionPart(thursday, '.tick')).toBeVisible();
		await expect(optionPart(monday, '.tick')).toBeHidden();

		await picker.getByRole('checkbox', { name: 'Sunday' }).click();
		await monday.click();
		await expect(value).toHaveText('value: ["mon","tue","thu","sat","sun"]');
		await expect(optionPart(monday, '.tick')).toBeVisible();

		await thursday.focus();
		await page.keyboard.press('Space');
		await expect(thursday).not.toBeChecked();
		await expect(value).toHaveText('value: ["mon","tue","sat","sun"]');
		await expect(optionPart(thursday, '.tick')).toBeHidden();
	});

	test('DayPicker hit areas stay 44 × 44 px inside a padded card at 393 px and never overlap', async ({
		page
	}, testInfo) => {
		await openInputs(page);
		expect(page.viewportSize()?.width).toBe(393);
		const picker = page.getByRole('group', { name: 'Days you can train' });
		await picker.evaluate((el) => el.scrollIntoView({ block: 'center' }));

		// The premise: the row sits inside a card's padding, which costs it 48 px of width.
		const inset = await picker.evaluate((el) => {
			const card = el.closest('.surface')!.getBoundingClientRect();
			const own = el.getBoundingClientRect();
			return Math.min(own.left - card.left, card.right - own.right);
		});
		expect(inset).toBeGreaterThanOrEqual(24);

		const boxes = await Promise.all(
			(await picker.getByRole('checkbox').all()).map(async (day) => (await day.boundingBox())!)
		);
		for (const [i, box] of boxes.entries()) {
			expect(box.width, WEEK[i]).toBeGreaterThanOrEqual(44);
			expect(box.height, WEEK[i]).toBeGreaterThanOrEqual(44);
			if (i > 0) {
				const before = boxes[i - 1]!;
				expect(box.x, WEEK[i]).toBeGreaterThanOrEqual(before.x + before.width - 0.05);
			}
			// Each edge of the hit area belongs to that day: nothing covers it, no neighbour reaches in.
			const midX = box.x + box.width / 2;
			const midY = box.y + box.height / 2;
			const edges = [
				[box.x + 1, midY],
				[box.x + box.width - 1, midY],
				[midX, box.y + 1],
				[midX, box.y + box.height - 1]
			];
			for (const [x, y] of edges) {
				const hit = await page.evaluate(
					([px, py]) => document.elementFromPoint(px!, py!)?.getAttribute('aria-label'),
					[x, y]
				);
				expect(hit, `${WEEK[i]} at ${x}, ${y}`).toBe(WEEK[i]);
			}
		}
		await captureScreen(page, testInfo, 'design-inputs-days');
	});

	test('DayPicker marks every day invalid and announces its error until it is fixed', async ({
		page
	}) => {
		await openInputs(page);
		const picker = page.getByRole('group', { name: 'Strength days' });
		const days = picker.getByRole('checkbox');
		const alert = page
			.getByRole('alert')
			.filter({ hasText: 'Pick at least two days for strength' });
		await expect(alert).toBeVisible();
		await expect(picker).toHaveAccessibleDescription('Pick at least two days for strength');
		await expect(picker.getByText('Two or more.')).toHaveCount(0);
		for (const day of await days.all()) await expect(day).toHaveAttribute('aria-invalid', 'true');
		expect(await missingDescribedBy(picker)).toEqual([]);

		// Not only words: the days still open take the danger border.
		const danger = await tokenColor(page, '--color-danger');
		const border = (day: Locator) =>
			day.evaluate((el) => getComputedStyle(el.nextElementSibling!).borderTopColor);
		const friday = picker.getByRole('checkbox', { name: 'Friday' });
		await expect.poll(() => border(friday)).toBe(danger);

		await friday.click();
		await expect(alert).toHaveCount(0);
		await expect(picker).toHaveAccessibleDescription('Two or more.');
		for (const day of await days.all()) await expect(day).not.toHaveAttribute('aria-invalid');
		await expect
			.poll(() => border(picker.getByRole('checkbox', { name: 'Monday' })))
			.not.toBe(danger);
		expect(await missingDescribedBy(picker)).toEqual([]);
	});
});

/** The centre of an element's box, in viewport coordinates. */
async function centre(target: Locator) {
	const box = (await target.boundingBox())!;
	return [box.x + box.width / 2, box.y + box.height / 2] as const;
}

/** Whether `element` is what a tap at each point lands on. */
function ownsPoints(element: Locator, points: (readonly [number, number])[]) {
	return element.evaluate(
		(el, pts) => pts.map(([x, y]) => document.elementFromPoint(x, y) === el),
		points
	);
}

test.describe('/design → Inputs: toggle and tags', () => {
	test('a Toggle is a named switch that the whole row, a tap or Space flips', async ({
		page
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		await openInputs(page);
		const toggle = page.getByRole('switch', { name: 'I don’t know my 1RMs' });
		const value = page.getByTestId('toggle-value');
		await toggle.scrollIntoViewIfNeeded();

		// The title is the name and the description its aria-describedby, not part of the name.
		await expect(toggle).toHaveAccessibleName('I don’t know my 1RMs');
		await expect(toggle).toHaveAccessibleDescription(
			'Week one finds them from how hard the sets feel.'
		);
		expect(await missingDescribedBy(toggle)).toEqual([]);
		await expect(toggle).toBeChecked();
		await expect(value).toHaveText('value: true');

		// The checkbox covers the row: at least 44 px tall, and the title, the description and
		// the track are all its hit area.
		const row = (await toggle.boundingBox())!;
		expect(row.height).toBeGreaterThanOrEqual(44);
		const title = page.getByText('I don’t know my 1RMs', { exact: true });
		const description = page.getByText('Week one finds them from how hard the sets feel.');
		const track = [row.x + row.width - 26, row.y + row.height / 2] as const;
		expect(
			await ownsPoints(toggle, [await centre(title), await centre(description), track])
		).toEqual([true, true, true]);

		await captureScreen(page, testInfo, 'design-inputs-toggle');

		// Tapping the title text flips it, and so does Space.
		const [x, y] = await centre(title);
		await page.touchscreen.tap(x, y);
		await expect(
			page.getByRole('switch', { name: 'I don’t know my 1RMs', checked: false })
		).toBeVisible();
		await expect(value).toHaveText('value: false');
		await toggle.focus();
		await page.keyboard.press('Space');
		await expect(
			page.getByRole('switch', { name: 'I don’t know my 1RMs', checked: true })
		).toBeVisible();
		await expect(value).toHaveText('value: true');

		// Without a description there is nothing to describe it.
		const home = page.getByRole('switch', { name: 'I also train at home' });
		await expect(home).not.toBeChecked();
		await expect(home).not.toHaveAttribute('aria-describedby');
		expect((await home.boundingBox())!.height).toBeGreaterThanOrEqual(44);
		await home.focus();
		await page.keyboard.press('Space');
		await expect(home).toBeChecked();
		expect(errors).toEqual([]);
	});

	test('TagInput adds a trimmed item with Return or Add and clears the field; Add waits for text', async ({
		page
	}) => {
		const errors = trackConsoleErrors(page);
		await openInputs(page);
		const tags = page.getByTestId('tags-avoid');
		const field = tags.getByRole('textbox', { name: 'Movements to avoid' });
		const add = tags.getByRole('button', { name: 'Add to movements to avoid' });
		const status = tags.getByRole('status');
		const value = page.getByTestId('tags-value');
		await expect(value).toHaveText('value: ["Overhead press"]');
		await expect(field).toHaveAccessibleDescription('Up to three here, 60 characters each.');

		// Blank, or only spaces, is nothing to add.
		await expect(add).toBeDisabled();
		await field.fill('   ');
		await expect(add).toBeDisabled();
		await field.press('Enter');
		await expect(value).toHaveText('value: ["Overhead press"]');

		await field.fill('  Lateral raise ');
		await expect(add).toBeEnabled();
		await field.press('Enter');
		await expect(value).toHaveText('value: ["Overhead press","Lateral raise"]');
		await expect(field).toHaveValue('');
		await expect(field).toBeFocused();
		await expect(status).toHaveText('Added Lateral raise');
		await expect(tags.getByRole('listitem')).toHaveText(['Overhead press', 'Lateral raise']);

		// Add does the same, then hands the field back for the next one.
		const likes = page.getByTestId('tags-likes');
		const likesField = likes.getByRole('textbox', { name: 'Exercises you enjoy' });
		await likesField.fill(' Romanian deadlift  ');
		await likes.getByRole('button', { name: 'Add to exercises you enjoy' }).click();
		await expect(likes.getByRole('listitem')).toHaveText(['Front squat', 'Romanian deadlift']);
		await expect(likesField).toHaveValue('');
		await expect(likesField).toBeFocused();
		await expect(likes.getByRole('status')).toHaveText('Added Romanian deadlift');
		await expect(likes.getByRole('button', { name: 'Add to exercises you enjoy' })).toBeDisabled();
		expect(errors).toEqual([]);
	});

	test('TagInput refuses a repeat in any case, keeps the text and says so every time', async ({
		page
	}) => {
		await openInputs(page);
		const tags = page.getByTestId('tags-avoid');
		const field = tags.getByRole('textbox', { name: 'Movements to avoid' });
		const add = tags.getByRole('button', { name: 'Add to movements to avoid' });
		const status = tags.getByRole('status');
		// Every text the live region shows, in order: a live region only speaks when it changes.
		await status.evaluate((el) => {
			const seen: string[] = [];
			Object.assign(window, { seen });
			new MutationObserver(() => seen.push(el.textContent ?? '')).observe(el, {
				childList: true,
				characterData: true,
				subtree: true
			});
		});

		const message = 'Overhead press is already on the list';
		await field.fill('overhead PRESS');
		await field.press('Enter');
		await expect(status).toHaveText(message);
		await expect(field).toHaveValue('overhead PRESS');
		await add.click();
		// The same words a second time: cleared first, so they are read again.
		await expect
			.poll(() => page.evaluate(() => (window as unknown as { seen: string[] }).seen.join('|')))
			.toMatch(new RegExp(`${message}\\|+${message}$`));
		await expect(tags.getByRole('listitem')).toHaveText(['Overhead press']);
		await expect(page.getByTestId('tags-value')).toHaveText('value: ["Overhead press"]');
	});

	test('TagInput remove buttons are named, have a 44 px hit area, keep focus and are announced', async ({
		page
	}, testInfo) => {
		await openInputs(page);
		const tags = page.getByTestId('tags-avoid');
		const field = tags.getByRole('textbox', { name: 'Movements to avoid' });
		const status = tags.getByRole('status');
		const value = page.getByTestId('tags-value');
		await field.fill('Dips');
		await field.press('Enter');
		await expect(value).toHaveText('value: ["Overhead press","Dips"]');

		const removes = tags.getByRole('list', { name: 'Movements to avoid' }).getByRole('button');
		await expect(removes).toHaveCount(2);
		await expect(removes.nth(0)).toHaveAccessibleName('Remove Overhead press');
		await expect(removes.nth(1)).toHaveAccessibleName('Remove Dips');
		await tags.scrollIntoViewIfNeeded();
		for (const remove of await removes.all()) {
			const [cx, cy] = await centre(remove);
			// The corners of a 43.5 px square around the centre: the hit area is 44 × 44.
			const d = 21.75;
			const corners = [
				[cx - d, cy - d],
				[cx + d, cy - d],
				[cx - d, cy + d],
				[cx + d, cy + d]
			] as const;
			expect(await ownsPoints(remove, [...corners])).toEqual([true, true, true, true]);
			const pill = (await remove.locator('xpath=..').boundingBox())!;
			expect(pill.height).toBeGreaterThanOrEqual(44);
		}
		await captureScreen(page, testInfo, 'design-inputs-tags');

		// From the keyboard, focus moves to the next item, then back to the field once the
		// list is empty.
		await removes.nth(0).focus();
		await page.keyboard.press('Enter');
		await expect(value).toHaveText('value: ["Dips"]');
		await expect(status).toHaveText('Removed Overhead press');
		await expect(tags.getByRole('button', { name: 'Remove Dips' })).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(value).toHaveText('value: []');
		await expect(status).toHaveText('Removed Dips');
		await expect(tags.getByRole('list', { name: 'Movements to avoid' })).toHaveCount(0);
		await expect(field).toBeFocused();
	});

	test('a TagInput suggestion adds in one tap and is no longer offered', async ({ page }) => {
		await openInputs(page);
		const tags = page.getByTestId('tags-avoid');
		const field = tags.getByRole('textbox', { name: 'Movements to avoid' });
		const offered = tags.getByRole('group', { name: 'Suggestions for Movements to avoid' });
		const value = page.getByTestId('tags-value');
		await tags.getByRole('button', { name: 'Remove Overhead press' }).click();
		await expect(value).toHaveText('value: []');
		await expect(offered.getByRole('button')).toHaveText([
			'Dips',
			'Behind-the-neck press',
			'Upright row'
		]);

		await offered.getByRole('button', { name: 'Add Dips' }).tap();
		await expect(value).toHaveText('value: ["Dips"]');
		await expect(tags.getByRole('status')).toHaveText('Added Dips');
		await expect(offered.getByRole('button')).toHaveText(['Behind-the-neck press', 'Upright row']);

		// Typed in another case, a suggestion counts as added.
		await field.fill('upright ROW');
		await field.press('Enter');
		await expect(value).toHaveText('value: ["Dips","upright ROW"]');
		await expect(offered.getByRole('button')).toHaveText(['Behind-the-neck press']);

		// From the keyboard: the last suggestion fills the list, the suggestions go, and focus
		// returns to the field instead of being lost.
		await offered.getByRole('button', { name: 'Add Behind-the-neck press' }).focus();
		await page.keyboard.press('Enter');
		await expect(value).toHaveText('value: ["Dips","upright ROW","Behind-the-neck press"]');
		await expect(offered).toHaveCount(0);
		await expect(field).toBeFocused();
	});

	test('TagInput holds maxlength and says why typing stopped', async ({ page }) => {
		await openInputs(page);
		const tags = page.getByTestId('tags-avoid');
		const field = tags.getByRole('textbox', { name: 'Movements to avoid' });
		const status = tags.getByRole('status');

		// 60 characters: typing stops there, and the field says why.
		await expect(field).toHaveAttribute('maxlength', '60');
		await field.fill('x'.repeat(58));
		await field.pressSequentially('abcd');
		await expect(field).toHaveValue(`${'x'.repeat(58)}ab`);
		await expect(status).toHaveText('Up to 60 characters');
		await expect(field).toHaveAccessibleDescription('Up to 60 characters.');
		await field.fill('');
		await expect(field).toHaveAccessibleDescription('Up to three here, 60 characters each.');
	});

	test('TagInput holds max and says so when the list fills and when it refuses', async ({
		page
	}) => {
		await openInputs(page);
		const tags = page.getByTestId('tags-avoid');
		const field = tags.getByRole('textbox', { name: 'Movements to avoid' });
		const status = tags.getByRole('status');
		const value = page.getByTestId('tags-value');
		const offered = tags.getByRole('group', { name: 'Suggestions for Movements to avoid' });

		// Three items: the one that fills the list says so, and the suggestions step aside.
		await offered.getByRole('button', { name: 'Add Dips' }).click();
		await offered.getByRole('button', { name: 'Add Upright row' }).click();
		await expect(value).toHaveText('value: ["Overhead press","Dips","Upright row"]');
		await expect(status).toHaveText('Added Upright row. That’s the limit of 3.');
		await expect(offered).toHaveCount(0);
		const limit = 'That’s the limit of 3. Remove one to add another.';
		await expect(field).toHaveAccessibleDescription(limit);

		// A fourth is refused out loud, not silently, and what was typed stays.
		await field.fill('Lunges');
		await field.press('Enter');
		await expect(status).toHaveText(limit);
		await expect(field).toHaveValue('Lunges');
		await expect(value).toHaveText('value: ["Overhead press","Dips","Upright row"]');

		await tags.getByRole('button', { name: 'Remove Dips' }).click();
		await field.press('Enter');
		await expect(value).toHaveText('value: ["Overhead press","Upright row","Lunges"]');
	});

	test('a TagInput error is announced, replaces the hint and clears once fixed', async ({
		page
	}) => {
		await openInputs(page);
		const tags = page.getByTestId('tags-skip');
		const field = tags.getByRole('textbox', { name: 'Exercises you’d rather skip' });
		const message = 'Each exercise once: it can’t be liked and skipped';
		const alert = page.getByRole('alert').filter({ hasText: message });
		await expect(alert).toBeVisible();
		await expect(field).toHaveAttribute('aria-invalid', 'true');
		await expect(field).toHaveAccessibleDescription(message);
		await expect(tags.getByText('Swapped for an equivalent.')).toHaveCount(0);
		expect(await missingDescribedBy(field)).toEqual([]);

		await tags.getByRole('button', { name: 'Remove front squat' }).click();
		await expect(alert).toHaveCount(0);
		await expect(field).not.toHaveAttribute('aria-invalid');
		await expect(field).toHaveAccessibleDescription('Swapped for an equivalent.');
		expect(await missingDescribedBy(field)).toEqual([]);
	});
});
