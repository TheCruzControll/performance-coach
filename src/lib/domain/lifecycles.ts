/**
 * Every declared lifecycle. `pnpm lifecycles` renders this list to docs/lifecycles.md, the
 * registry test checks each table is sound, and the server guard keeps one ENFORCE entry per id.
 * Edit a table first, then run `pnpm lifecycles`.
 */
import type { Lifecycle } from './lifecycle.ts';
import { PROPOSAL } from './training/lifecycles.ts';
import { PROGRAM } from './training/program-lifecycle.ts';
import { WORKOUT } from './workout/lifecycles.ts';

export const LIFECYCLES: readonly Lifecycle<string, string>[] = [WORKOUT, PROPOSAL, PROGRAM];
