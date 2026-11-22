/**
 * One verb for trying a failed thing again, everywhere: 'Try again' (PRODUCT.md's plain words).
 * A button, a toast action or a card that says 'Retry' on one screen and 'Try again' on the next
 * reads as two different things. Comments may still say Retry; what the owner sees may not.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));

const sources = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) return sources(file);
		return /\.(ts|svelte)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [file] : [];
	});

/** A visible label: element text ('>Retry<' or 'Retry' alone on its line) or a quoted string. */
const LABEL = /(>\s*Retry\s*<)|(^\s*Retry\s*$)|(['"`]Retry['"`])/;
const COMMENT = /^\s*(\*|\/\/|\/\*|<!--)/;

/** Every line of src/ that shows the owner 'Retry', as 'file:line'. */
function retryLabels(): string[] {
	return sources(path.join(root, 'src')).flatMap((file) =>
		readFileSync(file, 'utf8')
			.split('\n')
			.flatMap((line, i) =>
				!COMMENT.test(line) && LABEL.test(line) ? [`${path.relative(root, file)}:${i + 1}`] : []
			)
	);
}

describe('the verb for trying again', () => {
	it('is "Try again" on every screen, never "Retry"', () => {
		expect(retryLabels()).toEqual([]);
	});

	it('finds each way a label could say Retry', () => {
		expect(LABEL.test('<Button onclick={retry}>Retry</Button>')).toBe(true);
		expect(LABEL.test('\t\t\t\t\t\tRetry')).toBe(true);
		expect(LABEL.test("action: { label: 'Retry', onclick: show }")).toBe(true);
		expect(LABEL.test("{failed ? 'Retry' : 'Unarchive'}")).toBe(true);
		expect(LABEL.test('<Button onclick={retry}>Try again</Button>')).toBe(false);
		expect(LABEL.test('Retrying in 3 s')).toBe(false);
	});
});
