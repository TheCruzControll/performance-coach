/**
 * The owner's first-run setup, for real: a WebAuthn registration through a CDP virtual
 * authenticator (Chromium), recovery codes shown once, then the signed-in browser state every
 * Chromium spec starts from. Also audits the setup screens and checks the setup link's rate
 * limit (both exist only until this runs), and registers the owner passkeys specs sign in with
 * (one per worker, e2e/webauthn.ts).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test as setup, type Page } from '@playwright/test';
import { RATE_LIMITS } from '../src/lib/server/auth/policy';
import { captureScreen, query, toastWith, trackConsoleErrors } from './support';
import { addVirtualAuthenticator, saveOwnerPasskeys, type StoredPasskey } from './webauthn';

const STATE = 'e2e/.auth/chromium.json';

// Runs first, while setup is still open: only then does /setup check tokens (and count them).
setup('a rate-limited setup link is a 404 too, never a server error', async ({ request }) => {
	const token = process.env.E2E_SETUP_TOKEN;
	expect(token, 'global setup mints the setup token').toBeTruthy();
	const { limit } = RATE_LIMITS.setup;
	try {
		// Spend this client's budget on wrong tokens; past it even the right token is refused,
		// with the same 404 as any other refusal (nothing tells a guesser they were limited).
		const responses = [];
		for (let i = 0; i < limit + 2; i++) {
			responses.push(
				await request.get(`/setup?token=${i < limit ? 'not-the-token-but-long-enough' : token}`)
			);
		}
		expect(responses.map((res) => res.status())).toEqual(Array(limit + 2).fill(404));
		const requestIds = responses.map((res) => res.headers()['x-request-id']);

		// The limiter did refuse the last two (its first refusal is audited) …
		const limited = await query<{ request_id: string }>(
			`select request_id from auth_events where type = 'rate_limited' and request_id = any($1)`,
			[requestIds]
		);
		expect(limited.map((row) => row.request_id)).toEqual([requestIds[limit]]);
		// … and no refusal was recorded as a server incident.
		const incidents = await query(
			'select kind, status from app_errors where request_id = any($1)',
			[requestIds]
		);
		expect(incidents).toEqual([]);
	} finally {
		// As if the window had passed: the owner's real setup below starts with a full budget.
		await query(`delete from auth_rate_limits where key like 'setup:%'`);
	}
});

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

		// One more owner passkey per worker, each on a device of its own, added while this session
		// is fresh (setup just verified a passkey, so no step-up) and kept with its private key.
		const ownerPasskeys: StoredPasskey[] = [];
		for (let i = 0; i < testInfo.config.workers; i++) {
			const device = await context.newPage();
			const key = await addVirtualAuthenticator(device);
			await device.goto('/profile/security');
			// Hydrated first: a tap on the server-rendered button before then does nothing.
			await device.waitForLoadState('networkidle');
			await device.getByTestId('add-passkey').click();
			await expect(toastWith(device, /Passkey added: /)).toBeVisible();
			ownerPasskeys.push(...(await key.credentials()));
			await device.close();
		}
		expect(ownerPasskeys).toHaveLength(testInfo.config.workers);
		saveOwnerPasskeys(ownerPasskeys);

		expect(errors).toEqual([]);
		await context.storageState({ path: STATE });
	}
);
