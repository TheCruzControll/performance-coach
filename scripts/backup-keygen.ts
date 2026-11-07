/**
 * A new BACKUP_ENCRYPTION_KEY (M9): 32 random bytes in base64, and the key id every backup sealed
 * with it carries. Printed once and never written to a file: run it on a trusted machine, then put
 * the key into Vercel (Production, Sensitive) and the owner's password manager at the same moment.
 * Keep an old key for as long as backups sealed with it exist; the id tells them apart.
 *
 *   pnpm backup:keygen
 */
import { randomBytes } from 'node:crypto';
import { KEY_BYTES, parseBackupKey } from '../src/lib/server/backup/key.ts';
import { EXIT, isEntry, parseCommand, runCommand } from './backup/cli-support.ts';

const USAGE = `Usage: pnpm backup:keygen

Prints a fresh BACKUP_ENCRYPTION_KEY and its key id once; writes no file.`;

export async function main(argv: string[]): Promise<number> {
	if (!parseCommand(argv, { help: { type: 'boolean' } }, USAGE)) return EXIT.ok;
	const bytes = randomBytes(KEY_BYTES);
	const text = bytes.toString('base64');
	bytes.fill(0);
	// Parsed back as the app will read it, so a printed key is always one the app accepts.
	const key = parseBackupKey(text, 'the generated key');
	console.log(
		[
			`BACKUP_ENCRYPTION_KEY=${text}`,
			`Key id: ${key.id}`,
			'',
			'Save it in the password manager now, then set it in Vercel (Production, Sensitive).',
			'It is shown only once. Clear your terminal afterwards.'
		].join('\n')
	);
	return EXIT.ok;
}

if (isEntry(import.meta.url)) await runCommand(() => main(process.argv.slice(2)));
