/**
 * The shared primitives in a desktop window (docs/design-system.md, Responsive layout → Dialogs &
 * toasts, Pointer & hover, Keyboard & focus). From 1024 px a BottomSheet opens as a centred
 * dialog: it keeps the native <dialog>'s focus trap, Escape and focus return, a mouse cannot drag
 * it, and stacked dialogs close one Escape at a time. Every control shows a focus ring and, for a
 * mouse, a hover state. A touch screen as wide gets neither hover styles nor smaller targets, and
 * a touch swipe still closes a sheet, on it and on a phone. Tab order and hover are asserted on
 * Chromium, as in the shell's spec; touch swipes and the stacked dialogs need its DevTools
 * protocol and virtual authenticator.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { DESKTOP } from './desktop';
import { captureScreen, gotoHydrated, query, toastWith, trackConsoleErrors } from './support';
import { addVirtualAuthenticator, signInAsOwner, toBase64Url } from './webauthn';

test.use(DESKTOP);

const THEMES = ['dark', 'light'] as const;
type Theme = (typeof THEMES)[number];

/** The width a centred dialog takes in a wide window: 32rem. */
const DIALOG_WIDTH = 32 * 16;

/** The smallest desktop window a dialog must fit. */
const SMALL_DESKTOP = { width: 1024, height: 700 };

interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

async function boxOf(locator: Locator): Promise<Box> {
	const box = await locator.boundingBox();
	expect(box, `${locator} is on the page`).not.toBeNull();
	return box!;
}

/** The visible panel inside a sheet's full-window <dialog>. */
const panelOf = (dialog: Locator) => dialog.locator('.sheet');

/** A sheet has finished opening: shown, and no transition still running on its panel. */
async function settled(dialog: Locator) {
	await expect(dialog).toHaveClass(/\bvisible\b/);
	await expect
		.poll(() => panelOf(dialog).evaluate((el) => el.getAnimations().length), {
			message: 'the sheet has finished opening'
		})
		.toBe(0);
}

/** Open a screen in a theme: the stored preference applies before first paint. */
async function openInTheme(page: Page, path: string, theme: Theme) {
	await page.addInitScript(
		(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
		theme
	);
	await gotoHydrated(page, path);
	if (theme === 'light') await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
}

/** axe (WCAG 2.1 A/AA) on the page as it stands, in both themes. */
async function audit(page: Page, label: string) {
	for (const theme of THEMES) {
		await page.evaluate((t) => {
			if (t === 'dark') delete document.documentElement.dataset.theme;
			else document.documentElement.dataset.theme = t;
		}, theme);
		await page.waitForTimeout(250); // colour transitions
		const { violations } = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();
		expect(
			violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`)),
			`${label} (${theme})`
		).toEqual([]);
	}
	await page.evaluate(() => delete document.documentElement.dataset.theme);
}

interface OpenSheet {
	opener: Locator;
	dialog: Locator;
}

async function openPlates(page: Page): Promise<OpenSheet> {
	await gotoHydrated(page, '/train');
	const opener = page.getByTestId('open-plates');
	await opener.click();
	const dialog = page.getByRole('dialog', { name: 'Plate calculator' });
	await settled(dialog);
	return { opener, dialog };
}

async function openFeedback(page: Page): Promise<OpenSheet> {
	await gotoHydrated(page, '/design');
	await page.getByRole('tab', { name: 'Feedback' }).click();
	const opener = page.getByTestId('open-sheet');
	await opener.click();
	const dialog = page.getByRole('dialog', { name: 'Substitute exercise' });
	await settled(dialog);
	return { opener, dialog };
}

const SHEETS = [
	{ name: 'the plate calculator', open: openPlates, shot: 'plate-calculator-desktop' },
	{ name: 'the /design Feedback sheet', open: openFeedback, shot: 'design-sheet-desktop' }
] as const;

/** The panel's centre is within 2 px of the window's (the full-window <dialog>), both ways. */
async function expectCentred(dialog: Locator) {
	const panel = await boxOf(panelOf(dialog));
	const window = await boxOf(dialog);
	const off = (axis: 'x' | 'y', size: 'width' | 'height') =>
		panel[axis] + panel[size] / 2 - (window[axis] + window[size] / 2);
	expect(
		[off('x', 'width'), off('y', 'height')].map((d) => Math.abs(d) <= 2),
		`${dialog}'s centre is off the window's by ${off('x', 'width')}, ${off('y', 'height')}`
	).toEqual([true, true]);
}

/** The panel's corner radii and border widths, in px, clockwise from the top left. */
const frameOf = (dialog: Locator) =>
	panelOf(dialog).evaluate((el) => {
		const s = getComputedStyle(el);
		return {
			radii: [
				s.borderTopLeftRadius,
				s.borderTopRightRadius,
				s.borderBottomRightRadius,
				s.borderBottomLeftRadius
			].map(parseFloat),
			borders: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth].map(
				parseFloat
			)
		};
	});

/** Press a mouse on the sheet's title and drag it down by `distance`, releasing at the end. */
async function mouseDrag(
	page: Page,
	dialog: Locator,
	distance: number,
	during: () => Promise<void>
) {
	const title = await boxOf(dialog.getByRole('heading', { level: 2 }));
	const x = title.x + title.width / 2;
	const y = title.y + title.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x, y + distance, { steps: 12 });
	await during();
	await page.mouse.up();
}

/** A finger on the sheet's title swipes down by `distance` (Chromium's DevTools protocol). */
async function touchSwipe(page: Page, dialog: Locator, distance: number) {
	const title = await boxOf(dialog.getByRole('heading', { level: 2 }));
	const x = title.x + title.width / 2;
	const y = title.y + title.height / 2;
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
	for (let step = 1; step <= 10; step++) {
		await cdp.send('Input.dispatchTouchEvent', {
			type: 'touchMove',
			touchPoints: [{ x, y: y + (distance * step) / 10 }]
		});
	}
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await cdp.detach();
}

const scrollLock = (page: Page) => page.evaluate(() => document.documentElement.style.overflow);

test.describe('a sheet from 1024 px', () => {
	for (const sheet of SHEETS) {
		test(`${sheet.name} opens as a centred dialog, every corner rounded and no handle`, async ({
			page
		}, testInfo) => {
			const errors = trackConsoleErrors(page);
			const { dialog } = await sheet.open(page);
			await expectCentred(dialog);
			const panel = await boxOf(panelOf(dialog));
			expect(Math.abs(panel.width - DIALOG_WIDTH), `${panel.width}px wide`).toBeLessThanOrEqual(1);
			expect(panel.y, 'the dialog starts inside the window').toBeGreaterThan(0);
			expect(panel.y + panel.height, 'and ends inside it').toBeLessThan(900);
			const { radii, borders } = await frameOf(dialog);
			expect(
				radii.every((r) => r >= 20),
				`corner radii ${radii}`
			).toBe(true);
			expect(
				borders.every((b) => b >= 1),
				`borders ${borders}`
			).toBe(true);
			await expect(dialog.locator('.handle')).toBeHidden();
			// The dialog holds focus: it starts on the dialog itself, named by its title.
			await expect(panelOf(dialog)).toBeFocused();
			await captureScreen(page, testInfo, sheet.shot);
			await audit(page, `${sheet.name}, open`);
			expect(errors).toEqual([]);
		});

		test(`${sheet.name} closes on Escape and on the backdrop, returning focus, and a mouse cannot drag it`, async ({
			page
		}) => {
			const errors = trackConsoleErrors(page);
			const { opener, dialog } = await sheet.open(page);
			const before = await boxOf(panelOf(dialog));
			await mouseDrag(page, dialog, 300, async () => {
				expect(await boxOf(panelOf(dialog)), 'mid-drag, the dialog stays put').toEqual(before);
			});
			await page.waitForTimeout(450); // longer than a close would take
			await expect(dialog, 'a mouse drag never dismisses it').toHaveClass(/\bvisible\b/);
			expect(await boxOf(panelOf(dialog))).toEqual(before);

			await page.keyboard.press('Escape');
			await expect(dialog).toBeHidden();
			await expect(opener).toBeFocused();
			expect(await scrollLock(page)).toBe('');

			await opener.click();
			await settled(dialog);
			const window = await boxOf(dialog);
			await page.mouse.click(window.x + 24, window.y + window.height - 24); // the backdrop
			await expect(dialog).toBeHidden();
			await expect(opener).toBeFocused();
			expect(await scrollLock(page)).toBe('');
			expect(errors).toEqual([]);
		});
	}
});

test.describe('a small desktop window', () => {
	test.use({ viewport: SMALL_DESKTOP, contextOptions: { screen: SMALL_DESKTOP } });

	test('at 1024 × 700 a dialog fits the window, and content taller than it scrolls inside', async ({
		page
	}) => {
		const { dialog } = await openPlates(page);
		const fits = async () => {
			await expectCentred(dialog);
			const panel = await boxOf(panelOf(dialog));
			expect(panel.y, 'the dialog starts inside the window').toBeGreaterThan(0);
			expect(panel.y + panel.height, 'and ends inside it').toBeLessThan(SMALL_DESKTOP.height);
			return panel;
		};
		// The plate calculator fits whole: nothing to scroll.
		await fits();
		const body = dialog.locator('.body');
		expect(await body.evaluate((el) => el.scrollHeight - el.clientHeight)).toBe(0);

		// A long form instead: the dialog stops at 85% of the window and its content scrolls
		// inside, under a title that stays put.
		await body.evaluate((el) => {
			const form = Object.assign(document.createElement('div'), { id: 'long-form' });
			form.style.height = '1200px';
			el.append(form);
		});
		const panel = await fits();
		expect(panel.height, 'at most 85% of the window').toBeLessThanOrEqual(
			0.85 * SMALL_DESKTOP.height + 1
		);
		const title = dialog.getByRole('heading', { level: 2 });
		const titleBefore = await boxOf(title);
		const top = await body.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
			return el.scrollTop;
		});
		expect(top, 'the content scrolls inside the dialog').toBeGreaterThan(0);
		const end = await boxOf(dialog.locator('#long-form'));
		expect(end.y + end.height, 'its end comes into view').toBeLessThanOrEqual(
			panel.y + panel.height
		);
		expect(await boxOf(title)).toEqual(titleBefore);
		expect(await boxOf(panelOf(dialog))).toEqual(panel);
	});
});

/** What Tab reached: its name, its box in the document, the width of its ring, and where. */
interface Stop {
	id: number;
	name: string;
	box: Box;
	ring: number;
	inPanel: boolean;
}

/**
 * The focused element as a stop. A native control the face after it draws (ChoiceGroup,
 * DayPicker, Toggle: the input is transparent) shows its ring on that face. The ring is a
 * visible outline or a visible outer box-shadow spread, whichever is wider.
 */
const focusedStop = (page: Page): Promise<Stop> =>
	page.evaluate(() => {
		const el = document.activeElement as HTMLElement;
		const seen = window as unknown as { __stops?: Map<Element, number> };
		const ids = (seen.__stops ??= new Map());
		if (!ids.has(el)) ids.set(el, ids.size);
		const next = el.nextElementSibling;
		const drawn = getComputedStyle(el).opacity === '0' && next instanceof HTMLElement ? next : el;
		const style = getComputedStyle(drawn);
		const shown = (colour: string) => colour !== 'transparent' && !/,\s*0\)$/.test(colour);
		const outline =
			style.outlineStyle !== 'none' && shown(style.outlineColor)
				? parseFloat(style.outlineWidth)
				: 0;
		const spreads =
			style.boxShadow === 'none'
				? []
				: style.boxShadow
						.split(/,(?![^(]*\))/)
						.filter((shadow) => !shadow.includes('inset'))
						.map((shadow) => {
							const colour = shadow.match(/rgba?\([^)]*\)/)?.[0] ?? '';
							const lengths = shadow.replace(colour, '').trim().split(/\s+/).map(parseFloat);
							return shown(colour) ? (lengths[3] ?? 0) : 0;
						});
		const box = drawn.getBoundingClientRect();
		const label =
			el.getAttribute('aria-label') ??
			(el as HTMLInputElement).labels?.[0]?.textContent ??
			el.textContent ??
			'';
		return {
			id: ids.get(el)!,
			name: el.getAttribute('role') === 'tabpanel' ? 'panel' : label.trim().slice(0, 40),
			box: { x: box.x + scrollX, y: box.y + scrollY, width: box.width, height: box.height },
			ring: Math.max(outline, ...spreads),
			inPanel: Boolean(el.closest('[role="tabpanel"]'))
		};
	});

/** Tab from where focus is until it leaves the tab panel; a date field's parts are one stop. */
async function tabThroughPanel(page: Page): Promise<Stop[]> {
	const stops: Stop[] = [];
	for (let presses = 0; presses < 200; presses++) {
		await page.keyboard.press('Tab');
		const stop = await focusedStop(page);
		if (!stop.inPanel) return stops;
		if (stops.at(-1)?.id !== stop.id) stops.push(stop);
	}
	throw new Error('Tab never left the panel: a keyboard trap');
}

/** Consecutive stops that go against reading order: back up a line, or left along one. */
function againstReadingOrder(stops: Stop[]): string[] {
	return stops.slice(1).flatMap((b, i) => {
		const a = stops[i]!;
		const [p, q] = [a.box, b.box];
		const inside =
			q.x >= p.x - 1 &&
			q.y >= p.y - 1 &&
			q.x + q.width <= p.x + p.width + 1 &&
			q.y + q.height <= p.y + p.height + 1;
		const sameLine = q.y < p.y + p.height - 1 && p.y < q.y + q.height - 1;
		const forward = inside || (sameLine ? q.x > p.x : q.y >= p.y + p.height - 1);
		return forward ? [] : [`${a.name} → ${b.name}`];
	});
}

/** Controls each panel's walk must reach: one or more of every primitive in it. */
const BUTTONS_STOPS = ['Start workout', 'Skip exercise', 'Small', 'Medium', 'Add set', 'Remove'];
const INPUTS_STOPS = [
	'Decrease Reps',
	'Increase RPE',
	'12 weeks',
	'Back squat 1RM',
	'Race day',
	'Notes for the coach',
	'Intermediate',
	'Muay Thai',
	'Commercial gym',
	'Monday',
	'Sunday',
	'I also train at home',
	'Remove Overhead press',
	'Movements to avoid',
	'Add Dips',
	'Exercises you’d rather skip'
];

/**
 * The ways a ring must show: each theme, and forced colours (a Windows contrast theme), which
 * drop every box-shadow and repaint every colour, so a ring drawn as a shadow disappears there.
 */
const RING_MODES = [
	{ name: 'dark', theme: 'dark', forcedColors: 'none' },
	{ name: 'light', theme: 'light', forcedColors: 'none' },
	{ name: 'forced colours', theme: 'dark', forcedColors: 'active' }
] as const;

test.describe('keyboard', () => {
	for (const mode of RING_MODES) {
		test(`Tab reaches every control on /design → Buttons and Inputs in reading order, each with a ring (${mode.name})`, async ({
			page
		}, testInfo) => {
			const theme = mode.theme;
			await page.emulateMedia({ forcedColors: mode.forcedColors });
			await openInTheme(page, '/design', theme);
			const buttonsTab = page.getByRole('tab', { name: 'Buttons' });
			await buttonsTab.focus();
			const buttons = await tabThroughPanel(page);

			await buttonsTab.focus();
			await page.keyboard.press('ArrowRight'); // automatic activation: Inputs opens
			await expect(page.getByRole('tab', { name: 'Inputs' })).toBeFocused();
			await expect(page.getByRole('heading', { name: 'Number field' })).toBeVisible();
			if (mode.forcedColors === 'none')
				await captureScreen(page, testInfo, `design-inputs-focus-${theme}-desktop`);
			const inputs = await tabThroughPanel(page);

			for (const [stops, expected] of [
				[buttons, BUTTONS_STOPS],
				[inputs, INPUTS_STOPS]
			] as const) {
				const names = stops.map((stop) => stop.name);
				expect(
					expected.filter((name) => !names.some((n) => n.startsWith(name))),
					`not reached in ${names.join(' · ')}`
				).toEqual([]);
				expect(againstReadingOrder(stops), 'Tab goes against reading order').toEqual([]);
				expect(
					stops.filter((stop) => stop.ring < 2).map((stop) => `${stop.name}: ${stop.ring}px`),
					'controls without a visible ring of at least 2 px'
				).toEqual([]);
			}
		});
	}
});

/** A control and the element that paints its state (the face a native input sits on). */
interface Hovered {
	name: string;
	control: (page: Page) => Locator;
	painted?: (control: Locator) => Locator;
	/** Built on a <label>: the pointer over it says it can be clicked. */
	label?: boolean;
}

const face = (control: Locator) => control.locator('xpath=following-sibling::*[1]');

const HOVERED_BUTTONS: Hovered[] = [
	{ name: 'Button (primary)', control: (p) => p.getByRole('button', { name: 'Start workout' }) },
	{ name: 'Button', control: (p) => p.getByRole('button', { name: 'Plate calculator' }) },
	{ name: 'Button (danger)', control: (p) => p.getByRole('button', { name: 'Skip exercise' }) },
	{ name: 'IconButton (accent)', control: (p) => p.getByRole('button', { name: 'Add set' }) },
	{ name: 'IconButton (filled)', control: (p) => p.getByRole('button', { name: 'Rest timer' }) },
	{ name: 'Tab', control: (p) => p.getByRole('tab', { name: 'Inputs' }) }
];
const HOVERED_DATA: Hovered[] = [
	{ name: 'ListRow', control: (p) => p.getByRole('button', { name: /^Plate calculator/ }) }
];
const HOVERED_INPUTS: Hovered[] = [
	{
		name: 'ChoiceGroup option',
		control: (p) => p.getByRole('radio', { name: 'Novice' }),
		painted: face,
		label: true
	},
	{
		name: 'DayPicker day',
		control: (p) => p.getByRole('checkbox', { name: 'Monday' }).first(),
		painted: face,
		label: true
	},
	{
		name: 'Toggle row',
		control: (p) => p.getByRole('switch', { name: 'I also train at home' }),
		painted: face,
		label: true
	},
	{
		name: 'NumberStepper button',
		control: (p) => p.getByRole('button', { name: 'Increase Reps' })
	},
	{
		name: 'TagInput remove button',
		control: (p) => p.getByRole('button', { name: 'Remove Overhead press' })
	}
];

/** The background and border colours that show a control's state. */
const paintOf = (target: Locator) =>
	target.evaluate((el) => {
		const s = getComputedStyle(el);
		return `background ${s.backgroundColor}, border ${s.borderTopColor}`;
	});

/** Move the mouse off every control and let transitions finish; returns the resting paint. */
async function resting(page: Page, target: Locator) {
	await page.mouse.move(1, 1);
	await expect.poll(() => target.evaluate((el) => el.getAnimations().length)).toBe(0);
	return paintOf(target);
}

/** The cursor over the middle of a control, as the topmost element there shows it. */
const cursorOver = async (page: Page, control: Locator) => {
	const box = await boxOf(control);
	return page.evaluate(
		([x, y]) => getComputedStyle(document.elementFromPoint(x!, y!)!).cursor,
		[box.x + box.width / 2, box.y + box.height / 2]
	);
};

/** Visit /design's Buttons, Data and Inputs groups, running `check` on each listed control. */
async function eachHovered(
	page: Page,
	check: (hovered: Hovered, control: Locator) => Promise<void>
) {
	await gotoHydrated(page, '/design');
	for (const [tab, list] of [
		['Buttons', HOVERED_BUTTONS],
		['Data', HOVERED_DATA],
		['Inputs', HOVERED_INPUTS]
	] as const) {
		await page.getByRole('tab', { name: tab }).click();
		for (const hovered of list) {
			const control = hovered.control(page);
			await control.scrollIntoViewIfNeeded();
			await check(hovered, control);
		}
	}
}

test.describe('pointer', () => {
	test('a mouse over a Button, ListRow, Tab, choice, day, Toggle or stepper changes its paint', async ({
		page
	}) => {
		const unchanged: string[] = [];
		const noPointer: string[] = [];
		await eachHovered(page, async (hovered, control) => {
			const target = hovered.painted?.(control) ?? control;
			const rest = await resting(page, target);
			await control.hover();
			await expect
				.poll(() => paintOf(target), { timeout: 2_000 })
				.not.toBe(rest)
				.catch(() => unchanged.push(`${hovered.name}: ${rest}`));
			if (hovered.label && (await cursorOver(page, control)) !== 'pointer')
				noPointer.push(hovered.name);
		});
		expect(unchanged, 'hover changes nothing').toEqual([]);
		expect(noPointer, 'no pointer cursor over a label-based control').toEqual([]);
	});
});

/** Each control's hit area: how far around its middle a tap still lands on it. */
const hitAreasIn = (scope: Locator) =>
	scope.evaluate((root) => {
		const controls = [
			...root.querySelectorAll<HTMLElement>(
				'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href]'
			)
		].filter((el) => el.checkVisibility());
		return controls.map((el) => {
			el.scrollIntoView({ block: 'center', inline: 'center' });
			const r = el.getBoundingClientRect();
			const [cx, cy] = [r.x + r.width / 2, r.y + r.height / 2];
			const on = (x: number, y: number) => {
				const hit = document.elementFromPoint(x, y);
				return Boolean(hit) && (hit === el || el.contains(hit));
			};
			const reach = (dx: number, dy: number) => {
				let n = 0;
				while (n < 40 && on(cx + dx * (n + 1), cy + dy * (n + 1))) n++;
				return n;
			};
			const name = el.getAttribute('aria-label') ?? el.textContent?.trim() ?? el.tagName;
			return on(cx, cy)
				? { name, width: reach(-1, 0) + reach(1, 0) + 1, height: reach(0, -1) + reach(0, 1) + 1 }
				: { name, width: 0, height: 0 };
		});
	});

/** A touch screen as wide as a desktop window: an iPad Air in landscape. */
const TOUCH_WIDE = {
	viewport: { width: 1180, height: 820 },
	contextOptions: { screen: { width: 1180, height: 820 } },
	deviceScaleFactor: 2,
	isMobile: true,
	hasTouch: true
};

test.describe('a touch screen at 1180 × 820', () => {
	test.use(TOUCH_WIDE);

	test('gets no hover styles, and every control on /design keeps a target of at least 44 px', async ({
		page
	}) => {
		expect(
			await page.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches)
		).toBe(false);
		const changed: string[] = [];
		await eachHovered(page, async (hovered, control) => {
			const target = hovered.painted?.(control) ?? control;
			const rest = await resting(page, target);
			await control.hover();
			await page.waitForTimeout(300); // longer than a hover transition
			if ((await paintOf(target)) !== rest) changed.push(hovered.name);
		});
		expect(changed, 'hover styles on a touch screen').toEqual([]);

		const small: string[] = [];
		for (const tab of ['Buttons', 'Inputs']) {
			await page.getByRole('tab', { name: tab }).click();
			if (tab === 'Inputs')
				await expect(page.getByRole('heading', { name: 'Number field' })).toBeVisible();
			for (const area of await hitAreasIn(page.locator('.tabs')))
				if (area.width < 44 || area.height < 44)
					small.push(`${tab} → ${area.name}: ${area.width} × ${area.height}`);
		}
		// And the open dialog's own controls (Close, Done).
		await page.getByRole('tab', { name: 'Feedback' }).click();
		await page.getByTestId('open-sheet').click();
		const dialog = page.getByRole('dialog', { name: 'Substitute exercise' });
		await settled(dialog);
		for (const area of await hitAreasIn(dialog))
			if (area.width < 44 || area.height < 44)
				small.push(`dialog → ${area.name}: ${area.width} × ${area.height}`);
		expect(small, 'targets under 44 × 44 px').toEqual([]);
	});

	test('a touch swipe down the centred dialog closes it', async ({ page }) => {
		const { dialog } = await openFeedback(page);
		await expectCentred(dialog);
		await touchSwipe(page, dialog, 320);
		await expect(dialog).toBeHidden();
		expect(await scrollLock(page)).toBe('');
	});
});

test.describe('on a phone', () => {
	test.use({
		viewport: { width: 393, height: 659 },
		contextOptions: { screen: { width: 393, height: 852 } },
		deviceScaleFactor: 3,
		isMobile: true,
		hasTouch: true
	});

	test('a sheet still rises from the bottom with its handle, and a touch swipe closes it', async ({
		page
	}, testInfo) => {
		const { opener, dialog } = await openPlates(page);
		const panel = await boxOf(panelOf(dialog));
		expect(
			Math.abs(panel.y + panel.height - 659),
			'its bottom edge is the window’s'
		).toBeLessThanOrEqual(1);
		const { radii } = await frameOf(dialog);
		expect(radii.slice(2), 'square bottom corners').toEqual([0, 0]);
		await expect(dialog.locator('.handle')).toBeVisible();
		await captureScreen(page, testInfo, 'plate-calculator-phone');
		await touchSwipe(page, dialog, 320);
		await expect(dialog).toBeHidden();
		await expect(opener).toBeFocused();
		expect(await scrollLock(page)).toBe('');
	});
});

const passkeyStored = async (id: string) =>
	(await query('select 1 from passkey_credentials where id = $1', [id])).length === 1;

test.describe('stacked dialogs', () => {
	test('the step-up dialog opens over Remove passkey, and each Escape closes the top one only', async ({
		page,
		context
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		// Like reauth.e2e.ts: a session of its own, and a passkey of its own to remove.
		const sessionId = await signInAsOwner(context, testInfo);
		const authenticator = await addVirtualAuthenticator(page);
		await gotoHydrated(page, '/profile/security');
		await page.getByTestId('add-passkey').click();
		await expect(toastWith(page, /Passkey added: /)).toBeVisible();
		const passkeyId = toBase64Url((await authenticator.credentials())[0]!.credentialId);
		const row = page.locator(`[data-passkey-id="${passkeyId}"]`);
		const removeButton = row.getByTestId('remove-passkey');
		// Its last passkey use is more than 5 minutes old: removing one asks for a passkey first.
		await query(
			`update auth_sessions set reauthenticated_at = now() - interval '6 minutes' where id = $1`,
			[sessionId]
		);

		await removeButton.click();
		const remove = page.getByTestId('remove-sheet');
		await settled(remove);
		await remove.getByTestId('confirm-remove').click();
		const reauth = page.getByTestId('reauth-sheet');
		await settled(reauth);
		await expect(reauth.getByRole('heading', { name: 'Confirm it’s you' })).toBeVisible();

		await expectCentred(remove);
		await expectCentred(reauth);
		const onTop = await page.evaluate(
			() =>
				document
					.elementFromPoint(innerWidth / 2, innerHeight / 2)
					?.closest('dialog')
					?.getAttribute('data-testid') ?? null
		);
		expect(onTop, 'the step-up dialog is on top').toBe('reauth-sheet');
		await expect(panelOf(reauth)).toBeFocused();
		await captureScreen(page, testInfo, 'security-stacked-dialogs-desktop');
		await audit(page, 'both dialogs open');

		// The first Escape closes the step-up dialog only, and focus goes back into Remove.
		await page.keyboard.press('Escape');
		await expect(reauth).toBeHidden();
		await expect(toastWith(page, 'Nothing was changed')).toBeVisible();
		await expect(remove).toHaveClass(/\bvisible\b/);
		await expect
			.poll(() => page.evaluate(() => document.activeElement?.closest('dialog')?.dataset.testid), {
				message: 'focus is back in the Remove dialog'
			})
			.toBe('remove-sheet');
		expect(await scrollLock(page), 'the page stays locked under Remove').toBe('hidden');

		// The second closes Remove, focus returns to the row's button and the page scrolls again.
		await page.keyboard.press('Escape');
		await expect(remove).toBeHidden();
		await expect(removeButton).toBeFocused();
		await expect.poll(() => scrollLock(page), { message: 'the page scrolls again' }).toBe('');
		expect(await passkeyStored(passkeyId)).toBe(true);

		// Confirming with the passkey then removes it, and leaves the other passkeys alone.
		await removeButton.click();
		await settled(remove);
		await remove.getByTestId('confirm-remove').click();
		await settled(reauth);
		await reauth.getByTestId('reauth-continue').click();
		await expect(toastWith(page, 'Passkey removed')).toBeVisible();
		await expect(row).toHaveCount(0);
		expect(await passkeyStored(passkeyId)).toBe(false);
		// The step-up refusals are expected responses, not errors.
		expect(errors.filter((e) => !/\b40[13]\b/.test(e))).toEqual([]);
	});
});
