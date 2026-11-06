/**
 * Training (PRD §5, §9, §11): the vocabulary, the program-plan contract's types and their words
 * (describe). The metrics module joins them here when it lands.
 *
 * It never re-exports ./schemas.ts or ./edits.ts. Validators are imported by path, always on
 * servers and on demand in browsers, so importing this index never puts zod in a page's initial
 * JavaScript (scripts/training-index-imports.test.ts). Like domain/profile, it is not
 * re-exported from src/lib/domain/index.ts.
 */
export type * from './types.ts';
export * from './describe.ts';
export * from './vocabulary.ts';
