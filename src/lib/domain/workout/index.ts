/**
 * Workouts (PRD §7–§9, §15): the contract, wire format v1. README.md lists every module.
 *
 * It never re-exports ./schemas.ts: validators are imported by path, always on servers and on
 * demand in browsers, so importing this index never puts zod in a page's initial JavaScript.
 * Like domain/training, it is not re-exported from src/lib/domain/index.ts.
 */
export type * from './types.ts';
export * from './mutations.ts';
export * from './protocol.ts';
