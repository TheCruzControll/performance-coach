/**
 * Core workout logging has no path to the agent (eslint.config.js, 'Core workout logging'): the
 * workout and exercise endpoints and services/workouts never import the agent or an LLM SDK.
 * Each case lints a snippet with ESLint's Node API against the repository's real config, exactly
 * as `pnpm lint` sees it at that path.
 *
 * The blocks also repeat their folders' layer patterns, because a later flat-config block's
 * no-restricted-imports replaces an earlier one's for the same files: those must still fire, and
 * so must m3/16's server-only rule, which has its own name.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const eslint = new ESLint({ cwd: root });

const LAYER = 'no-restricted-imports';
const SERVER_ONLY = '@typescript-eslint/no-restricted-imports';
const TIMEOUT = 120_000;

/** The rule and message of each finding for `code` at `file`; a parse failure fails the test. */
async function lint(file: string, code: string) {
	const [result] = await eslint.lintText(code, { filePath: path.join(root, file) });
	const fatal = result!.messages.find((m) => m.fatal);
	if (fatal) throw new Error(`${file}: ${fatal.message}`);
	return result!.messages.map((m) => ({ rule: m.ruleId, message: m.message }));
}

const importing = (specifier: string) =>
	`import * as imported from '${specifier}';\nexport const used = imported;\n`;

const GUARDED = [
	{ file: 'src/routes/api/workouts/sync/+server.ts', agent: '#lib/server/agent/index.ts' },
	{ file: 'src/routes/api/exercises/+server.ts', agent: '$lib/server/agent/index.ts' },
	{ file: 'src/lib/server/services/workouts/sync.ts', agent: '../../agent/index.ts' },
	{ file: 'src/lib/server/services/workouts/apply/sets.ts', agent: '../../../agent/index.ts' }
];

const LLM_SDKS = ['@anthropic-ai/sdk', '@anthropic-ai/sdk/resources/messages', 'openai'];

describe('core workout logging cannot reach the agent or an LLM', () => {
	for (const { file, agent } of GUARDED) {
		it(
			`importing the agent is an error in ${file}`,
			async () => {
				const findings = await lint(file, importing(agent));
				// services/** also refuses the agent with its own layer message.
				expect(new Set(findings.map((f) => f.rule))).toEqual(new Set([LAYER]));
				expect(findings.map((f) => f.message)).toContainEqual(
					expect.stringMatching(/never reaches the agent or an LLM/)
				);
			},
			TIMEOUT
		);

		for (const sdk of LLM_SDKS) {
			it(
				`importing ${sdk} is an error in ${file}`,
				async () => {
					const findings = await lint(file, importing(sdk));
					expect(findings.map((f) => f.rule)).toEqual([LAYER]);
					expect(findings[0]!.message).toMatch(/never reaches the agent or an LLM/);
				},
				TIMEOUT
			);
		}
	}

	it(
		'outside core logging the same imports are not this rule’s: the agent may use an SDK',
		async () => {
			const findings = await lint(
				'src/lib/server/agent/provider/anthropic.ts',
				importing('@anthropic-ai/sdk')
			);
			expect(findings.filter((f) => /workout logging/.test(f.message))).toEqual([]);
		},
		TIMEOUT
	);
});

describe('the folders’ own boundaries still hold under the new blocks', () => {
	it(
		'a workout endpoint still cannot import the database layer or a driver',
		async () => {
			const file = 'src/routes/api/workouts/sync/+server.ts';
			for (const specifier of ['#lib/server/db/index.ts', 'drizzle-orm', 'pg']) {
				const findings = await lint(file, importing(specifier));
				expect(
					findings.map((f) => f.rule),
					specifier
				).toEqual([LAYER]);
				expect(findings[0]!.message).not.toMatch(/workout logging/);
			}
		},
		TIMEOUT
	);

	it(
		'an exercises endpoint still cannot import the database layer',
		async () => {
			const findings = await lint(
				'src/routes/api/exercises/+server.ts',
				importing('#lib/server/db/index.ts')
			);
			expect(findings.map((f) => f.rule)).toEqual([LAYER]);
		},
		TIMEOUT
	);

	it(
		'services/workouts still cannot import UI, browser code or the framework',
		async () => {
			const file = 'src/lib/server/services/workouts/sync.ts';
			for (const specifier of [
				'#lib/ui/Button.svelte',
				'#lib/client/workout/store.ts',
				'@sveltejs/kit'
			]) {
				const findings = await lint(file, importing(specifier));
				expect(
					findings.map((f) => f.rule),
					specifier
				).toEqual([LAYER]);
				expect(findings[0]!.message).not.toMatch(/workout logging/);
			}
		},
		TIMEOUT
	);

	it(
		'services/workouts may use the database layer and the training services',
		async () => {
			const file = 'src/lib/server/services/workouts/sync.ts';
			for (const specifier of ['../../db/repositories/sync', '../training/log']) {
				expect(await lint(file, importing(specifier)), specifier).toEqual([]);
			}
		},
		TIMEOUT
	);

	it(
		'm3/16’s server-only rule still fires on a route component',
		async () => {
			const code = [
				'<script lang="ts">',
				"\timport { CATALOGUE } from '$lib/domain/exercises/index.ts';",
				'</script>',
				'',
				'<p>{CATALOGUE.length}</p>',
				''
			].join('\n');
			const findings = await lint('src/routes/(app)/today/+page.svelte', code);
			expect(findings.map((f) => f.rule)).toEqual([SERVER_ONLY]);
		},
		TIMEOUT
	);
});
