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
	}
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
		files: ['src/lib/server/observability/**'],
		rules: restrict([LAYER.observabilityDeps, LAYER.ui, LAYER.client, LAYER.framework])
	},
	{
		files: ['src/routes/**', 'src/hooks.server.ts', 'src/hooks.client.ts'],
		rules: restrict([LAYER.db, LAYER.driver])
	}
);
