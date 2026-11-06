/**
 * domain/exercises (the catalogue) and domain/programming (the generator) are server-only: a
 * page never loads them at runtime (eslint.config.js, "Server-only packages"). Each case lints a
 * snippet with ESLint's Node API against the repository's real config, exactly as `pnpm lint`
 * would see it at that path.
 *
 * - A runtime import is an error everywhere the browser can reach: UI, client code, route
 *   components, universal loads and the rest of the domain. `import type` is fine there.
 * - Server code, scripts, tests, e2e (m3/49's weekViolations runs the generator's checks) and
 *   the packages' own files may import them.
 * - The rule has its own name, so the layer rules on the same files keep firing beside it.
 *
 * typescript-eslint's project service parses .svelte files, so a .svelte case must name a file
 * that exists; the snippet replaces its text for this lint only.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const eslint = new ESLint({ cwd: root });

const SERVER_ONLY = '@typescript-eslint/no-restricted-imports';
const LAYER = 'no-restricted-imports';
const SIDE_EFFECT = '@typescript-eslint/no-import-type-side-effects';
/** Parsing .svelte files type-aware starts a TypeScript project: slow on a busy machine. */
const TIMEOUT = 120_000;

interface Finding {
	rule: string | null;
	message: string;
}

/** What ESLint reports for `code` at `file`; a file it could not parse fails the test. */
async function lint(file: string, code: string): Promise<Finding[]> {
	if (file.endsWith('.svelte') && !existsSync(path.join(root, file))) {
		throw new Error(`${file} must exist: the project service only parses real .svelte files`);
	}
	const [result] = await eslint.lintText(code, { filePath: path.join(root, file) });
	const fatal = result!.messages.find((m) => m.fatal);
	if (fatal) throw new Error(`${file}: ${fatal.message}`);
	return result!.messages.map((m) => ({ rule: m.ruleId, message: m.message }));
}

const rules = async (file: string, code: string) => (await lint(file, code)).map((f) => f.rule);

/** A component whose script is `script` and whose markup uses what it imported. */
const svelte = (script: string, markup: string) =>
	`<script lang="ts">\n\t${script.split('\n').join('\n\t')}\n</script>\n\n${markup}\n`;

/** A runtime import of each package, and a type-only one, as each kind of file writes it. */
function snippets(file: string, catalogue: string, generator: string) {
	if (file.endsWith('.svelte')) {
		return {
			runtime: svelte(
				[
					`import { CATALOGUE } from '${catalogue}';`,
					`import { buildProgrammingInput } from '${generator}';`
				].join('\n'),
				'<p>{CATALOGUE.length} {buildProgrammingInput.name}</p>'
			),
			// `data`, so the same snippet is also a valid +page.svelte.
			types: svelte(
				[
					`import type { CatalogueExercise } from '${catalogue}';`,
					`import type { ProgrammingInput } from '${generator}';`,
					`let { data }: { data: { entry: CatalogueExercise; input: ProgrammingInput } } = $props();`
				].join('\n'),
				'<p>{data.entry.name} {data.input.startsOn}</p>'
			)
		};
	}
	return {
		runtime: [
			`import { CATALOGUE } from '${catalogue}';`,
			`import { buildProgrammingInput } from '${generator}';`,
			'export const used = [CATALOGUE, buildProgrammingInput];',
			''
		].join('\n'),
		types: [
			`import type { CatalogueExercise } from '${catalogue}';`,
			`import type { ProgrammingInput } from '${generator}';`,
			'export type Used = [CatalogueExercise, ProgrammingInput];',
			''
		].join('\n')
	};
}

const ALIAS = ['#lib/domain/exercises/index.ts', '#lib/domain/programming/input.ts'] as const;

/** Every kind of file the browser can load, with the specifiers it would use. */
const BROWSER: { file: string; what: string; specifiers: readonly [string, string] }[] = [
	{ file: 'src/lib/ui/program/SessionCard.svelte', what: 'a UI component', specifiers: ALIAS },
	{
		file: 'src/lib/ui/program/WeekStrip.svelte',
		what: 'a UI component, by relative path',
		specifiers: ['../../domain/exercises/index.ts', '../../domain/programming/input.ts']
	},
	{ file: 'src/lib/ui/program/week.ts', what: 'a UI module', specifiers: ALIAS },
	{ file: 'src/lib/client/program.ts', what: 'browser-only client code', specifiers: ALIAS },
	{
		file: 'src/routes/(app)/train/+page.svelte',
		what: 'a route component, by $lib',
		specifiers: ['$lib/domain/exercises/index.ts', '$lib/domain/programming/input.ts']
	},
	{ file: 'src/routes/(app)/train/+page.ts', what: 'a universal page load', specifiers: ALIAS },
	{
		file: 'src/routes/(app)/train/session/+page.ts',
		what: 'a universal page load, by relative path',
		specifiers: [
			'../../../../lib/domain/exercises/index.ts',
			'../../../../lib/domain/programming/input.ts'
		]
	},
	{ file: 'src/routes/(app)/+layout.ts', what: 'a universal layout load', specifiers: ALIAS },
	{ file: 'src/lib/domain/training/week.ts', what: 'domain/training', specifiers: ALIAS },
	{
		file: 'src/lib/domain/training/week.ts',
		what: 'domain/training, by relative path',
		specifiers: ['../exercises/index.ts', '../programming/input.ts']
	}
];

describe('server-only packages: browser-reachable code', () => {
	for (const { file, what, specifiers } of BROWSER) {
		it(
			`a runtime import of either package is an error in ${what} (${file})`,
			async () => {
				const findings = await lint(file, snippets(file, ...specifiers).runtime);
				expect(findings.map((f) => f.rule)).toEqual([SERVER_ONLY, SERVER_ONLY]);
				expect(findings[0]!.message).toMatch(/server-only/);
			},
			TIMEOUT
		);

		it(
			`\`import type\` from either package is clean in ${what} (${file})`,
			async () => {
				expect(await rules(file, snippets(file, ...specifiers).types)).toEqual([]);
			},
			TIMEOUT
		);
	}

	it(
		'the domain index cannot re-export either package, though it may re-export their types',
		async () => {
			const file = 'src/lib/domain/index.ts';
			expect(
				await rules(
					file,
					"export * from './exercises/index.ts';\nexport { buildProgrammingInput } from './programming/input.ts';\n"
				)
			).toEqual([SERVER_ONLY, SERVER_ONLY]);
			expect(
				await rules(
					file,
					"export type { CatalogueExercise } from './exercises/index.ts';\nexport type * from './programming/input.ts';\n"
				)
			).toEqual([]);
		},
		TIMEOUT
	);

	it(
		'`import { type X }` is an error, because Vite keeps it as a runtime import',
		async () => {
			// verbatimModuleSyntax ($app/tsconfig) turns it into `import '…/index.ts'`, which loads
			// the whole catalogue; only `import type` is erased.
			const file = 'src/lib/client/program.ts';
			const code =
				"import { type CatalogueExercise } from '#lib/domain/exercises/index.ts';\nexport type Entry = CatalogueExercise;\n";
			expect(await rules(file, code)).toEqual([SIDE_EFFECT]);
		},
		TIMEOUT
	);
});

/** Code that runs only on the server, in tests or in scripts, and the packages themselves. */
const ALLOWED: { file: string; what: string }[] = [
	{ file: 'src/lib/server/services/programs/build.ts', what: 'a server service' },
	{ file: 'src/routes/(app)/train/+page.server.ts', what: 'a server page load' },
	{ file: 'src/routes/(app)/train/+layout.server.ts', what: 'a server layout load' },
	{ file: 'src/routes/api/test-support/program/+server.ts', what: 'an endpoint' },
	{ file: 'src/hooks.server.ts', what: 'the server hooks' },
	{ file: 'scripts/seed-demo.ts', what: 'a script' },
	{ file: 'tests/integration/training/program.test.ts', what: 'an integration test' },
	{ file: 'e2e/program-journey.serial.e2e.ts', what: 'an e2e spec' },
	{ file: 'src/lib/domain/programming/generate.ts', what: 'a file inside domain/programming' },
	{ file: 'src/lib/domain/exercises/digest.ts', what: 'a file inside domain/exercises' }
];

describe('server-only packages: server, tests, scripts and the packages', () => {
	for (const { file, what } of ALLOWED) {
		it(
			`a runtime import of either package is clean in ${what} (${file})`,
			async () => {
				expect(await rules(file, snippets(file, ...ALIAS).runtime)).toEqual([]);
			},
			TIMEOUT
		);
	}
});

describe('the layer boundaries on the same files still fire', () => {
	it(
		'a UI component importing #lib/server/… is still an error, beside the server-only one',
		async () => {
			const code = svelte(
				[
					"import { CATALOGUE } from '#lib/domain/exercises/index.ts';",
					"import { requireOwner } from '#lib/server/auth/index.ts';"
				].join('\n'),
				'<p>{CATALOGUE.length} {requireOwner.name}</p>'
			);
			const findings = await lint('src/lib/ui/program/SessionCard.svelte', code);
			expect(findings.map((f) => f.rule)).toEqual([SERVER_ONLY, LAYER]);
			expect(findings[1]!.message).toMatch(/Server-only code cannot be imported here/);
		},
		TIMEOUT
	);

	it(
		'a domain file importing node:fs is still an error',
		async () => {
			const code = "import { readFileSync } from 'node:fs';\nexport const read = readFileSync;\n";
			const findings = await lint('src/lib/domain/training/week.ts', code);
			expect(findings.map((f) => f.rule)).toEqual([LAYER]);
			expect(findings[0]!.message).toMatch(/The domain layer is pure/);
		},
		TIMEOUT
	);

	it(
		'client code importing UI and a universal load importing the database are still errors',
		async () => {
			expect(
				await rules(
					'src/lib/client/program.ts',
					"import Badge from '#lib/ui/components/Badge.svelte';\nexport const badge = Badge;\n"
				)
			).toEqual([LAYER]);
			expect(
				await rules(
					'src/routes/(app)/train/+page.ts',
					"import { db } from '#lib/server/db/index.ts';\nexport const load = () => db;\n"
				)
			).toEqual([LAYER]);
		},
		TIMEOUT
	);
});
