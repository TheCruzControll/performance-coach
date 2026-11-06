/**
 * Desktop helpers (docs/design-system.md, Responsive layout → Verification). Any spec, serial
 * ones included, runs at a desktop window with `test.use(DESKTOP)`, checks its fixed or sticky
 * chrome against the element the chrome belongs to, and checks that a swap moves nothing with
 * `expectNoShift`, which measures on every engine. New helpers go at the end of this file.
 */
import {
	expect,
	test,
	type Locator,
	type Page,
	type PlaywrightTestOptions
} from '@playwright/test';

/**
 * A desktop browser window: 1440 × 900, a mouse and no touch, at scale 1. For `test.use()`; the
 * screen size goes through `contextOptions` (it has no option of its own), so a spec that sets
 * other context options spreads `DESKTOP.contextOptions` into them.
 */
export const DESKTOP = {
	viewport: { width: 1440, height: 900 },
	contextOptions: { screen: { width: 1440, height: 900 } },
	deviceScaleFactor: 1,
	isMobile: false,
	hasTouch: false
} satisfies Partial<PlaywrightTestOptions>;

/** The narrowest desktop window (64rem at the default text size). */
const DESKTOP_MIN_WIDTH = 1024;

/** Window widths a desktop layout is checked at: the narrowest with the rail, up to 1920. */
export const DESKTOP_WIDTHS = [DESKTOP_MIN_WIDTH, 1280, 1440, 1920] as const;

/** The widest window that still gets the tablet layout: the boundary below DESKTOP_WIDTHS. */
export const BELOW_DESKTOP_WIDTH = DESKTOP_MIN_WIDTH - 1;

/** Is this page's window a desktop one (from 1024 px), read from its viewport? */
export function isDesktopPage(page: Page): boolean {
	return (page.viewportSize()?.width ?? 0) >= DESKTOP_MIN_WIDTH;
}

/** Nothing scrolls sideways: the document is no wider than the window. */
export async function expectNoSideScroll(page: Page): Promise<void> {
	const { scrollWidth, innerWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth
	}));
	expect(
		scrollWidth,
		`the page is ${scrollWidth}px wide in a ${innerWidth}px window`
	).toBeLessThanOrEqual(innerWidth);
}

const NO_LAYOUT_SHIFT_ENTRIES = 'layout-shift entries are not reported here: use expectStableBoxes';

/** Does this engine report layout-shift entries (Chromium does, WebKit does not)? */
const reportsLayoutShift = (page: Page) =>
	page.evaluate(() => PerformanceObserver.supportedEntryTypes.includes('layout-shift'));

/** Wait until a frame has been laid out and painted after whatever just changed. */
const nextFrames = (page: Page) =>
	page.evaluate(
		() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
	);

/**
 * The summed value of the layout-shift entries reported while `action` runs, from an observer
 * installed first; the action stays on the page. Shifts that follow input count too, so a click
 * that moves content is caught.
 * Throws on an engine that reports no layout-shift entries (WebKit), so a check can never pass
 * without measuring: use `expectNoShift`, which falls back to `expectStableBoxes` there.
 */
export async function layoutShiftDuring(page: Page, action: () => Promise<unknown>) {
	if (!(await reportsLayoutShift(page))) throw new Error(NO_LAYOUT_SHIFT_ENTRIES);
	await page.evaluate(() => {
		const sum = { value: 0 };
		const add = (entries: PerformanceEntryList) => {
			for (const entry of entries) sum.value += (entry as unknown as { value: number }).value;
		};
		const observer = new PerformanceObserver((list) => add(list.getEntries()));
		observer.observe({ type: 'layout-shift' });
		Object.assign(window, {
			__layoutShift: () => {
				add(observer.takeRecords());
				observer.disconnect();
				return sum.value;
			}
		});
	});
	await action();
	await nextFrames(page);
	return page.evaluate(() =>
		(window as unknown as { __layoutShift: () => number }).__layoutShift()
	);
}

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

async function boxesOf(locators: Locator[]): Promise<Box[]> {
	const boxes: Box[] = [];
	for (const locator of locators) boxes.push(await boxOf(locator));
	return boxes;
}

/** What moved or resized between two measurements of the same elements, by more than 1 px. */
function moved(locators: Locator[], before: Box[], after: Box[], when: string): string[] {
	return locators.flatMap((locator, i) =>
		(['x', 'y', 'width', 'height'] as const)
			.filter((key) => Math.abs(after[i]![key] - before[i]![key]) > 1)
			.map(
				(key) =>
					`${locator}: ${key} ${before[i]![key].toFixed(1)} → ${after[i]![key].toFixed(1)} ${when}`
			)
	);
}

/**
 * Each element's bounding box stays put (x, y, width and height within 1 px) across `action`,
 * and again once fonts and hydration have settled: the geometry a skeleton reserves, measured on
 * any engine.
 */
export async function expectStableBoxes(
	page: Page,
	locators: Locator[],
	action: () => Promise<unknown>
): Promise<void> {
	if (locators.length === 0) throw new Error('expectStableBoxes needs the boxes to measure');
	const before = await boxesOf(locators);
	await action();
	await nextFrames(page);
	const after = await boxesOf(locators);
	await page.waitForLoadState('networkidle');
	await page.evaluate(() => document.fonts.ready);
	await nextFrames(page);
	const settled = await boxesOf(locators);
	expect([
		...moved(locators, before, after, 'after the action'),
		...moved(locators, before, settled, 'once the page settled')
	]).toEqual([]);
}

/**
 * Nothing moves during `action`. On Chromium the layout shift is at most 0.01 and the boxes stay
 * put; on WebKit, which reports no layout shift, the boxes alone are checked, and the test says
 * so in an annotation. The boxes are required: name the elements the layout reserves.
 */
export async function expectNoShift(
	page: Page,
	{ action, boxes }: { action: () => Promise<unknown>; boxes: Locator[] }
): Promise<void> {
	if (!boxes?.length) throw new Error('expectNoShift needs the boxes the layout reserves');
	if (!(await reportsLayoutShift(page))) {
		test.info().annotations.push({
			type: 'layout-shift',
			description: 'this engine reports no layout-shift entries: only the boxes were checked'
		});
		return expectStableBoxes(page, boxes, action);
	}
	let shift = 0;
	await expectStableBoxes(page, boxes, async () => {
		shift = await layoutShiftDuring(page, action);
	});
	expect(shift, 'layout shift during the action').toBeLessThanOrEqual(0.01);
}

const inside = (inner: Box, outer: Box) =>
	inner.x >= outer.x - 1 && inner.x + inner.width <= outer.x + outer.width + 1;

const belowWindow = (page: Page, box: Box) => box.y + box.height > page.viewportSize()!.height + 1;

/**
 * Screen chrome (fixed, centred over the column, e.g. Coach's composer): its centre is within
 * 1 px of `area`'s, it lies inside `area`'s left and right edges (±1 px), and it ends above the
 * window's bottom edge.
 */
export async function expectCentredOver(page: Page, chrome: Locator, area: Locator): Promise<void> {
	const [bar, over] = await boxesOf([chrome, area]);
	const centre = (box: Box) => box.x + box.width / 2;
	const problems: string[] = [];
	const off = centre(bar!) - centre(over!);
	if (Math.abs(off) > 1) problems.push(`${chrome} is ${off.toFixed(1)}px off ${area}'s centre`);
	if (!inside(bar!, over!)) problems.push(`${chrome} reaches outside ${area}`);
	if (belowWindow(page, bar!)) problems.push(`${chrome} ends below the window`);
	expect(problems).toEqual([]);
}

/**
 * Column chrome (sticky at the foot of its column, e.g. an editor's Save bar): it lies within
 * `column`'s left and right edges (±1 px), above the window's bottom edge, and overlaps none of
 * the `others` columns.
 */
export async function expectInColumn(
	page: Page,
	chrome: Locator,
	column: Locator,
	others: Locator[]
): Promise<void> {
	const [bar, own] = await boxesOf([chrome, column]);
	const problems: string[] = [];
	if (!inside(bar!, own!)) problems.push(`${chrome} reaches outside ${column}`);
	if (belowWindow(page, bar!)) problems.push(`${chrome} ends below the window`);
	for (const [i, other] of (await boxesOf(others)).entries()) {
		const across = Math.min(bar!.x + bar!.width, other.x + other.width) - Math.max(bar!.x, other.x);
		const down = Math.min(bar!.y + bar!.height, other.y + other.height) - Math.max(bar!.y, other.y);
		if (across > 1 && down > 1) problems.push(`${chrome} covers ${others[i]}`);
	}
	expect(problems).toEqual([]);
}

/**
 * The RGB colour of one pixel of a screenshot (x and y in the screenshot's pixels), decoded in
 * the page with createImageBitmap, as the shell spec compares tab bars.
 */
export async function pixelAt(
	page: Page,
	shot: Buffer,
	x: number,
	y: number
): Promise<[number, number, number]> {
	return page.evaluate(
		async ({ png, x, y }) => {
			const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
			const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), {
				colorSpaceConversion: 'none'
			});
			const canvas = Object.assign(document.createElement('canvas'), { width: 1, height: 1 });
			const context = canvas.getContext('2d')!;
			context.drawImage(image, -x, -y);
			const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
			return [r!, g!, b!] as [number, number, number];
		},
		{ png: shot.toString('base64'), x, y }
	);
}
