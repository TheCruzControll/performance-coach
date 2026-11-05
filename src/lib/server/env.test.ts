import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseEnv } from './env';

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

		it('allows test routes outside production', () => {
			expect(
				parseEnv({ DATABASE_URL: DB, APP_ENV: 'test', ENABLE_TEST_ROUTES: 'true' })
					.ENABLE_TEST_ROUTES
			).toBe(true);
			expect(
				parseEnv({ DATABASE_URL: DB, VERCEL_ENV: 'preview', ENABLE_TEST_ROUTES: 'true' }).appEnv
			).toBe('preview');
		});

		it('requires an API key only for the anthropic provider', () => {
			expect(issuesOf({ DATABASE_URL: DB, LLM_PROVIDER: 'anthropic' })).toEqual([
				expect.stringMatching(/^ANTHROPIC_API_KEY: required/)
			]);
			expect(issuesOf({ DATABASE_URL: DB, LLM_PROVIDER: 'mock' })).toEqual([]);
		});
	});
});
