/**
 * The screen gallery's contact sheet (.github/workflows/screen-gallery.yml).
 *
 * e2e/gallery.gallery.ts captures every main screen and state on each device in both themes and
 * appends one record per shot to `results-<device>.jsonl` beside the PNGs: captured, failed (with
 * why) or skipped (with why, e.g. an engine that cannot emulate it). A shot that fails never
 * fails the run, so the sheet is where a failure shows.
 *
 * `node scripts/gallery-index.ts <dir>` reads every `results-*.jsonl` in <dir> and writes
 * <dir>/index.html: one row per screen and state, one column per device and theme, each cell the
 * PNG (linked full size) or what kept it out. Node builtins only.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GALLERY_DEVICES = ['iphone', 'desktop'] as const;
export const GALLERY_THEMES = ['dark', 'light'] as const;
export type GalleryDevice = (typeof GALLERY_DEVICES)[number];
export type GalleryTheme = (typeof GALLERY_THEMES)[number];

export interface ShotKey {
	/** The screen, e.g. `progress`. */
	screen: string;
	/** Its state, e.g. `strength`. */
	state: string;
	device: GalleryDevice;
	theme: GalleryTheme;
}

export interface ShotRecord extends ShotKey {
	status: 'captured' | 'failed' | 'skipped';
	/** The PNG's file name, when captured. */
	file?: string;
	/** Why it failed or was skipped. */
	reason?: string;
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** `<screen>--<state>--<device>--<theme>.png`: screen and state are lower-case kebab slugs. */
export function shotFileName({ screen, state, device, theme }: ShotKey): string {
	for (const [name, value] of [
		['screen', screen],
		['state', state]
	] as const) {
		if (!SLUG.test(value)) throw new Error(`gallery ${name} '${value}': use a kebab-case slug`);
	}
	return `${screen}--${state}--${device}--${theme}.png`;
}

const escape = (text: string) =>
	text.replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
	);

const COLUMNS = GALLERY_DEVICES.flatMap((device) =>
	GALLERY_THEMES.map((theme) => ({ device, theme }))
);

function cell(record: ShotRecord | undefined): string {
	if (!record) return '<td class="missing">not run</td>';
	if (record.status === 'captured' && record.file) {
		const src = encodeURI(record.file);
		return `<td class="captured"><a href="${src}"><img src="${src}" alt="${escape(record.file)}" loading="lazy"></a></td>`;
	}
	const label = record.status === 'skipped' ? 'skipped' : 'failed';
	return `<td class="${label}"><strong>${label}</strong><p>${escape(record.reason ?? '')}</p></td>`;
}

/**
 * The contact sheet for `records`, rows in the order their screen and state first appear. A shot
 * recorded twice keeps its last record (a later attempt replaces an earlier one).
 */
export function renderIndex(records: readonly ShotRecord[], title = 'Screen gallery'): string {
	const rows = new Map<string, Map<string, ShotRecord>>();
	for (const record of records) {
		const row = `${record.screen}--${record.state}`;
		if (!rows.has(row)) rows.set(row, new Map());
		rows.get(row)!.set(`${record.device}--${record.theme}`, record);
	}
	const latest = [...rows.values()].flatMap((row) => [...row.values()]);
	const count = (status: ShotRecord['status']) => latest.filter((r) => r.status === status).length;
	const head = COLUMNS.map(({ device, theme }) => `<th>${device} · ${theme}</th>`).join('');
	const body = [...rows]
		.map(([row, shots]) => {
			const cells = COLUMNS.map(({ device, theme }) => cell(shots.get(`${device}--${theme}`)));
			return `<tr><th scope="row">${escape(row)}</th>${cells.join('')}</tr>`;
		})
		.join('\n');
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
body { font: 14px/1.4 system-ui, sans-serif; margin: 24px; background: #111; color: #eee; }
table { border-collapse: collapse; }
th, td { border: 1px solid #333; padding: 8px; vertical-align: top; text-align: left; }
thead th { position: sticky; top: 0; background: #111; }
img { display: block; width: 240px; height: auto; }
td.failed { background: #3a1414; width: 240px; }
td.skipped, td.missing { background: #222; color: #aaa; width: 240px; }
p { margin: 4px 0 0; white-space: pre-wrap; word-break: break-word; }
</style>
</head>
<body>
<h1>${escape(title)}</h1>
<p class="summary">${count('captured')} captured · ${count('failed')} failed · ${count('skipped')} skipped</p>
<table>
<thead><tr><th>screen--state</th>${head}</tr></thead>
<tbody>
${body}
</tbody>
</table>
</body>
</html>
`;
}

/** Every record in `dir`'s `results-*.jsonl` files, in file order. */
export function readRecords(dir: string): ShotRecord[] {
	return readdirSync(dir)
		.filter((file) => /^results-.*\.jsonl$/.test(file))
		.sort()
		.flatMap((file) =>
			readFileSync(path.join(dir, file), 'utf8')
				.split('\n')
				.filter((line) => line.trim())
				.map((line) => JSON.parse(line) as ShotRecord)
		);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const dir = process.argv[2];
	if (!dir) {
		console.error('usage: node scripts/gallery-index.ts <dir>');
		process.exit(2);
	}
	const records = readRecords(dir);
	writeFileSync(path.join(dir, 'index.html'), renderIndex(records));
	const failed = records.filter((r) => r.status === 'failed').length;
	console.log(`[gallery] ${records.length} shots indexed, ${failed} failed: ${dir}/index.html`);
}
