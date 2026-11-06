/**
 * Postgres refuses every UPDATE and DELETE of program history (ADR 0010). TRUNCATE fires no row
 * triggers, and a replication role or a disabled trigger would skip them too, so server code may
 * use none of these: the bypass belongs to test and reset code only (withCommitted, the e2e and
 * explain resets). Server code is src/lib/server/**, the server route files and the hooks.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const BYPASSES = [/\btruncate\b/i, /session_replication_role/i, /disable\s+trigger/i];

const SERVER_FILE =
	/^src\/(lib\/server\/.+|routes\/(.+\/)?\+(server|page\.server|layout\.server)\.ts|hooks(\.server|\.client)?\.ts)$/;

const serverFiles = readdirSync('src', { recursive: true, withFileTypes: true })
	.filter((entry) => entry.isFile())
	.map((entry) => `${entry.parentPath}/${entry.name}`.split('\\').join('/'))
	.filter((file) => SERVER_FILE.test(file));

const bypassIn = (text: string) => BYPASSES.find((pattern) => pattern.test(text));

describe('history guard bypasses', () => {
	it('finds the server code it scans', () => {
		expect(serverFiles).toEqual(
			expect.arrayContaining([
				'src/hooks.server.ts',
				'src/lib/server/db/schema/programs.ts',
				'src/routes/+page.server.ts'
			])
		);
		expect(serverFiles.some((file) => /\/\+server\.ts$/.test(file))).toBe(true);
		expect(serverFiles.some((file) => file.startsWith('src/lib/ui/'))).toBe(false);
	});

	it('recognises each bypass, in any case, and not words that merely contain one', () => {
		expect(bypassIn('await db.execute(sql`TRUNCATE programs CASCADE`)')).toBeDefined();
		expect(bypassIn("set session_replication_role = 'replica'")).toBeDefined();
		expect(bypassIn('alter table planned_sessions disable  trigger all')).toBeDefined();
		expect(bypassIn('const truncated = truncateTitle(title)')).toBeUndefined();
	});

	it('appears in no server file', () => {
		const offenders = serverFiles.filter((file) => bypassIn(readFileSync(file, 'utf8')));
		expect(offenders, 'only test and reset code may bypass the history guards').toEqual([]);
	});
});
