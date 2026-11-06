/**
 * The coach's client-safe contract (PRD §4, §12): its vocabulary, the stream's events and SSE
 * codec, source refs and their actions, the rich-text tree, the memory snapshot, the tool
 * catalogue, activity wording, pricing and budgets. Screens, the stream client and the server all
 * import it from here, and no later slice edits this file: each module grows behind its own
 * `export *`.
 *
 * It never reaches zod, a server-only coach module (answer, markdown, proposals, grounding and
 * the others the server-only rule lists), domain/exercises or domain/programming
 * (scripts/coach-index-imports.test.ts). Those are imported by path. Like domain/training, it is
 * not re-exported from src/lib/domain/index.ts.
 */
export * from './vocabulary.ts';
export * from './events.ts';
export * from './sources.ts';
export * from './rich.ts';
export * from './memory.ts';
export * from './tools.ts';
export * from './activity.ts';
export * from './pricing.ts';
export * from './budgets.ts';
