/**
 * Server environment, validated with zod.
 *
 * - Parsed once, lazily, on first access (`getEnv()`), and eagerly at server start from the
 *   `init` hook in `src/hooks.server.ts` so a misconfigured deployment fails fast and loudly.
 * - Framework-agnostic on purpose (reads `process.env`): the same schema is used by the app,
 *   by scripts (`scripts/db-migrate.ts`) and by tests.
 * - Never import this module from client code; SvelteKit's server-only guard enforces that
 *   because it lives under `src/lib/server/`.
 *
 * See docs/environment.md for every variable and where it is set.
 */
import { z } from 'zod';

const booleanString = z
	.enum(['true', 'false', '1', '0', ''])
	.optional()
	.transform((value) => value === 'true' || value === '1');

const postgresUrl = z
	.string()
	.min(1)
	.refine((value) => /^postgres(ql)?:\/\//.test(value), {
		message: 'must be a postgres:// or postgresql:// connection string'
	});

/**
 * An optional string, trimmed, where a blank value means unset. It accepts any string, so it
 * never fails validation: a consumer decides whether the value is usable.
 */
const lenientText = z
	.string()
	.optional()
	.transform((value) => value?.trim() || undefined);

export const APP_ENVS = ['development', 'test', 'preview', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

export const envSchema = z
	.object({
		NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
		/** Explicit environment name. Falls back to VERCEL_ENV, then NODE_ENV. */
		APP_ENV: z.enum(APP_ENVS).optional(),
		/** Set by Vercel: 'production' | 'preview' | 'development'. */
		VERCEL_ENV: z.enum(['production', 'preview', 'development']).optional(),
		VERCEL: booleanString,
		/** Set by Vercel: this deployment's own host (no scheme), e.g. `app-abc123.vercel.app`. */
		VERCEL_URL: z.string().optional(),
		/** Set by Vercel on Git deployments: the branch alias host (no scheme). */
		VERCEL_BRANCH_URL: z.string().optional(),

		/**
		 * Hex SHA-256 of the one-time owner setup token (`pnpm auth:setup-token`). Only the hash is
		 * configured; the token itself is the secret in the setup link `/setup?token=…`. Optional:
		 * without it, first-run setup is closed (the route returns 404). See docs/security.md.
		 */
		OWNER_SETUP_TOKEN_HASH: z
			.union([
				z
					.string()
					.trim()
					.toLowerCase()
					.regex(/^[0-9a-f]{64}$/, 'must be a 64-character hex SHA-256 digest'),
				z.literal('').transform(() => undefined)
			])
			.optional(),

		/** Pooled connection string used for application traffic (Neon: the `-pooler` host). */
		DATABASE_URL: postgresUrl,
		/** Direct (non-pooled) connection string, used for migrations and backups. */
		DATABASE_URL_UNPOOLED: postgresUrl.optional(),
		/** Max clients per server instance. Keep small: Neon's pooler multiplexes behind it. */
		DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
		/** Client-side timeout for a single query (ms). Pooler-safe (no session SET needed). */
		DB_QUERY_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),

		LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),

		/** Enables routes used only by automated tests (e.g. an intentional 500). Never in prod. */
		ENABLE_TEST_ROUTES: booleanString,

		/** Optional error reporting. Unused until a Sentry account exists; never required. */
		SENTRY_DSN: z.union([z.url(), z.literal('').transform(() => undefined)]).optional(),

		/** LLM provider for the coach (M5). `mock` is deterministic and needs no key. */
		LLM_PROVIDER: z.enum(['mock', 'anthropic']).default('mock'),
		ANTHROPIC_API_KEY: z.string().optional(),

		/**
		 * The email sign-in link (ADR 0011): the only recipient, the Resend key and the sender.
		 * Parsed leniently on purpose: a missing or malformed value never stops the server, it
		 * switches the feature off (`auth/email-link-config.ts` decides, and the startup log names
		 * the variable, never its value).
		 */
		OWNER_EMAIL: lenientText,
		RESEND_API_KEY: lenientText,
		EMAIL_FROM: lenientText
	})
	.transform((env) => {
		const appEnv: AppEnv =
			env.APP_ENV ??
			env.VERCEL_ENV ??
			(env.NODE_ENV === 'production'
				? 'production'
				: env.NODE_ENV === 'test'
					? 'test'
					: 'development');
		return { ...env, appEnv };
	})
	.superRefine((env, ctx) => {
		// Vercel's own signal wins: a stray APP_ENV must not relabel (and unlock) production.
		if (env.VERCEL_ENV === 'production' && env.APP_ENV && env.APP_ENV !== 'production') {
			ctx.addIssue({
				code: 'custom',
				path: ['APP_ENV'],
				message: `must be 'production' (or unset) when VERCEL_ENV=production`
			});
		}
		// Test routes include one that mints an owner session without a passkey (WebKit e2e):
		// an authentication bypass. Only local development and automated tests may enable them,
		// never a hosted deployment (any Vercel environment, preview included) or production.
		if (env.ENABLE_TEST_ROUTES && !testRoutesAllowed(env)) {
			ctx.addIssue({
				code: 'custom',
				path: ['ENABLE_TEST_ROUTES'],
				message:
					env.appEnv === 'production' || env.VERCEL_ENV === 'production'
						? 'test routes must never be enabled in production'
						: 'test routes are only allowed in local development and tests (never on Vercel or in preview)'
			});
		}
		if (env.LLM_PROVIDER === 'anthropic' && !env.ANTHROPIC_API_KEY) {
			ctx.addIssue({
				code: 'custom',
				path: ['ANTHROPIC_API_KEY'],
				message: 'required when LLM_PROVIDER=anthropic'
			});
		}
	});

export type Env = z.output<typeof envSchema>;

/**
 * Replaced at build time by vite.config.ts: `true` in a build for Vercel, `false` in a Node
 * build. Undefined where Vite did not build the code (`vite dev`, Vitest, scripts run by Node).
 */
declare const __VERCEL_BUILD__: boolean | undefined;

/**
 * Where test-only routes may exist: local development and automated tests, never on a hosted
 * deployment. Checked by env validation (startup fails) and again by every test-only route.
 */
function testRoutesAllowed(env: {
	appEnv: AppEnv;
	VERCEL?: boolean;
	VERCEL_ENV?: string;
}): boolean {
	// Defence in depth: `VERCEL`/`VERCEL_ENV` are runtime variables only. A server built for
	// Vercel never allows test routes, even if they are missing.
	if (typeof __VERCEL_BUILD__ !== 'undefined' && __VERCEL_BUILD__) return false;
	return (env.appEnv === 'development' || env.appEnv === 'test') && !env.VERCEL && !env.VERCEL_ENV;
}

/** True when test-only routes are enabled *and* allowed here (defence in depth for routes). */
export function testRoutesEnabled(env: Env = getEnv()): boolean {
	return env.ENABLE_TEST_ROUTES && testRoutesAllowed(env);
}

export class EnvValidationError extends Error {
	readonly issues: string[];

	constructor(issues: string[]) {
		super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
		this.name = 'EnvValidationError';
		this.issues = issues;
	}
}

/** Parse an environment record. Throws an `EnvValidationError` listing every problem. */
export function parseEnv(source: Record<string, string | undefined>): Env {
	const result = envSchema.safeParse(source);
	if (!result.success) {
		throw new EnvValidationError(
			result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
		);
	}
	return result.data;
}

let cached: Env | undefined;

/** The validated server environment (parsed from `process.env` once). */
export function getEnv(): Env {
	cached ??= parseEnv(process.env);
	return cached;
}

/** Test helper: forget the cached environment so the next `getEnv()` re-reads `process.env`. */
export function resetEnvCache(): void {
	cached = undefined;
}
