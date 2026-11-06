import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEnv, resetEnvCache, testRoutesEnabled, type Env } from '../env';
import {
	DEFAULT_EMAIL_FROM,
	emailLinkConfig,
	emailLinkConfigured,
	emailLinkLogFields,
	type EmailLinkConfig
} from './email-link-config';

const DB = 'postgres://coach:coach@localhost:5432/coach_dev';
const OWNER = 'owner@example.test';
const KEY = 're_example_not_a_real_key';

const env = (source: Record<string, string | undefined> = {}): Env =>
	parseEnv({ DATABASE_URL: DB, ...source });

/** The configuration with test routes off, as on any server that is not a test server. */
const configOf = (source: Record<string, string | undefined> = {}) =>
	emailLinkConfig(env(source), { testRoutes: false });

const off = (missing: string[], invalid: string[] = []) => ({
	enabled: false,
	reason: 'configuration',
	missing,
	invalid
});

const resend = { enabled: true, provider: 'resend', ownerEmail: OWNER, from: DEFAULT_EMAIL_FROM };

afterEach(() => vi.unstubAllGlobals());

describe('emailLinkConfig: which variables switch it on', () => {
	it('is off with nothing set, and names both required variables', () => {
		expect(configOf()).toEqual(off(['OWNER_EMAIL', 'RESEND_API_KEY']));
		expect(configOf({ APP_ENV: 'production' })).toEqual(off(['OWNER_EMAIL', 'RESEND_API_KEY']));
	});

	it('is off with only the key, for want of OWNER_EMAIL', () => {
		expect(configOf({ RESEND_API_KEY: KEY })).toEqual(off(['OWNER_EMAIL']));
	});

	it('is off with only the address, for want of RESEND_API_KEY', () => {
		expect(configOf({ OWNER_EMAIL: OWNER })).toEqual(off(['RESEND_API_KEY']));
	});

	it('is off when a variable is blank, which means unset', () => {
		expect(configOf({ OWNER_EMAIL: '  ', RESEND_API_KEY: KEY })).toEqual(off(['OWNER_EMAIL']));
		expect(configOf({ OWNER_EMAIL: OWNER, RESEND_API_KEY: '' })).toEqual(off(['RESEND_API_KEY']));
	});

	it('uses Resend with both, in production and in development', () => {
		for (const where of [
			{ APP_ENV: 'production' },
			{ NODE_ENV: 'production' },
			{ VERCEL: '1', VERCEL_ENV: 'production' },
			{ APP_ENV: 'development' },
			{}
		]) {
			expect(
				configOf({ ...where, OWNER_EMAIL: OWNER, RESEND_API_KEY: KEY }),
				JSON.stringify(where)
			).toEqual({ ...resend, apiKey: KEY });
		}
	});
});

describe('emailLinkConfig: previews', () => {
	it('is always off in a preview, by appEnv or by VERCEL_ENV, whatever is set', () => {
		const everything = {
			OWNER_EMAIL: OWNER,
			RESEND_API_KEY: KEY,
			EMAIL_FROM: 'Coach <c@example.test>'
		};
		for (const where of [
			{ APP_ENV: 'preview' },
			{ VERCEL: '1', VERCEL_ENV: 'preview' },
			// APP_ENV relabels appEnv, but Vercel's own signal still says preview.
			{ VERCEL: '1', VERCEL_ENV: 'preview', APP_ENV: 'development' }
		]) {
			for (const testRoutes of [false, true]) {
				expect(
					emailLinkConfig(env({ ...where, ...everything }), { testRoutes }),
					JSON.stringify({ where, testRoutes })
				).toEqual({ enabled: false, reason: 'preview', missing: [], invalid: [] });
			}
		}
	});
});

describe('emailLinkConfig: the recording test provider', () => {
	const testServer = env({ APP_ENV: 'test', ENABLE_TEST_ROUTES: 'true', OWNER_EMAIL: OWNER });

	it('is chosen whenever test routes are enabled and allowed, and needs no key', () => {
		expect(testRoutesEnabled(testServer)).toBe(true);
		expect(emailLinkConfig(testServer, { testRoutes: testRoutesEnabled(testServer) })).toEqual({
			enabled: true,
			provider: 'test',
			ownerEmail: OWNER,
			from: DEFAULT_EMAIL_FROM
		});
		const devServer = env({ ENABLE_TEST_ROUTES: 'true', OWNER_EMAIL: OWNER });
		expect(emailLinkConfig(devServer, { testRoutes: testRoutesEnabled(devServer) })).toMatchObject({
			provider: 'test'
		});
	});

	it('wins over a Resend key, which it never carries, so a test server never sends real mail', () => {
		const withKey = env({
			APP_ENV: 'test',
			ENABLE_TEST_ROUTES: 'true',
			OWNER_EMAIL: OWNER,
			RESEND_API_KEY: KEY
		});
		const config = emailLinkConfig(withKey, { testRoutes: testRoutesEnabled(withKey) });
		expect(config).toMatchObject({ enabled: true, provider: 'test' });
		expect(config).not.toHaveProperty('apiKey');
		expect(JSON.stringify(config)).not.toContain(KEY);
	});

	it('still needs a valid OWNER_EMAIL and EMAIL_FROM', () => {
		const base = { APP_ENV: 'test', ENABLE_TEST_ROUTES: 'true' };
		expect(emailLinkConfig(env(base), { testRoutes: true })).toEqual(off(['OWNER_EMAIL']));
		expect(
			emailLinkConfig(env({ ...base, OWNER_EMAIL: 'nobody', EMAIL_FROM: 'Coach' }), {
				testRoutes: true
			})
		).toEqual(off([], ['OWNER_EMAIL', 'EMAIL_FROM']));
	});

	it('is never chosen on Vercel, even when the caller asks for test routes', () => {
		// parseEnv refuses test routes on Vercel; a hand-built environment must not get further.
		for (const hosted of [
			{ VERCEL: true },
			{ VERCEL_ENV: 'production' as const },
			{ VERCEL_ENV: 'development' as const }
		]) {
			const onVercel = { ...testServer, ...hosted };
			expect(emailLinkConfig(onVercel, { testRoutes: true }), JSON.stringify(hosted)).toEqual(
				off(['RESEND_API_KEY'])
			);
			expect(
				emailLinkConfig({ ...onVercel, RESEND_API_KEY: KEY }, { testRoutes: true })
			).toMatchObject({ provider: 'resend' });
			expect(testRoutesEnabled(onVercel)).toBe(false);
		}
	});

	it('is never chosen in a server built for Vercel, whatever the runtime environment says', () => {
		vi.stubGlobal('__VERCEL_BUILD__', true);
		expect(testRoutesEnabled(testServer)).toBe(false);
		expect(emailLinkConfig(testServer, { testRoutes: true })).toEqual(off(['RESEND_API_KEY']));
		expect(
			emailLinkConfig({ ...testServer, RESEND_API_KEY: KEY }, { testRoutes: true })
		).toMatchObject({ provider: 'resend' });
	});
});

describe('emailLinkConfig: invalid values switch it off and are named', () => {
	const valid = { OWNER_EMAIL: OWNER, RESEND_API_KEY: KEY };

	it('refuses an OWNER_EMAIL that is not exactly one address', () => {
		for (const bad of [
			'owner',
			'owner@',
			'@example.test',
			'owner@example',
			'owner @example.test',
			'owner@example.test, other@example.test',
			'owner@example.test other@example.test',
			'Owner <owner@example.test>',
			'mailto:owner@example.test'
		]) {
			expect(configOf({ ...valid, OWNER_EMAIL: bad }), bad).toEqual(off([], ['OWNER_EMAIL']));
		}
	});

	it('refuses a key that is not a Resend key (prefix re_)', () => {
		for (const bad of [
			'sk_live_example',
			'example_re_key',
			're_',
			'RE_EXAMPLE_KEY',
			're_has space'
		]) {
			expect(configOf({ ...valid, RESEND_API_KEY: bad }), bad).toEqual(off([], ['RESEND_API_KEY']));
		}
	});

	it('refuses an EMAIL_FROM that is neither an address nor Name <address>', () => {
		for (const bad of [
			'Performance Coach',
			'Coach <coach@example.test',
			'Coach <not an address>',
			'<coach@example.test>',
			'Coach <coach@example.test> trailing',
			'Coach <a@example.test> <b@example.test>',
			'"Coach" <coach@example.test>',
			'Coach\r\nBcc: other@example.test <coach@example.test>',
			'coach@example.test, other@example.test'
		]) {
			expect(configOf({ ...valid, EMAIL_FROM: bad }), JSON.stringify(bad)).toEqual(
				off([], ['EMAIL_FROM'])
			);
		}
	});

	it('names every problem at once, missing and invalid apart', () => {
		expect(
			configOf({ OWNER_EMAIL: 'nobody', RESEND_API_KEY: 'sk_x', EMAIL_FROM: 'Coach' })
		).toEqual(off([], ['OWNER_EMAIL', 'RESEND_API_KEY', 'EMAIL_FROM']));
		expect(configOf({ OWNER_EMAIL: 'nobody' })).toEqual(off(['RESEND_API_KEY'], ['OWNER_EMAIL']));
	});
});

describe('emailLinkConfig: the address and the sender', () => {
	it('lower-cases the owner address', () => {
		expect(configOf({ OWNER_EMAIL: ' Owner@Example.TEST ', RESEND_API_KEY: KEY })).toMatchObject({
			enabled: true,
			ownerEmail: OWNER
		});
	});

	it("sends from Resend's onboarding address by default", () => {
		expect(DEFAULT_EMAIL_FROM).toBe('Performance Coach <onboarding@resend.dev>');
		expect(configOf({ OWNER_EMAIL: OWNER, RESEND_API_KEY: KEY })).toMatchObject({
			from: DEFAULT_EMAIL_FROM
		});
	});

	it('keeps a configured sender as written, bare or named', () => {
		for (const from of [
			'coach@example.test',
			'Coach <coach@example.test>',
			'Performance Coach<Coach@Example.test>',
			'Ré Coach <coach@mail.example.test>'
		]) {
			expect(
				configOf({ OWNER_EMAIL: OWNER, RESEND_API_KEY: KEY, EMAIL_FROM: from }),
				from
			).toMatchObject({ enabled: true, from });
		}
	});
});

describe('emailLinkLogFields', () => {
	it('names the provider, or why it is off, and never a value', () => {
		const cases: [EmailLinkConfig, Record<string, unknown>][] = [
			[
				{ ...resend, provider: 'resend', apiKey: KEY } as EmailLinkConfig,
				{ emailSignIn: 'resend' }
			],
			[{ ...resend, provider: 'test' } as EmailLinkConfig, { emailSignIn: 'test' }],
			[
				configOf({ OWNER_EMAIL: 'Nobody', RESEND_API_KEY: 'sk_secret_value' }),
				{
					emailSignIn: 'off',
					emailSignInOff: 'configuration',
					emailSignInMissing: [],
					emailSignInInvalid: ['OWNER_EMAIL', 'RESEND_API_KEY']
				}
			],
			[
				configOf(),
				{
					emailSignIn: 'off',
					emailSignInOff: 'configuration',
					emailSignInMissing: ['OWNER_EMAIL', 'RESEND_API_KEY'],
					emailSignInInvalid: []
				}
			],
			[
				emailLinkConfig(env({ APP_ENV: 'preview', OWNER_EMAIL: OWNER, RESEND_API_KEY: KEY }), {
					testRoutes: false
				}),
				{
					emailSignIn: 'off',
					emailSignInOff: 'preview',
					emailSignInMissing: [],
					emailSignInInvalid: []
				}
			]
		];
		for (const [config, fields] of cases) {
			const logged = emailLinkLogFields(config);
			expect(logged).toEqual(fields);
			for (const secret of [OWNER, KEY, 'Nobody', 'sk_secret_value', DEFAULT_EMAIL_FROM]) {
				expect(JSON.stringify(logged)).not.toContain(secret);
			}
		}
	});
});

describe('emailLinkConfigured', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		resetEnvCache();
	});

	it("reads this server's environment once, and again only after it is re-read", () => {
		vi.stubEnv('DATABASE_URL', DB);
		vi.stubEnv('APP_ENV', 'development');
		vi.stubEnv('ENABLE_TEST_ROUTES', 'false');
		vi.stubEnv('OWNER_EMAIL', OWNER);
		vi.stubEnv('RESEND_API_KEY', KEY);
		vi.stubEnv('EMAIL_FROM', '');
		resetEnvCache();
		const first = emailLinkConfigured();
		expect(first).toEqual({ ...resend, apiKey: KEY });

		vi.stubEnv('RESEND_API_KEY', '');
		expect(emailLinkConfigured()).toBe(first);

		resetEnvCache();
		expect(emailLinkConfigured()).toEqual(off(['RESEND_API_KEY']));
	});

	it('picks the test provider on a test server', () => {
		vi.stubEnv('DATABASE_URL', DB);
		vi.stubEnv('APP_ENV', 'test');
		vi.stubEnv('ENABLE_TEST_ROUTES', 'true');
		vi.stubEnv('OWNER_EMAIL', OWNER);
		vi.stubEnv('RESEND_API_KEY', KEY);
		resetEnvCache();
		expect(emailLinkConfigured()).toMatchObject({ enabled: true, provider: 'test' });
	});
});
