/**
 * `node scripts/coach-screens-index.ts [screens-dir]`: the coach's contact sheet for the owner's
 * review before launch (M5 plan, coach-journeys). It reads the screenshots a Playwright run saved
 * (test-results/screens/<project>/<name>.png by default; CI uploads them as an artifact) and
 * writes <screens-dir>/coach-index.html: for each project that captured the coach, every screen of
 * e2e/coach-screens.ts in a row, at 393 × 659 and at 1440 × 900, dark and (where captured) light,
 * then every other coach-* capture of that project, so none of the serial projects' captures is
 * left out of the review. The design gallery's design-coach-* captures are not read: they come
 * from the iPhone and desktop projects, which take none of these screens.
 *
 * A screen with no capture at either viewport is listed as missing, on the sheet and on stderr,
 * and the command exits 1, so a run that skipped a state cannot pass for the full set.
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COACH_SCREENS, LIGHT, type CoachScreen } from '../e2e/coach-screens.ts';

/** Project → the names of its captures (no .png). */
export type Captures = ReadonlyMap<string, ReadonlySet<string>>;

/** A viewport's captures, as file paths relative to the screens directory, or null. */
export interface Shot {
	dark: string | null;
	light: string | null;
}

export interface IndexRow {
	screen: CoachScreen;
	phone: Shot;
	desktop: Shot;
}

export interface IndexPlan {
	projects: { project: string; rows: IndexRow[]; others: string[] }[];
	/** `<project>: <name>` for each capture a screen names and the project lacks. */
	missing: string[];
}

/** The coach's captures in `dir`, by project: only the projects that took one. */
export function readCaptures(dir: string): Map<string, Set<string>> {
	const captures = new Map<string, Set<string>>();
	if (!existsSync(dir)) return captures;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const names = readdirSync(path.join(dir, entry.name))
			.filter((file) => file.startsWith('coach-') && file.endsWith('.png'))
			.map((file) => file.slice(0, -'.png'.length));
		if (names.length > 0) captures.set(entry.name, new Set(names));
	}
	return captures;
}

/** Which capture fills each cell, which are missing, and what else each project captured. */
export function planIndex(
	captures: Captures,
	screens: readonly CoachScreen[] = COACH_SCREENS
): IndexPlan {
	const named = new Set(screens.flatMap((s) => [s.phone.name, s.desktop.name]));
	const missing: string[] = [];
	const projects = [...captures.keys()].sort().map((project) => {
		const names = captures.get(project)!;
		const shot = (name: string): Shot => {
			if (!names.has(name)) missing.push(`${project}: ${name}`);
			const file = (n: string) => (names.has(n) ? `${project}/${n}.png` : null);
			return { dark: file(name), light: file(`${name}${LIGHT}`) };
		};
		const rows = screens.map((screen) => ({
			screen,
			phone: shot(screen.phone.name),
			desktop: shot(screen.desktop.name)
		}));
		const others = [...names]
			.filter((n) => !named.has(n) && !(n.endsWith(LIGHT) && named.has(n.slice(0, -LIGHT.length))))
			.sort();
		return { project, rows, others };
	});
	return { projects, missing };
}

const escape = (text: string) =>
	text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function cell(file: string | null, caption: string): string {
	if (file === null)
		return `<figure class="none"><figcaption>${caption}: not captured</figcaption></figure>`;
	const src = escape(file);
	return `<figure><a href="${src}"><img src="${src}" alt="${caption}" loading="lazy"></a><figcaption>${caption}</figcaption></figure>`;
}

/** The contact sheet's HTML: one section per project, a row per screen, then the other captures. */
export function renderIndex(plan: IndexPlan): string {
	const sections = plan.projects.map(({ project, rows, others }) => {
		let group = '';
		const body = rows.map(({ screen, phone, desktop }) => {
			const heading = screen.group === group ? '' : `<h3>${escape((group = screen.group))}</h3>`;
			const cells = [
				cell(phone.dark, '393 × 659, dark'),
				phone.light && cell(phone.light, '393 × 659, light'),
				cell(desktop.dark, '1440 × 900, dark'),
				desktop.light && cell(desktop.light, '1440 × 900, light')
			].filter(Boolean);
			return `${heading}<section class="row" id="${escape(`${project}-${screen.id}`)}"><h4>${escape(screen.label)}</h4><div class="cells">${cells.join('')}</div></section>`;
		});
		const extra = others.map((n) => cell(`${project}/${n}.png`, escape(n))).join('');
		return `<h2>${escape(project)}</h2>${body.join('')}${extra && `<h3>Other coach captures</h3><div class="cells">${extra}</div>`}`;
	});
	const missing = plan.missing.length
		? `<p class="missing">Missing (${plan.missing.length}): ${plan.missing.map(escape).join(', ')}</p>`
		: '<p>Every screen is captured at both viewports.</p>';
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Coach screens</title><style>
body{font:14px/1.4 system-ui,sans-serif;margin:24px;background:#111;color:#eee}
a{color:inherit}.cells{display:flex;gap:16px;align-items:flex-start;overflow-x:auto}
figure{margin:0}img{height:360px;border:1px solid #444;display:block}
figcaption{color:#aaa;font-size:12px;margin-top:4px}.none{width:200px;height:120px;border:1px dashed #a55;padding:8px}
.missing{color:#f88}h4{margin:20px 0 8px}
</style></head><body><h1>Coach screens for review</h1>${missing}${sections.join('')}</body></html>
`;
}

function main(dir: string): number {
	const plan = planIndex(readCaptures(dir));
	if (plan.projects.length === 0) {
		console.error(`No coach captures under ${dir}: run the coach specs first.`);
		return 1;
	}
	const out = path.join(dir, 'coach-index.html');
	writeFileSync(out, renderIndex(plan));
	const projects = plan.projects.map((p) => p.project).join(', ');
	console.log(`${out}: ${COACH_SCREENS.length} screens for ${projects}`);
	for (const line of plan.missing) console.error(`missing ${line}`);
	return plan.missing.length > 0 ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = main(process.argv[2] ?? 'test-results/screens');
}
