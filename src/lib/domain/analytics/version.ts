/**
 * The version of the analytics definitions: what a period is, how a series is bucketed and
 * summarised, and how each metric and trend verdict is computed. A stored review keeps the version
 * that computed it (analytics_version), and its inputs digest includes it, so a review can tell
 * whether today's definitions would give the same figures.
 *
 * Any change to a definition bumps it by one, in the same PR. Formatting, labels and refactors
 * that give the same numbers do not.
 *
 * Conventions for src/lib/domain/analytics (M6): pure, imported by path (no index file), no zod,
 * no runtime import of domain/programming or domain/exercises. Server-only at runtime: only the
 * modules listed in scripts/analytics-client-imports.test.ts are client-safe.
 */
export const ANALYTICS_VERSION = 1;
