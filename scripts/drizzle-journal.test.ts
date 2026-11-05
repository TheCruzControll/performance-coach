/**
 * Drizzle applies only migrations newer than the newest one already recorded in a database
 * (`created_at < when`), so a migration whose timestamp is older than its predecessor's would be
 * skipped silently on any database that already ran the predecessor. Keep the journal strictly
 * ordered: by index, and in time.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const journal = JSON.parse(
	readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8')
) as {
	entries: { idx: number; when: number; tag: string }[];
};

describe('drizzle migration journal', () => {
	it('is strictly increasing by index and timestamp', () => {
		journal.entries.forEach((entry, i) => {
			expect(entry.idx, entry.tag).toBe(i);
			if (i > 0) {
				const previous = journal.entries[i - 1]!;
				expect(entry.when, `${entry.tag} must be newer than ${previous.tag}`).toBeGreaterThan(
					previous.when
				);
			}
		});
	});

	it('names every migration after its index', () => {
		for (const entry of journal.entries) {
			expect(entry.tag.startsWith(String(entry.idx).padStart(4, '0') + '_'), entry.tag).toBe(true);
		}
	});
});
