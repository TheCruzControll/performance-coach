/**
 * A program starts only after the owner's setup (owner decision 2026-11-12). The build
 * (services/programming/build.ts) refuses an unfinished onboarding before it stores anything, and
 * every way the app creates a program goes through it: Today's Build, the coach's
 * create-program proposal (services/coach/apply/program-create.ts) and its preview tool. The
 * store underneath, createProgramFromPlan, takes any plan (test fixtures seed programs with it),
 * so this test keeps it out of every other path in src: a new caller must go through the build,
 * or be test support.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));

/** Where createProgramFromPlan may be named outside a comment. */
const ALLOWED = [
	'src/lib/server/services/programs/store.ts', // its definition
	'src/lib/server/services/programs/index.ts', // the services' index re-exports it
	'src/lib/server/services/programming/build.ts', // the build, after its onboarding check
	'src/lib/server/test-support/', // fixtures for tests and the test-only routes
	'src/routes/api/test-support/' // the test-only seeding route (404 unless ENABLE_TEST_ROUTES)
];

const sources = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) return sources(file);
		return /\.(ts|svelte)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [file] : [];
	});

const COMMENT = /^\s*(\*|\/\/|\/\*|<!--)/;

/** Every file under src that names `name` outside a comment, relative to the root. */
function callers(name: string): string[] {
	const word = new RegExp(`\\b${name}\\b`);
	return sources(path.join(root, 'src'))
		.filter((file) =>
			readFileSync(file, 'utf8')
				.split('\n')
				.some((line) => !COMMENT.test(line) && word.test(line))
		)
		.map((file) => path.relative(root, file).split(path.sep).join('/'));
}

describe('the way a program is created', () => {
	it('is the build, which refuses an unfinished setup; the store is named nowhere else', () => {
		const outside = callers('createProgramFromPlan').filter(
			(file) => !ALLOWED.some((allowed) => file === allowed || file.startsWith(allowed))
		);
		expect(outside).toEqual([]);
	});

	it('finds the callers it allows, so the scan is reading the code', () => {
		expect(callers('createProgramFromPlan')).toEqual(
			expect.arrayContaining([
				'src/lib/server/services/programming/build.ts',
				'src/routes/api/test-support/program/+server.ts'
			])
		);
	});
});
