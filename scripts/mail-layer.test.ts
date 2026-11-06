/**
 * src/lib/server/mail is a leaf (eslint.config.js, docs/architecture.md): it is built from
 * explicit options and may use the logger, so it can neither reach state nor read its own
 * configuration. That keeps the choice of provider in one place (auth/email-link-config.ts), where
 * a test server always gets the recording mailer. Each case lints a snippet with ESLint's Node API
 * against the repository's real config, exactly as `pnpm lint` would see it at that path.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const eslint = new ESLint({ cwd: root });

const FILE = 'src/lib/server/mail/resend.ts';
const IMPORTS = 'no-restricted-imports';
const PROPERTIES = 'no-restricted-properties';
const TIMEOUT = 60_000;

interface Finding {
	rule: string | null;
	message: string;
}

/** What ESLint reports for `code` at `file`; a file it could not parse fails the test. */
async function lint(code: string, file = FILE): Promise<Finding[]> {
	const [result] = await eslint.lintText(code, { filePath: path.join(root, file) });
	const fatal = result!.messages.find((m) => m.fatal);
	if (fatal) throw new Error(`${file}: ${fatal.message}`);
	return result!.messages.map((m) => ({ rule: m.ruleId, message: m.message }));
}

const importing = (specifier: string) =>
	`import * as dependency from '${specifier}';\nexport const used = dependency;\n`;

/** Each specifier the mail layer must not import, and the message that names the reason. */
const FORBIDDEN: [specifier: string, message: RegExp][] = [
	['#lib/server/db/index.ts', /Mail is a leaf/],
	['../db/index.ts', /Mail is a leaf/],
	['$lib/server/db/schema/auth.ts', /Mail is a leaf/],
	['#lib/server/services/index.ts', /Mail is a leaf/],
	['../agent/index.ts', /Mail is a leaf/],
	['#lib/server/auth/index.ts', /Mail is a leaf/],
	['../auth/email-link-config.ts', /Mail is a leaf/],
	['../forms/read.ts', /Mail is a leaf/],
	['#lib/server/env.ts', /Mail is a leaf/],
	['../env', /Mail is a leaf/],
	['$env/dynamic/private', /Mail is a leaf/],
	['$env/static/private', /Mail is a leaf/],
	['pg', /Mail is a leaf/],
	['drizzle-orm', /Mail is a leaf/],
	['$app/environment', /framework-agnostic/],
	['@sveltejs/kit', /framework-agnostic/],
	['svelte', /framework-agnostic/],
	['#lib/ui/components/Badge.svelte', /must not depend on UI/],
	['#lib/client/program.ts', /browser-only client code/]
];

describe('the mail layer imports', () => {
	for (const [specifier, message] of FORBIDDEN) {
		it(
			`refuses ${specifier}`,
			async () => {
				const findings = await lint(importing(specifier));
				expect(findings.map((f) => f.rule)).toEqual([IMPORTS]);
				expect(findings[0]!.message).toMatch(message);
			},
			TIMEOUT
		);
	}

	it(
		'allows the logger, by relative path and by alias, and its own files',
		async () => {
			const code = [
				"import { logger } from '../observability/logger';",
				"import { serializeError } from '#lib/server/observability/logger.ts';",
				"import { randomUUID } from 'node:crypto';",
				"import { MailError } from './types';",
				'export const used = [logger, serializeError, randomUUID, MailError];',
				''
			].join('\n');
			expect(await lint(code)).toEqual([]);
			expect(await lint(code, 'src/lib/server/mail/test-outbox.ts')).toEqual([]);
		},
		TIMEOUT
	);
});

describe('the mail layer reads no configuration', () => {
	it(
		'refuses process.env, read directly or destructured',
		async () => {
			for (const code of [
				'export const key = process.env.RESEND_API_KEY;\n',
				'const { env } = process;\nexport const key = env.RESEND_API_KEY;\n'
			]) {
				const findings = await lint(code);
				expect(
					findings.map((f) => f.rule),
					code
				).toEqual([PROPERTIES]);
				expect(findings[0]!.message).toMatch(/explicit options/);
			}
		},
		TIMEOUT
	);
});

describe('the rule is the mail layer’s own', () => {
	it(
		'auth, which builds the mailer from its configuration, may import it and read the env',
		async () => {
			const code = [
				"import { createMailer } from '../mail/index.ts';",
				"import { getEnv } from '../env';",
				'export const used = [createMailer, getEnv, process.env.OWNER_EMAIL];',
				''
			].join('\n');
			expect(await lint(code, 'src/lib/server/auth/email-link.ts')).toEqual([]);
		},
		TIMEOUT
	);
});
