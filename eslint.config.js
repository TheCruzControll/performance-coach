import path from 'node:path';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

/**
 * Architectural import boundaries (see docs/architecture.md#module-boundaries).
 * Each layer may only depend "inwards". Patterns match both `#lib/...` subpath imports and
 * relative paths, so a boundary cannot be bypassed with `../../`.
 *
 * @param {Array<{ regex: string, message: string }>} patterns
 * @returns {import('eslint').Linter.RulesRecord}
 */
const restrict = (patterns) => ({
	'no-restricted-imports': ['error', { patterns }]
});

/** @param {string} name */
const layer = (name) => `(^#lib/${name}|lib/${name}|^(\\.\\./)+${name.split('/').pop()})(/|$)`;

const LAYER = {
	server: {
		regex: `${layer('server')}|^\\$app/server$`,
		message: 'Server-only code cannot be imported here.'
	},
	db: {
		regex: layer('server/db'),
		message:
			'Only services may use the database layer. Call a service in #lib/server/services instead.'
	},
	services: {
		regex: layer('server/services'),
		message: 'The database layer must not depend on services.'
	},
	agent: {
		regex: layer('server/agent'),
		message: 'Services must not depend on the agent; the agent depends on services.'
	},
	ui: { regex: layer('ui'), message: 'This layer must not depend on UI components.' },
	client: {
		regex: layer('client'),
		message: 'This layer must not depend on browser-only client code.'
	},
	framework: {
		regex: '^(\\$app/|@sveltejs/kit|svelte($|/))',
		message: 'This layer is framework-agnostic: no SvelteKit/Svelte imports.'
	},
	io: {
		regex: '^(node:|pg$|drizzle-orm|@vercel/)',
		message: 'The domain layer is pure: no I/O, Node built-ins or database drivers.'
	},
	driver: {
		regex: '^(pg|pg-[\\w-]+|drizzle-orm|@neondatabase/[\\w-]+)($|/)',
		message:
			'Routes and hooks do not talk to the database: no driver or ORM imports. Call a service in #lib/server/services instead.'
	},
	observabilityDeps: {
		regex: `${layer('server/db')}|${layer('server/services')}|${layer('server/agent')}|${layer('server/auth')}`,
		message:
			'Observability is a leaf: the logger, request context and timing helpers must not depend on db, services, agent or auth.'
	},
	mailDeps: {
		regex: [
			...['db', 'services', 'agent', 'auth', 'forms'].map((name) => layer(`server/${name}`)),
			'(^#lib/server/env|lib/server/env|^(\\.\\./)+env)(\\.ts)?$',
			'^\\$env/',
			'^(pg|drizzle-orm)($|/)'
		].join('|'),
		message:
			'Mail is a leaf: it is built from explicit options (the caller passes the key and the addresses) and may use the logger, never db, services, agent, auth, forms, the env or a driver.'
	}
};

/**
 * domain/exercises (the catalogue) and domain/programming (the generator) by an alias (`#lib/`,
 * `$lib/`), a path through `lib/`, or a relative path (`../programming`, `./exercises`,
 * `../../domain/exercises`). Types are fine: `import type` is erased from the bundle.
 */
const SERVER_ONLY_PACKAGES = {
	regex: '(lib/domain/|^(\\.\\.?/)+(domain/)?)(exercises|programming)(/|$)',
	allowTypeImports: true,
	message:
		'domain/exercises and domain/programming are server-only: use them in server code (src/lib/server, +page.server.ts) and send the page the result. `import type` is fine.'
};

/**
 * domain/coach's server-only modules (M5): the answer parser, the markdown reader, the proposal
 * payloads, rules and diff, and the grounding, memory, summary, trend and note formatters. The
 * browser gets their results, never the modules. `import type` is fine.
 */
const COACH_SERVER_ONLY_NAMES =
	'(answer|markdown|proposals|proposal-rules|diff|grounding|memory-format|summary|trends|notes)(\\.ts)?$';
const COACH_SERVER_ONLY_MESSAGE =
	"domain/coach's answer, markdown, proposals, proposal-rules, diff, grounding, memory-format, summary, trends and notes modules are server-only: use them in server code and send the page the result. `import type` is fine.";
/** By an alias, a path through `lib/`, or a relative path through `domain/`. */
const SERVER_ONLY_COACH = {
	regex: `(lib/domain/|^(\\.\\.?/)+domain/)coach/${COACH_SERVER_ONLY_NAMES}`,
	allowTypeImports: true,
	message: COACH_SERVER_ONLY_MESSAGE
};
/** From a sibling domain package (`../coach/markdown.ts`). */
const SERVER_ONLY_COACH_FROM_DOMAIN = {
	regex: `^\\.\\./coach/${COACH_SERVER_ONLY_NAMES}`,
	allowTypeImports: true,
	message: COACH_SERVER_ONLY_MESSAGE
};
/** From inside domain/coach (`./markdown.ts`). */
const SERVER_ONLY_COACH_FROM_COACH = {
	regex: `^\\./${COACH_SERVER_ONLY_NAMES}`,
	allowTypeImports: true,
	message: COACH_SERVER_ONLY_MESSAGE
};
/** The server-only coach modules and their tests, which may import each other. */
const COACH_SERVER_ONLY_FILES = [
	'answer',
	'markdown',
	'proposals',
	'proposal-rules',
	'diff',
	'grounding',
	'memory-format',
	'summary',
	'trends',
	'notes'
].flatMap((name) => [`src/lib/domain/coach/${name}.ts`, `src/lib/domain/coach/${name}.test.ts`]);

/** The LLM SDK: types anywhere on the server, a runtime import only in the Anthropic provider. */
const LLM_SDK = {
	regex: '^@anthropic-ai/',
	allowTypeImports: true,
	message:
		'@anthropic-ai/* is imported at runtime only by src/lib/server/agent/provider/anthropic.ts (by a dynamic import), so neither the SDK nor a key reaches anything else. `import type` is fine.'
};

/**
 * The coach's modules, which workout logging never imports (M5). The agent and the SDKs are
 * already refused there (CORE_LOGGING, LAYER.server and LLM_SDK).
 */
const COACH_MODULES = {
	regex: ['domain/coach', 'ui/coach', 'client/coach', 'server/services/coach'].map(layer).join('|'),
	message:
		'Workout logging never depends on the coach: no domain/coach, ui/coach, client/coach or services/coach imports, so logging works whatever the coach is doing.'
};

/** The agent and the LLM SDKs, which core workout logging never imports (M4). */
const CORE_LOGGING = {
	regex: `${layer('server/agent')}|^(@anthropic-ai/[\\w.-]+|openai)($|/)`,
	message:
		'Core workout logging never reaches the agent or an LLM: the coach reads logged workouts through services, never the other way round.'
};

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	{ ignores: ['.claude/**', 'drizzle/meta/**', 'static/**'] },
	js.configs.recommended,
	ts.configs.recommended,
	svelte.configs.recommended,
	prettier,
	svelte.configs.prettier,
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node } },
		rules: {
			// typescript-eslint recommends disabling no-undef for TypeScript projects.
			'no-undef': 'off',
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
			],
			'@typescript-eslint/consistent-type-imports': 'error',
			'svelte/button-has-type': 'error',
			'svelte/no-at-html-tags': 'error',
			'svelte/require-each-key': 'error'
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser
			}
		}
	},

	// ---- Module boundaries -------------------------------------------------------------
	{
		files: ['src/lib/domain/**'],
		rules: restrict([LAYER.server, LAYER.ui, LAYER.client, LAYER.framework, LAYER.io])
	},
	{
		files: ['src/lib/ui/**'],
		rules: {
			...restrict([LAYER.server]),
			// UI primitives forward hrefs that callers already built with resolve().
			'svelte/no-navigation-without-resolve': ['error', { ignoreLinks: true }]
		}
	},
	{
		files: ['src/lib/client/**'],
		rules: restrict([LAYER.server, LAYER.ui])
	},
	{
		files: ['src/lib/server/db/**'],
		rules: restrict([LAYER.services, LAYER.agent, LAYER.ui, LAYER.client, LAYER.framework])
	},
	{
		files: ['src/lib/server/services/**'],
		rules: restrict([LAYER.agent, LAYER.ui, LAYER.client, LAYER.framework])
	},
	{
		files: ['src/lib/server/agent/**'],
		rules: restrict([LAYER.db, LAYER.ui, LAYER.client, LAYER.framework])
	},
	{
		// Auth may use services and the db layer; it never reaches into UI or browser code.
		files: ['src/lib/server/auth/**'],
		rules: restrict([LAYER.ui, LAYER.client])
	},
	{
		// Form actions are route code that routes share: they call services, never the database.
		files: ['src/lib/server/forms/**'],
		rules: restrict([LAYER.db, LAYER.driver, LAYER.agent, LAYER.ui, LAYER.client])
	},
	{
		files: ['src/lib/server/observability/**'],
		rules: restrict([LAYER.observabilityDeps, LAYER.ui, LAYER.client, LAYER.framework])
	},
	{
		// Mail reads no configuration itself, so the provider is chosen in one place
		// (auth/email-link-config.ts), where a test server always gets the recording mailer.
		files: ['src/lib/server/mail/**'],
		rules: {
			...restrict([LAYER.mailDeps, LAYER.ui, LAYER.client, LAYER.framework]),
			'no-restricted-properties': [
				'error',
				{ object: 'process', property: 'env', message: LAYER.mailDeps.message }
			]
		}
	},
	{
		files: ['src/routes/**', 'src/hooks.server.ts', 'src/hooks.client.ts'],
		rules: restrict([LAYER.db, LAYER.driver])
	},

	// ---- Server-only packages ----------------------------------------------------------
	// The catalogue and the generator never reach the browser (scripts/server-only-imports.test.ts).
	// typescript-eslint's copy of no-restricted-imports has its own name, so this block never
	// replaces the layer patterns restrict([...]) sets on the same files. (It is deprecated in
	// favour of the core rule; if it is removed, add SERVER_ONLY_PACKAGES to those blocks.)
	// Not listed, so free to import them: src/lib/server/**, +page.server.ts, +layout.server.ts,
	// +server.ts, hooks, scripts/**, tests/** and e2e/** (m3/49's weekViolations runs the
	// generator's checks in specs). A dynamic import() is not checked here; `pnpm budgets` fails
	// if the catalogue is in any client chunk, lazy ones included.
	{
		files: [
			'src/lib/ui/**',
			'src/lib/client/**',
			'src/routes/**/*.svelte',
			'src/routes/**/+page.ts',
			'src/routes/**/+layout.ts',
			'src/lib/domain/**'
		],
		// The packages import their own files.
		ignores: [
			'src/lib/domain/programming/**',
			'src/lib/domain/exercises/**',
			...COACH_SERVER_ONLY_FILES
		],
		rules: {
			'@typescript-eslint/no-restricted-imports': [
				'error',
				{ patterns: [SERVER_ONLY_PACKAGES, SERVER_ONLY_COACH, LLM_SDK] }
			],
			// `import { type X }` stays a runtime import under verbatimModuleSyntax (Vite keeps
			// `import 'X'`), so only `import type` gets past the rule above.
			'@typescript-eslint/no-import-type-side-effects': 'error'
		}
	},

	// ---- The coach (M5) ----------------------------------------------------------------
	// The blocks below replace the server-only rule's patterns on the files they match, so each
	// repeats the patterns above before adding its own (scripts/server-only-imports.test.ts).
	{
		// The rest of the domain, which may reach domain/coach by `../coach/…`.
		files: ['src/lib/domain/**'],
		ignores: [
			'src/lib/domain/programming/**',
			'src/lib/domain/exercises/**',
			'src/lib/domain/coach/**',
			'**/*.test.ts'
		],
		rules: {
			'@typescript-eslint/no-restricted-imports': [
				'error',
				{
					patterns: [
						SERVER_ONLY_PACKAGES,
						SERVER_ONLY_COACH,
						SERVER_ONLY_COACH_FROM_DOMAIN,
						LLM_SDK
					]
				}
			]
		}
	},
	{
		// domain/coach's client-safe modules (vocabulary, events, safety, statements, …), which reach
		// the server-only ones by `./…`. Tests never ship, so they may.
		files: ['src/lib/domain/coach/**'],
		ignores: [...COACH_SERVER_ONLY_FILES, '**/*.test.ts'],
		rules: {
			'@typescript-eslint/no-restricted-imports': [
				'error',
				{
					patterns: [SERVER_ONLY_PACKAGES, SERVER_ONLY_COACH, SERVER_ONLY_COACH_FROM_COACH, LLM_SDK]
				}
			]
		}
	},
	{
		// The server-only coach modules may import each other, but names and eligibility arrive as
		// data: they still never load the catalogue or the generator.
		files: COACH_SERVER_ONLY_FILES.filter((file) => !file.endsWith('.test.ts')),
		rules: {
			'@typescript-eslint/no-restricted-imports': [
				'error',
				{ patterns: [SERVER_ONLY_PACKAGES, LLM_SDK] }
			]
		}
	},
	{
		// Server code may use the SDK's types; only the Anthropic provider loads it.
		// scripts/anthropic-sdk-imports.test.ts also catches dynamic imports.
		files: [
			'src/lib/server/**',
			'src/routes/**/+server.ts',
			'src/routes/**/+page.server.ts',
			'src/routes/**/+layout.server.ts',
			'src/hooks.server.ts'
		],
		ignores: [
			'src/lib/server/agent/provider/anthropic.ts',
			'src/lib/server/agent/provider/anthropic.test.ts',
			// Workout logging refuses the SDK, types included, with its own message (CORE_LOGGING).
			'src/routes/**/workout/**',
			'src/routes/api/workouts/**',
			'src/routes/api/exercises/**',
			'src/lib/server/services/workouts/**'
		],
		rules: {
			'@typescript-eslint/no-restricted-imports': ['error', { patterns: [LLM_SDK] }],
			'@typescript-eslint/no-import-type-side-effects': 'error'
		}
	},

	// ---- Core workout logging (M4) -----------------------------------------------------
	// The sync endpoint and the workout reads are core logging: they never reach the agent or an
	// LLM SDK, so logging works whatever the coach is doing (scripts/workout-boundaries.test.ts).
	// A later block's no-restricted-imports replaces an earlier one's patterns for the same files,
	// so each block repeats its folder's layer patterns before adding CORE_LOGGING.
	{
		files: ['src/routes/api/workouts/**', 'src/routes/api/exercises/**'],
		rules: restrict([LAYER.db, LAYER.driver, CORE_LOGGING])
	},
	{
		files: ['src/lib/server/services/workouts/**'],
		rules: restrict([LAYER.agent, LAYER.ui, LAYER.client, LAYER.framework, CORE_LOGGING])
	},
	// The workout screens and their client code never reach the coach either (M5).
	{
		files: ['src/routes/**/workout/**', 'src/routes/api/workouts/**'],
		rules: restrict([LAYER.db, LAYER.driver, CORE_LOGGING, COACH_MODULES])
	},
	{
		files: ['src/lib/client/workout/**'],
		rules: restrict([LAYER.server, LAYER.ui, COACH_MODULES])
	},
	{
		files: ['src/lib/ui/workout/**'],
		rules: restrict([LAYER.server, COACH_MODULES])
	},

	// ---- Backups (M9) ------------------------------------------------------------------
	// src/lib/server/backup seals and reads backup files from explicit inputs (the caller passes
	// the key text and the bytes). Operator scripts import it under plain Node, so it reads no
	// configuration and reaches no state (scripts/backup-layer.test.ts).
	{
		files: ['src/lib/server/backup/**'],
		rules: {
			...restrict([
				{
					regex: [
						...['db', 'services', 'agent', 'auth', 'forms'].map((name) => layer(`server/${name}`)),
						'(^#lib/server/env|lib/server/env|^(\\.\\./)+env)(\\.ts)?$',
						'^\\$env/',
						'^(pg|drizzle-orm)($|/)'
					].join('|'),
					message:
						'server/backup is a leaf: it may use the domain and Node built-ins, never db, services, agent, auth, forms, the env or a driver.'
				},
				LAYER.ui,
				LAYER.client,
				LAYER.framework
			]),
			'no-restricted-properties': [
				'error',
				{
					object: 'process',
					property: 'env',
					message: 'server/backup reads no configuration: the caller passes the key text.'
				}
			]
		}
	},

	// ---- Vercel Blob (M9) --------------------------------------------------------------
	// The private backup store is the only importer of @vercel/blob, so nothing else can upload
	// a backup publicly or with a token from the environment. It uses no-restricted-syntax, which
	// no other block sets, so it composes with every layer block above. Tests may import the SDK
	// for its error classes.
	{
		files: ['src/**', 'scripts/**'],
		ignores: ['src/lib/server/backup/blob-store.ts', '**/*.test.ts'],
		rules: {
			'no-restricted-syntax': [
				'error',
				...[
					'ImportDeclaration',
					'ImportExpression',
					'ExportAllDeclaration',
					'ExportNamedDeclaration'
				].map((node) => ({
					selector: `${node}[source.value=/^@vercel\\u002Fblob($|\\u002F)/]`,
					message:
						'Only src/lib/server/backup/blob-store.ts imports @vercel/blob: use vercelBlobStore.'
				}))
			]
		}
	}
);
