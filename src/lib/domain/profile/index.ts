/**
 * Training profile (PRD §2, §3): vocabulary, onboarding rules and read-model types. The zod
 * schemas live in ./schemas.ts and are imported directly (servers always; browsers on demand),
 * so importing this index never pulls a validator into a page's initial JavaScript.
 */
export * from './catalog';
export * from './onboarding';
export type * from './types';
