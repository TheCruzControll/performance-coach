/**
 * The screens outside the app shell in a desktop window (docs/design-system.md, Responsive
 * layout → Screens). Sign-in, recovery and the recovery session's new passkey share AuthScreen,
 * which from 1024 px puts the brand and the headline on the left and the action panel, as a
 * card, on the right, vertically centred. Every state the frame shows is opened here and checked
 * in that card. First-run setup and its recovery codes exist only once, so auth.setup.ts checks
 * them at this size on the same page.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { relyingPartyFor } from '../src/lib/server/auth/relying-party';
import {
	BELOW_DESKTOP_WIDTH,
	DESKTOP,
	DESKTOP_WIDTHS,
	expectCardBeside,
	expectNoSideScroll
} from './desktop';
import {
	captureScreen,
	gotoHydrated,
	ORIGIN,
	query,
	SAME_ORIGIN,
	signedOut,
	trackConsoleErrors
} from './support';
import { chromiumOnly, ownerPasskey, withoutPasskeyAutofill } from './webauthn';

test.use({ ...DESKTOP, storageState: signedOut });

const headlineOf = (page: Page) => page.getByRole('heading', { level: 1 });
/** AuthScreen's action card: its body (notices) and its panel (the controls), inside <main>. */
const cardOf = (page: Page) => page.locator('main#main > :is(.body, .panel)');
const panelOf = (page: Page) => page.locator('main#main > .panel');

async function boxOf(locator: Locator) {
	const box = await locator.boundingBox();
	expect(box, `${locator} is on the page`).not.toBeNull();
	return box!;
}

/** A length token (e.g. `--content-wide: 72rem`) in CSS pixels. */
const tokenPx = (page: Page, token: string) =>
	page.evaluate((name) => {
		const probe = document.createElement('div');
		probe.style.width = `var(${name})`;
		document.body.append(probe);
		const width = probe.getBoundingClientRect().width;
		probe.remove();
		return width;
	}, token);

/** The width the page lays out in (less the scrollbar gutter base.css keeps). */
const layoutWidth = (page: Page) =>
	page.evaluate(() => document.documentElement.getBoundingClientRect().width);

/**
 * The two-column frame: the brand above the headline at the left, the card beside it (each of
 * `contains` inside it), the footer under the headline and left of the card, and the frame no
 * wider than --content-wide, centred.
 */
async function expectDesktopFrame(page: Page, contains: Locator[] = []) {
	await page.evaluate(() => document.fonts.ready);
	const headline = headlineOf(page);
	await expectCardBeside(page, { card: cardOf(page), beside: headline, contains });
	const title = await boxOf(headline);
	const brand = await boxOf(page.locator('.brand'));
	expect(Math.abs(brand.x - title.x), 'the brand row is above the headline').toBeLessThanOrEqual(1);
	expect(brand.y + brand.height).toBeLessThanOrEqual(title.y);
	const footer = page.locator('footer');
	if (await footer.count()) {
		const box = await boxOf(footer);
		const card = await boxOf(panelOf(page));
		expect(Math.abs(box.x - title.x), 'the footer starts under the headline').toBeLessThanOrEqual(
			1
		);
		expect(box.x + box.width, 'the footer ends left of the card').toBeLessThanOrEqual(card.x);
	}
	const frame = await boxOf(page.locator('main#main').locator('..'));
	const wide = await tokenPx(page, '--content-wide');
	expect(frame.width, 'the frame is at most --content-wide').toBeLessThanOrEqual(wide + 1);
	const width = await layoutWidth(page);
	expect(
		Math.abs(frame.x - (width - frame.x - frame.width)),
		'the frame is centred'
	).toBeLessThanOrEqual(1);
	await expectNoSideScroll(page);
}

/** No WCAG A/AA violations in the dark theme, then in the light one. */
async function auditBothThemes(page: Page, label: string) {
	for (const theme of ['dark', 'light'] as const) {
		await page.evaluate((t) => {
			if (t === 'dark') delete document.documentElement.dataset.theme;
			else document.documentElement.dataset.theme = t;
		}, theme);
		await page.waitForTimeout(250);
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

/** What has focus: the skip link, `main`, or the focused control's test id. */
const focused = (page: Page) =>
	page.evaluate(() => {
		const el = document.activeElement as HTMLElement;
		if (el.matches('.skip-link')) return 'skip';
		if (el.matches('main#main')) return 'main';
		return el.dataset.testid ?? el.outerHTML.slice(0, 60);
	});

/**
 * The skip link moves focus to <main>, and (Chromium, where Tab reaches every control) the next
 * Tab stops go through the panel's controls in the order they read.
 */
async function expectSkipIntoPanel(page: Page, browserName: string, controls: string[]) {
	await page.getByRole('link', { name: 'Skip to content' }).focus();
	await page.keyboard.press('Enter');
	await expect(page.locator('main#main')).toBeFocused();
	// macOS WebKit tabs only between text fields unless Full Keyboard Access is on.
	if (browserName !== 'chromium') return;
	const stops: string[] = [];
	for (let i = 0; i < controls.length; i++) {
		await page.keyboard.press('Tab');
		stops.push(await focused(page));
	}
	expect(stops, 'Tab from <main> goes through the panel').toEqual(controls);
	const tops: number[] = [];
	for (const id of controls) tops.push((await boxOf(page.getByTestId(id))).y);
	expect(tops, 'the controls read top to bottom in focus order').toEqual(
		[...tops].sort((a, b) => a - b)
	);
	const panel = panelOf(page);
	for (const id of controls) await expect(panel.getByTestId(id)).toBeVisible();
}

test.describe('sign-in and recovery at 1440 × 900', () => {
	test('sign-in: headline left, card right, centred, every way in above the fold', async ({
		page,
		browserName
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		await gotoHydrated(page, '/');
		await expect(headlineOf(page)).toHaveText('Train with intent.');
		await expectDesktopFrame(page);
		await expect(page.getByTestId('passkey-signin')).toBeInViewport();
		await expect(page.getByTestId('use-recovery-code')).toBeInViewport();
		await captureScreen(page, testInfo, 'landing-desktop');
		await auditBothThemes(page, 'sign-in');

		if (browserName === 'chromium') {
			// Tab from the top of the page: the skip link, then the card's controls as they read.
			await page.keyboard.press('Tab');
			const stops = [await focused(page)];
			for (let i = 0; i < 3; i++) {
				await page.keyboard.press('Tab');
				stops.push(await focused(page));
			}
			expect(stops).toEqual(['skip', 'passkey-field', 'passkey-signin', 'use-recovery-code']);
		}
		await expectSkipIntoPanel(page, browserName, [
			'passkey-field',
			'passkey-signin',
			'use-recovery-code'
		]);
		expect(errors).toEqual([]);
	});

	test('recovery: the code form in the card, beside the headline', async ({
		page,
		browserName
	}, testInfo) => {
		await gotoHydrated(page, '/recover');
		await expect(headlineOf(page)).toHaveText('Lost your passkey?');
		await expectDesktopFrame(page);
		await captureScreen(page, testInfo, 'recover-desktop');
		await auditBothThemes(page, 'recover');
		await expectSkipIntoPanel(page, browserName, ['recovery-code-input', 'recovery-submit']);
	});

	test('no sideways scroll from 1024 to 1920 px, and one column again at 1023 px', async ({
		page
	}) => {
		for (const path of ['/', '/recover']) {
			await page.setViewportSize(DESKTOP.viewport);
			await page.goto(path);
			await page.evaluate(() => document.fonts.ready);
			for (const width of DESKTOP_WIDTHS) {
				await page.setViewportSize({ width, height: 900 });
				await expectNoSideScroll(page);
				const title = await boxOf(headlineOf(page));
				const panel = await boxOf(panelOf(page));
				expect(panel.x, `${path} at ${width}px: the card is beside the headline`).toBeGreaterThan(
					title.x + title.width
				);
			}

			await page.setViewportSize({ width: BELOW_DESKTOP_WIDTH, height: 900 });
			await expectNoSideScroll(page);
			const title = await boxOf(headlineOf(page));
			const panel = await boxOf(panelOf(page));
			expect(panel.y, `${path} at 1023px: the panel is under the headline`).toBeGreaterThanOrEqual(
				title.y + title.height
			);
			expect(Math.abs(panel.x - title.x), `${path} at 1023px: one column`).toBeLessThanOrEqual(1);
			// The single column takes the readable width on a tablet, centred.
			const frame = await boxOf(page.locator('main#main').locator('..'));
			const readable = await tokenPx(page, '--content-readable');
			expect(
				Math.abs(frame.width - readable),
				`${path} at 1023px: ${frame.width}px`
			).toBeLessThanOrEqual(1);
			const width = await layoutWidth(page);
			expect(Math.abs(frame.x - (width - frame.x - frame.width))).toBeLessThanOrEqual(1);
		}
	});
});

test.describe('every state of the frame, in the card', () => {
	test('signed out: the notice sits in the card above the way back in', async ({
		page
	}, testInfo) => {
		await gotoHydrated(page, '/?signedOut=1');
		const notice = page.getByTestId('signed-out-notice');
		await expect(notice).toBeVisible();
		await expectDesktopFrame(page, [notice]);
		await captureScreen(page, testInfo, 'signed-out-desktop');
		await auditBothThemes(page, 'signed out');
	});

	test('a refused passkey: the error in the card, and Sign in works again', async ({
		page,
		browserName
	}, testInfo) => {
		test.skip(browserName !== 'chromium', chromiumOnly[1]);
		// Every spec signs in from the same address: start from a fresh sign-in budget.
		await query(`delete from auth_rate_limits where key like 'signin.%'`);
		const authenticator = await ownerPasskey(page, testInfo);
		await withoutPasskeyAutofill(page);
		await authenticator.setUserVerified(false); // Face ID fails: user verification is required
		await gotoHydrated(page, '/');
		await page.getByTestId('passkey-signin').click();
		const error = page.getByTestId('signin-error');
		await expect(error).toBeVisible();
		await expectDesktopFrame(page, [error]);
		await captureScreen(page, testInfo, 'sign-in-error-desktop');
		await auditBothThemes(page, 'sign-in error');

		await authenticator.setUserVerified(true);
		await page.getByTestId('passkey-signin').click();
		await expect(page).toHaveURL(/\/today$/);
	});

	test('a browser without passkeys: Sign in is off and recovery is offered, in the card', async ({
		page
	}, testInfo) => {
		await page.addInitScript(() => {
			delete (window as { PublicKeyCredential?: unknown }).PublicKeyCredential;
		});
		await gotoHydrated(page, '/');
		const notice = page.getByRole('status').filter({ hasText: 'This browser can’t use passkeys' });
		await expect(notice).toBeVisible();
		await expect(page.getByTestId('passkey-signin')).toBeDisabled();
		const recovery = page.getByTestId('use-recovery-code');
		await expect(recovery).toBeEnabled();
		await expectDesktopFrame(page, [notice, recovery]);
		await captureScreen(page, testInfo, 'no-passkeys-desktop');
		await auditBothThemes(page, 'no passkeys');
	});

	test('an address passkeys cannot use: the notice names localhost, in the card', async ({
		page
	}, testInfo) => {
		// What the test relying party says of the app opened on 127.0.0.1. The e2e server pins its
		// origin (ORIGIN, adapter-node), so it calls every address localhost: the refusal reaches
		// the sign-in page as that route's own data, on a client-side navigation to it.
		const verdict = relyingPartyFor(
			{ appEnv: 'test' },
			new URL(ORIGIN.replace('//localhost', '//127.0.0.1'))
		);
		expect(verdict.ok).toBe(false);
		const { reason, signInUrl } = verdict as { reason: string; signInUrl?: string };
		expect(reason).toContain('http://localhost');
		await page.route(
			(url) => url.pathname === '/__data.json',
			async (route) => {
				const response = await route.fetch();
				// SvelteKit's data: per node, devalue's flat form (values by index, objects of indexes).
				const body = (await response.json()) as { nodes: ({ data?: unknown[] } | null)[] };
				for (const node of body.nodes) {
					const values = node?.data;
					const data = values?.[0];
					if (!values || typeof data !== 'object' || !data || !('unavailable' in data)) continue;
					const refusal = {
						reason: values.push(reason) - 1,
						signInUrl: values.push(signInUrl ?? null) - 1
					};
					Object.assign(data, { unavailable: values.push(refusal) - 1 });
				}
				await route.fulfill({ response, json: body });
			}
		);
		await gotoHydrated(page, '/recover');
		await page.getByRole('link', { name: 'Back to sign in' }).click();
		await expect(page).toHaveURL(/\/$/);
		const notice = page
			.getByRole('status')
			.filter({ hasText: 'Passkeys aren’t available on this address' });
		await expect(notice).toContainText(reason);
		await expect(page.getByTestId('passkey-signin')).toBeDisabled();
		await expectDesktopFrame(page, [notice]);
		await captureScreen(page, testInfo, 'unavailable-desktop');
		await auditBothThemes(page, 'unavailable address');
	});

	test('a wrong recovery code: the error under the field, in the card', async ({
		page,
		browserName
	}, testInfo) => {
		// Wrong codes count against limits every spec shares (policy.ts): one engine is enough.
		test.skip(browserName !== 'chromium', 'checked on Chromium only, to spare the shared limit');
		try {
			await gotoHydrated(page, '/recover');
			await page.getByTestId('recovery-code-input').fill('AAAA-BBBB-CCCC-DDDD');
			await page.getByTestId('recovery-submit').click();
			const error = page.getByRole('alert').filter({ hasText: "That code didn't work" });
			await expect(error).toBeVisible();
			await expectDesktopFrame(page, [error]);
			await captureScreen(page, testInfo, 'recover-error-desktop');
			await auditBothThemes(page, 'recover error');
		} finally {
			// Wrong codes count against one per-client limit every spec shares (policy.ts).
			await query(`delete from auth_rate_limits where key like 'recovery:ip:%'`);
		}
	});

	test('after a recovery code: a new passkey, its controls first after the skip link', async ({
		page,
		context,
		browserName
	}, testInfo) => {
		// A recovery session without burning a code: a test session given the columns
		// redeemRecoveryCode sets (kind and method recovery, 15 minutes to live).
		const minted = await context.request.post('/api/test-support/session', {
			headers: SAME_ORIGIN
		});
		expect(minted.status()).toBe(200);
		const { sessionId } = (await minted.json()) as { sessionId: string };
		try {
			await query(
				`update auth_sessions
				 set kind = 'recovery', method = 'recovery',
				     expires_at = created_at + interval '15 minutes',
				     absolute_expires_at = created_at + interval '15 minutes'
				 where id = $1`,
				[sessionId]
			);
			await gotoHydrated(page, '/recover/passkey');
			await expect(page.getByTestId('recover-passkey-screen')).toBeVisible();
			const codesLeft = page.getByTestId('codes-left');
			await expect(codesLeft).toContainText(/recovery codes? left/);
			await expectDesktopFrame(page, [codesLeft]);
			await captureScreen(page, testInfo, 'recover-passkey-desktop');
			await auditBothThemes(page, 'recover passkey');
			await expectSkipIntoPanel(page, browserName, ['create-recovery-passkey', 'recover-cancel']);
		} finally {
			await query(
				`update auth_sessions set revoked_at = now(), revoked_reason = 'signout' where id = $1`,
				[sessionId]
			);
		}
	});
});
