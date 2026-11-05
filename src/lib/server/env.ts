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
		ANTHROPIC_API_KEY: z.string().optional()
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
		if (
			(env.appEnv === 'production' || env.VERCEL_ENV === 'production') &&
			env.ENABLE_TEST_ROUTES
		) {
			ctx.addIssue({
				code: 'custom',
				path: ['ENABLE_TEST_ROUTES'],
				message: 'test routes must never be enabled in production'
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
