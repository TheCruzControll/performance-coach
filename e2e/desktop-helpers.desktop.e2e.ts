import { expect, test, type Page } from '@playwright/test';
import {
	BELOW_DESKTOP_WIDTH,
	DESKTOP,
	DESKTOP_WIDTHS,
	expectCentredOver,
	expectInColumn,
	expectMainCentred,
	expectNoShift,
	expectNoSideScroll,
	expectStableBoxes,
	isDesktopPage,
	layoutShiftDuring,
	layoutWidth,
	pixelAt,
	tokenPx
} from './desktop';

/**
 * The desktop helpers (e2e/desktop.ts), proven on page.setContent fixtures with no server state:
 * each passes where the layout is right and fails where it is not.
 */
test.use(DESKTOP);

const FIXTURE_STYLE = `<style>
	body { margin: 0; font: 16px sans-serif; }
	.header { height: 100px; background: #222; }
	.block, .skeleton { height: 200px; background: #444; }
	.content { height: 400px; background: #666; }
</style>`;

/** A header, a slot (empty or holding a reserved skeleton) and the content below it. */
const fixture = (slot = '') =>
	`${FIXTURE_STYLE}<div class="header" id="header"></div><div id="slot">${slot}</div>` +
	`<div class="content" id="content">Content</div>`;

/** Insert a 200 px block into the slot: above the content, or in the skeleton's place. */
const fill = (p: Page) =>
	p.evaluate(() => {
		const block = Object.assign(document.createElement('div'), { className: 'block' });
		const skeleton = document.querySelector('.skeleton');
		if (skeleton) skeleton.replaceWith(block);
		else document.getElementById('slot')!.append(block);
	});

/** Act as an engine with no layout-shift entries (WebKit). */
const withoutLayoutShift = (p: Page) =>
	p.evaluate(() => {
		const types = PerformanceObserver.supportedEntryTypes.filter((t) => t !== 'layout-shift');
		Object.defineProperty(PerformanceObserver, 'supportedEntryTypes', { get: () => types });
	});

test('DESKTOP is a 1440 × 900 window with a mouse, at scale 1', async ({ page: p }) => {
	await p.setContent(fixture());
	expect(isDesktopPage(p)).toBe(true);
	expect(
		await p.evaluate(() => ({
			width: innerWidth,
			height: innerHeight,
			screen: [screen.width, screen.height],
			scale: devicePixelRatio,
			finePointer: matchMedia('(hover: hover) and (pointer: fine)').matches,
			touch: navigator.maxTouchPoints
		}))
	).toEqual({
		width: 1440,
		height: 900,
		screen: [1440, 900],
		scale: 1,
		finePointer: true,
		touch: 0
	});
});

test('desktop widths start at 1024 px, and nothing scrolls sideways at any of them', async ({
	page: p
}) => {
	await p.setContent(fixture());
	for (const width of DESKTOP_WIDTHS) {
		await p.setViewportSize({ width, height: 900 });
		expect(isDesktopPage(p), `${width}px`).toBe(true);
		await expectNoSideScroll(p);
	}
	await p.setViewportSize({ width: BELOW_DESKTOP_WIDTH, height: 900 });
	expect(isDesktopPage(p)).toBe(false);

	await p.setContent(`${FIXTURE_STYLE}<div style="width: 1100px; height: 10px"></div>`);
	await expect(expectNoSideScroll(p)).rejects.toThrow(/1100px wide in a 1023px window/);
});

test.describe('layout shift', () => {
	test('layoutShiftDuring measures a block inserted above the content, and 0 for a reserved swap', async ({
		page: p
	}) => {
		await p.setContent(fixture());
		expect(await layoutShiftDuring(p, () => fill(p))).toBeGreaterThan(0.05);
		await p.setContent(fixture('<div class="skeleton"></div>'));
		expect(await layoutShiftDuring(p, () => fill(p))).toBe(0);
	});

	test('layoutShiftDuring throws where no layout-shift entries are reported', async ({
		page: p
	}) => {
		await p.setContent(fixture());
		await withoutLayoutShift(p);
		await expect(layoutShiftDuring(p, () => fill(p))).rejects.toThrow(
			'layout-shift entries are not reported here: use expectStableBoxes'
		);
	});

	test('expectStableBoxes fails when a box moves or grows 10 px, and passes a reserved swap', async ({
		page: p
	}) => {
		const content = p.locator('#content');
		await p.setContent(fixture());
		await expect(
			expectStableBoxes(p, [content], () =>
				p.evaluate(() => (document.body.style.marginLeft = '10px'))
			)
		).rejects.toThrow(/locator\('#content'\): x 0\.0 → 10\.0 after the action/);

		await p.setContent(fixture());
		await expect(
			expectStableBoxes(p, [content], () =>
				p.evaluate(() => (document.getElementById('content')!.style.height = '410px'))
			)
		).rejects.toThrow(/locator\('#content'\): height 400\.0 → 410\.0 after the action/);

		await p.setContent(fixture());
		await expect(expectStableBoxes(p, [content], () => fill(p))).rejects.toThrow(
			/locator\('#content'\): y 100\.0 → 300\.0/
		);

		await p.setContent(fixture('<div class="skeleton"></div>'));
		await expectStableBoxes(p, [p.locator('#slot'), content], () => fill(p));
	});

	test('expectNoShift needs boxes, and catches a shift the boxes miss', async ({ page: p }) => {
		await p.setContent(fixture('<div class="skeleton"></div>'));
		await expect(
			// @ts-expect-error -- the boxes are required
			expectNoShift(p, { action: () => fill(p) })
		).rejects.toThrow('expectNoShift needs the boxes the layout reserves');
		await expect(expectNoShift(p, { action: () => fill(p), boxes: [] })).rejects.toThrow(
			'expectNoShift needs the boxes the layout reserves'
		);

		await expectNoShift(p, { action: () => fill(p), boxes: [p.locator('#content')] });
		expect(test.info().annotations).toEqual([]);

		// The header never moves, but the content below the new block does.
		await p.setContent(fixture());
		await expect(
			expectNoShift(p, { action: () => fill(p), boxes: [p.locator('#header')] })
		).rejects.toThrow(/layout shift during the action/);
	});

	test('without layout-shift entries, expectNoShift checks the boxes and says so', async ({
		page: p
	}) => {
		await p.setContent(fixture('<div class="skeleton"></div>'));
		await withoutLayoutShift(p);
		await expectNoShift(p, { action: () => fill(p), boxes: [p.locator('#content')] });
		expect(test.info().annotations).toEqual([
			{
				type: 'layout-shift',
				description: 'this engine reports no layout-shift entries: only the boxes were checked'
			}
		]);

		await p.setContent(fixture());
		await withoutLayoutShift(p);
		await expect(
			expectNoShift(p, { action: () => fill(p), boxes: [p.locator('#content')] })
		).rejects.toThrow(/locator\('#content'\): y 100\.0 → 300\.0/);
	});
});

test.describe('the column', () => {
	/** An 88 px rail fixed at the left and a 40rem column, centred beside it or in the window. */
	const shell = (besideRail: boolean) => `${FIXTURE_STYLE}
		<style>:root { --rail: 88px; --column: 40rem; }</style>
		<nav aria-label="Primary" style="position: fixed; inset: 0 auto 0 0; width: var(--rail);
			background: #222"></nav>
		<div style="padding-left: ${besideRail ? 'var(--rail)' : '0'}">
			<main id="main" style="max-width: var(--column); height: 100px; margin: 0 auto"></main>
		</div>`;

	test('tokenPx reads a token in px; expectMainCentred passes a column centred beside the rail, and fails one centred in the window or of another width', async ({
		page: p
	}) => {
		await p.setContent(shell(true));
		const column = await tokenPx(p, '--column');
		expect(column).toBe(640);
		expect(await layoutWidth(p)).toBe(1440);
		await expectMainCentred(p, column);
		// The phone's 34rem column is not this one.
		await expect(expectMainCentred(p, 34 * 16)).rejects.toThrow(/main is 640px wide/);

		// Centred in the whole window, as before the rail: 88 px more room on its right.
		await p.setContent(shell(false));
		await expect(expectMainCentred(p, column)).rejects.toThrow(/gaps beside main: 312 and 400/);
	});
});

test.describe('chrome', () => {
	/** A 640 px column centred in the window, with a 600 px fixed bar at its foot. */
	const screenChrome = (left: string, width = '600px') => `${FIXTURE_STYLE}
		<main id="main" style="width: 640px; height: 2000px; margin: 0 auto"></main>
		<div id="bar" style="position: fixed; bottom: 70px; left: ${left}; width: ${width};
			height: 56px; transform: translateX(-50%); background: #c8f031"></div>`;

	test('expectCentredOver passes a centred fixed bar, and fails one 20 px off or too wide', async ({
		page: p
	}) => {
		const [bar, main] = [p.locator('#bar'), p.locator('#main')];
		await p.setContent(screenChrome('50%'));
		await expectCentredOver(p, bar, main);

		await p.setContent(screenChrome('calc(50% + 20px)'));
		await expect(expectCentredOver(p, bar, main)).rejects.toThrow(/20\.0px off/);

		await p.setContent(screenChrome('50%', '700px'));
		await expect(expectCentredOver(p, bar, main)).rejects.toThrow(/reaches outside/);
	});

	/** A list column and an editor column side by side; `save` is the editor's last child. */
	const columns = (save: string) => `${FIXTURE_STYLE}
		<div style="display: grid; grid-template-columns: 320px 640px; gap: 24px;
			justify-content: center">
			<section id="list" style="height: 2000px; background: #222"></section>
			<section id="editor"><div style="height: 1500px"></div>${save}</section>
		</div>`;

	test('expectInColumn passes a sticky bar at the foot of its column, and fails a fixed bar across both', async ({
		page: p
	}) => {
		const [save, editor, list] = [p.locator('#save'), p.locator('#editor'), p.locator('#list')];
		await p.setContent(
			columns('<div id="save" style="position: sticky; bottom: 0; height: 64px"></div>')
		);
		await expectInColumn(p, save, editor, [list]);

		await p.setContent(
			columns('<div id="save" style="position: fixed; inset: auto 0 0; height: 64px"></div>')
		);
		await expect(expectInColumn(p, save, editor, [list])).rejects.toThrow(
			/reaches outside locator\('#editor'\)[\s\S]*covers locator\('#list'\)/
		);

		// Not sticky: it stays at the end of the column, below the window.
		await p.setContent(columns('<div id="save" style="height: 64px"></div>'));
		await expect(expectInColumn(p, save, editor, [list])).rejects.toThrow(/ends below the window/);
	});
});

test('pixelAt reads the colour of the pixel it is given', async ({ page: p }) => {
	await p.setContent(
		'<body style="margin: 0; display: flex; height: 100vh">' +
			'<div style="flex: 1; background: rgb(200 240 49)"></div>' +
			'<div style="flex: 1; background: rgb(18 18 20)"></div></body>'
	);
	const shot = await p.screenshot();
	const near = async (x: number, y: number, rgb: [number, number, number]) => {
		const pixel = await pixelAt(p, shot, x, y);
		expect(
			pixel.map((value, i) => Math.abs(value - rgb[i]!) <= 2),
			`(${x}, ${y}) is rgb(${pixel.join(' ')}), not rgb(${rgb.join(' ')})`
		).toEqual([true, true, true]);
	};
	await near(360, 450, [200, 240, 49]);
	await near(1080, 450, [18, 18, 20]);
});
