import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvValidationError, parseEnv, testRoutesEnabled } from './env';

const DB = 'postgres://coach:coach@localhost:5432/coach_dev';

function issuesOf(source: Record<string, string | undefined>): string[] {
	try {
		parseEnv(source);
	} catch (err) {
		if (err instanceof EnvValidationError) return err.issues;
		throw err;
	}
	return [];
}

describe('parseEnv', () => {
	it('applies defaults to a minimal valid environment', () => {
		const env = parseEnv({ DATABASE_URL: DB });
		expect(env).toMatchObject({
			appEnv: 'development',
			DB_POOL_MAX: 5,
			DB_QUERY_TIMEOUT_MS: 10_000,
			LOG_LEVEL: 'info',
			LLM_PROVIDER: 'mock',
			ENABLE_TEST_ROUTES: false
		});
		expect(env.SENTRY_DSN).toBeUndefined();
	});

	it('derives appEnv from APP_ENV, then VERCEL_ENV, then NODE_ENV', () => {
		expect(parseEnv({ DATABASE_URL: DB, NODE_ENV: 'production' }).appEnv).toBe('production');
		expect(parseEnv({ DATABASE_URL: DB, NODE_ENV: 'test' }).appEnv).toBe('test');
		expect(
			parseEnv({ DATABASE_URL: DB, NODE_ENV: 'production', VERCEL_ENV: 'preview' }).appEnv
		).toBe('preview');
		expect(
			parseEnv({ DATABASE_URL: DB, NODE_ENV: 'production', VERCEL_ENV: 'preview', APP_ENV: 'test' })
				.appEnv
		).toBe('test');
	});

	it('lists every invalid variable at once', () => {
		const issues = issuesOf({
			DATABASE_URL: 'mysql://nope',
			DB_POOL_MAX: '0',
			LOG_LEVEL: 'loud',
			SENTRY_DSN: 'not a url'
		});
		expect(issues.map((i) => i.split(':')[0])).toEqual(
			expect.arrayContaining(['DATABASE_URL', 'DB_POOL_MAX', 'LOG_LEVEL', 'SENTRY_DSN'])
		);
		expect(issuesOf({})).toEqual([expect.stringMatching(/^DATABASE_URL:/)]);
	});

	it('treats an empty SENTRY_DSN as unset', () => {
		expect(parseEnv({ DATABASE_URL: DB, SENTRY_DSN: '' }).SENTRY_DSN).toBeUndefined();
	});

	describe('production guards', () => {
		it('rejects test routes when appEnv is production', () => {
			expect(
				issuesOf({ DATABASE_URL: DB, APP_ENV: 'production', ENABLE_TEST_ROUTES: 'true' })
			).toEqual([expect.stringMatching(/^ENABLE_TEST_ROUTES: test routes must never be enabled/)]);
			expect(
				issuesOf({ DATABASE_URL: DB, NODE_ENV: 'production', ENABLE_TEST_ROUTES: '1' })
			).toHaveLength(1);
		});

		it('rejects test routes on Vercel production even if APP_ENV claims otherwise', () => {
			const issues = issuesOf({
				DATABASE_URL: DB,
				VERCEL_ENV: 'production',
				APP_ENV: 'preview',
				ENABLE_TEST_ROUTES: 'true'
			});
			expect(issues).toEqual(
				expect.arrayContaining([
					expect.stringMatching(/^APP_ENV: must be 'production'/),
					expect.stringMatching(/^ENABLE_TEST_ROUTES:/)
				])
			);
		});

		it('allows test routes only in local development and tests', () => {
			const test = parseEnv({ DATABASE_URL: DB, APP_ENV: 'test', ENABLE_TEST_ROUTES: 'true' });
			expect(test.ENABLE_TEST_ROUTES).toBe(true);
			expect(testRoutesEnabled(test)).toBe(true);
			const dev = parseEnv({ DATABASE_URL: DB, ENABLE_TEST_ROUTES: 'true' });
			expect(testRoutesEnabled(dev)).toBe(true);
			expect(testRoutesEnabled(parseEnv({ DATABASE_URL: DB, APP_ENV: 'test' }))).toBe(false);
		});

		it('rejects test routes on every hosted deployment, previews included', () => {
			// One of the test routes mints an owner session without a passkey.
			for (const hosted of [
				{ VERCEL_ENV: 'preview' },
				{ VERCEL_ENV: 'development' },
				{ VERCEL: '1', APP_ENV: 'test' },
				{ APP_ENV: 'preview' }
			]) {
				expect(
					issuesOf({ DATABASE_URL: DB, ENABLE_TEST_ROUTES: 'true', ...hosted }),
					JSON.stringify(hosted)
				).toEqual([expect.stringMatching(/^ENABLE_TEST_ROUTES: test routes are only allowed/)]);
			}
		});

		it('re-checks where test routes may run even for a hand-built environment', () => {
			const env = parseEnv({ DATABASE_URL: DB, APP_ENV: 'test', ENABLE_TEST_ROUTES: 'true' });
			expect(testRoutesEnabled({ ...env, appEnv: 'production' })).toBe(false);
			expect(testRoutesEnabled({ ...env, VERCEL_ENV: 'preview' })).toBe(false);
		});

		describe('in a server built for Vercel', () => {
			// What vite.config.ts bakes into a Vercel build; unset in Vitest, like a local run.
			const vercelBuild = () => vi.stubGlobal('__VERCEL_BUILD__', true);
			afterEach(() => vi.unstubAllGlobals());

			// A runtime environment without Vercel's own variables that claims to be a test run.
			const unmarked = {
				DATABASE_URL: DB,
				NODE_ENV: 'production',
				APP_ENV: 'test',
				ENABLE_TEST_ROUTES: 'true'
			};

			it('refuses to start with test routes enabled, whatever the runtime environment says', () => {
				vercelBuild();
				expect(issuesOf(unmarked)).toEqual([
					expect.stringMatching(/^ENABLE_TEST_ROUTES: test routes are only allowed/)
				]);
			});

			it('keeps the test routes disabled at runtime', () => {
				const env = parseEnv(unmarked);
				expect(testRoutesEnabled(env)).toBe(true); // allowed in a local build
				vercelBuild();
				expect(testRoutesEnabled(env)).toBe(false);
			});
		});
	});

	describe('owner setup token hash', () => {
		const HASH = 'a'.repeat(64);

		it('is optional and treats an empty value as unset', () => {
			expect(parseEnv({ DATABASE_URL: DB }).OWNER_SETUP_TOKEN_HASH).toBeUndefined();
			expect(
				parseEnv({ DATABASE_URL: DB, OWNER_SETUP_TOKEN_HASH: '' }).OWNER_SETUP_TOKEN_HASH
			).toBeUndefined();
		});

		it('accepts a hex SHA-256 digest (normalised to lower case)', () => {
			expect(
				parseEnv({ DATABASE_URL: DB, OWNER_SETUP_TOKEN_HASH: ` ${HASH.toUpperCase()} ` })
					.OWNER_SETUP_TOKEN_HASH
			).toBe(HASH);
		});

		it('rejects anything that is not a SHA-256 hex digest (e.g. the raw token)', () => {
			for (const bad of ['abc', 'g'.repeat(64), 'a'.repeat(63), 'Zm9vYmFy'.repeat(8)]) {
				expect(issuesOf({ DATABASE_URL: DB, OWNER_SETUP_TOKEN_HASH: bad })).toEqual([
					expect.stringMatching(/^OWNER_SETUP_TOKEN_HASH:/)
				]);
			}
		});

		it('requires an API key only for the anthropic provider', () => {
			expect(issuesOf({ DATABASE_URL: DB, LLM_PROVIDER: 'anthropic' })).toEqual([
				expect.stringMatching(/^ANTHROPIC_API_KEY: required/)
			]);
			expect(issuesOf({ DATABASE_URL: DB, LLM_PROVIDER: 'mock' })).toEqual([]);
		});
	});
});
