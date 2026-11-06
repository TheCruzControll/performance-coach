/**
 * The owner's mail address lives only in Vercel (OWNER_EMAIL, ADR 0011): never in the repository,
 * where every clone, fork and log would keep it. This guard fails if any tracked text file holds
 * an address at a personal mail provider. Fixtures and examples use `example.test`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const PERSONAL_PROVIDERS = [
	'gmail.com',
	'googlemail.com',
	'icloud.com',
	'me.com',
	'outlook.com',
	'hotmail.com',
	'yahoo.com',
	'proton.me'
];

const escaped = PERSONAL_PROVIDERS.map((domain) => domain.replaceAll('.', '\\.')).join('|');
/** A local part, `@` (or its URL encoding) and one of the providers, ending at the domain. */
const PERSONAL_ADDRESS = new RegExp(
	`[\\w.%+-]+(?:@|%40)(?:${escaped})(?![\\w-]|\\.[a-z0-9])`,
	'giu'
);

const personalAddressesIn = (text: string): string[] => text.match(PERSONAL_ADDRESS) ?? [];

/** Built at run time, so this file holds no address of its own. */
const addressAt = (domain: string, local = 'someone') => `${local}@${domain}`;

const trackedFiles = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
	.split('\0')
	.filter(Boolean);

function textOf(file: string): string | undefined {
	let bytes: Buffer;
	try {
		bytes = readFileSync(file);
	} catch {
		return undefined; // deleted in the working tree, or a submodule or symlinked directory
	}
	// Binary files (images, fonts) hold a NUL byte early on; they are not scanned.
	return bytes.subarray(0, 8000).includes(0) ? undefined : bytes.toString('utf8');
}

describe('no personal mail address in the repository', () => {
	it('scans every tracked file', () => {
		expect(trackedFiles.length).toBeGreaterThan(100);
		expect(trackedFiles).toEqual(
			expect.arrayContaining(['.env.example', 'docs/environment.md', 'package.json'])
		);
	});

	it('recognises an address at each personal provider, in any case', () => {
		// Written out again, so dropping a provider from the guard fails here.
		for (const domain of [
			'gmail.com',
			'googlemail.com',
			'icloud.com',
			'me.com',
			'outlook.com',
			'hotmail.com',
			'yahoo.com',
			'proton.me'
		]) {
			expect(personalAddressesIn(`OWNER_EMAIL=${addressAt(domain)}`), domain).toEqual([
				addressAt(domain)
			]);
			expect(personalAddressesIn(`<${addressAt(domain.toUpperCase(), 'First.Last+tag')}>`)).toEqual(
				[addressAt(domain.toUpperCase(), 'First.Last+tag')]
			);
			expect(personalAddressesIn(`mailto:someone%40${domain}`), `${domain} url-encoded`).toEqual([
				`someone%40${domain}`
			]);
		}
	});

	it('leaves other addresses, look-alike domains and bare provider names alone', () => {
		for (const text of [
			'OWNER_EMAIL=owner@example.test',
			'Performance Coach <onboarding@resend.dev>',
			addressAt('home.com'),
			addressAt('gmail.community'),
			addressAt('me.co'),
			'set it to the owner’s Gmail in Vercel (outlook.com and proton.me work too)'
		]) {
			expect(personalAddressesIn(text), text).toEqual([]);
		}
		expect(personalAddressesIn(addressAt('gmail.com.example.test'))).toEqual([]);
	});

	it('appears in no tracked text file', () => {
		const offenders = trackedFiles.filter((file) => {
			const text = textOf(file);
			return text !== undefined && personalAddressesIn(text).length > 0;
		});
		expect(offenders, 'use an example.test address; the real one belongs in Vercel').toEqual([]);
	});
});
