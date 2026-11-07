/**
 * src/lib/domain/workout/index.ts is the contract the workout pages import, so it must never load
 * a validator at runtime: domain/workout/schemas.ts or zod would then ship in the initial
 * JavaScript of /workout. The schemas are imported by path instead (the sync endpoint always, the
 * Fix flow on demand). The walk is scripts/import-graph.ts, as training-index-imports uses it;
 * that test proves the walk itself.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chains, ROOT as root } from './import-graph.ts';

const workout = (file: string) => path.join(root, 'src/lib/domain/workout', file);
const isZod = (specifier: string) => specifier === 'zod' || specifier.startsWith('zod/');

/** Every chain of runtime imports from `entry` to the workout schemas or zod. */
const validatorChains = (entry: string) =>
	chains([entry], ({ specifier, file }) => isZod(specifier) || file === workout('schemas.ts'));

describe('domain/workout/index.ts', () => {
	it('loads no validator at runtime, directly or through what it re-exports', () => {
		const { chains, visited } = validatorChains(workout('index.ts'));
		expect(chains).toEqual([]);
		// The walk really follows the index's runtime re-exports.
		expect(visited).toContain('src/lib/domain/workout/mutations.ts');
		expect(visited).toContain('src/lib/domain/workout/protocol.ts');
	});

	it('is watched where it matters: the schemas themselves load zod', () => {
		expect(validatorChains(workout('schemas.ts')).chains).not.toEqual([]);
	});
});
