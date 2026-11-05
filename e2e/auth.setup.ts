/**
 * The owner's first-run setup, for real: a WebAuthn registration through a CDP virtual
 * authenticator (Chromium), recovery codes shown once, then the signed-in browser state every
 * Chromium spec starts from. Also audits the setup screens (they exist only until this runs).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test as setup, type Page } from '@playwright/test';
import { captureScreen, query, trackConsoleErrors } from './support';
import { addVirtualAuthenticator } from './webauthn';

const STATE = 'e2e/.auth/chromium.json';

async function auditBothThemes(page: Page, label: string) {
	for (const theme of ['dark', 'light'] as const) {
		await page.evaluate((t) => {
			if (t === 'dark') delete document.documentElement.dataset.theme;
			else document.documentElement.dataset.theme = t;
		}, theme);
		await page.waitForTimeout(300);
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

setup(
	'owner completes first-run setup with a real passkey',
	async ({ page, context }, testInfo) => {
		const token = process.env.E2E_SETUP_TOKEN;
		expect(token, 'global setup mints the setup token').toBeTruthy();
		const errors = trackConsoleErrors(page);

		// Without the right token the setup URL does not exist.
		for (const url of ['/setup', '/setup?token=not-the-token-but-long-enough']) {
			expect((await page.request.get(url)).status(), url).toBe(404);
		}

		const authenticator = await addVirtualAuthenticator(page);
		await context.grantPermissions(['clipboard-read', 'clipboard-write']);
		await page.goto(`/setup?token=${token}`);
		await expect(page.getByRole('heading', { level: 1, name: 'Make it yours.' })).toBeVisible();
		await captureScreen(page, testInfo, 'setup');
		await auditBothThemes(page, 'setup');

		// The name is required (designed inline error).
		await page.getByTestId('create-passkey').click();
		await expect(page.getByText('Enter your name.')).toBeVisible();
		await page.getByTestId('owner-name').fill('Niko Cruz');
		await page.getByTestId('create-passkey').click();

		// Recovery codes, shown exactly once.
		await expect(page.getByTestId('setup-codes')).toBeVisible();
		const codes = await page.getByTestId('recovery-code').locator('.value').allTextContents();
		expect(codes).toHaveLength(10);
		for (const code of codes)
			expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
		await expect(page.getByTestId('setup-done')).toBeDisabled();
		await captureScreen(page, testInfo, 'setup-recovery-codes');
		await auditBothThemes(page, 'recovery codes');

		const [download] = await Promise.all([
			page.waitForEvent('download'),
			page.getByTestId('download-codes').click()
		]);
		expect(download.suggestedFilename()).toBe('performance-coach-recovery-codes.txt');
		const text = await download
			.createReadStream()
			.then((stream) => new Response(stream as unknown as ReadableStream).text());
		for (const code of codes) expect(text).toContain(code);

		await page.getByTestId('copy-codes').click();
		await expect(page.getByText('Recovery codes copied')).toBeVisible();
		expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(codes[0]);

		await page.getByTestId('ack-codes').check();
		await page.getByTestId('setup-done').click();
		await expect(page).toHaveURL(/\/today$/);
		await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();

		// The authenticator holds a discoverable passkey for this RP; the server stored hashes only.
		const credentials = await authenticator.credentials();
		expect(credentials).toHaveLength(1);
		expect(credentials[0]).toMatchObject({ rpId: 'localhost' });
		const [owner] = await query<{ display_name: string; setup: boolean }>(
			'select display_name, setup_completed_at is not null as setup from owners'
		);
		expect(owner).toEqual({ display_name: 'Niko Cruz', setup: true });
		const stored = await query<{ code_hash: string }>('select code_hash from recovery_codes');
		expect(stored).toHaveLength(10);
		expect(JSON.stringify(stored)).not.toContain(codes[0]);

		// Setup is gone for good, even with the right token.
		expect((await page.request.get(`/setup?token=${token}`)).status()).toBe(404);

		expect(errors).toEqual([]);
		await context.storageState({ path: STATE });
	}
);
