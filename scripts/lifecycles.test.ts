/**
 * docs/lifecycles.md is generated from the lifecycle registry (src/lib/domain/lifecycles.ts) by
 * `pnpm lifecycles` and committed. This keeps the committed file in step with the tables.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LIFECYCLES } from '../src/lib/domain/lifecycles.ts';
import { LIFECYCLES_FILE, renderLifecycles } from './lifecycles.ts';

const root = fileURLToPath(new URL('../', import.meta.url));

describe('docs/lifecycles.md', () => {
	it('the committed docs/lifecycles.md equals a fresh render', async () => {
		expect(
			readFileSync(path.join(root, LIFECYCLES_FILE), 'utf8'),
			'run `pnpm lifecycles` and commit the result'
		).toBe(await renderLifecycles(LIFECYCLES));
	});
});
