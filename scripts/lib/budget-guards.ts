/**
 * Two of pnpm budgets' guards (scripts/check-budgets.ts), as pure functions over what the build
 * gives each route, so their negative fixtures run as unit tests (budget-guards.test.ts) and not
 * only on a scratch build.
 *
 * - Chart bodies: a chart body (src/lib/ui/charts/bodies/) draws after hydration, so its code is
 *   never in a route's initial JS (static, or awaited by a universal load) and its CSS never in a
 *   stylesheet a route renders with, where it would block the first paint. Every body's root and
 *   every marks.css rule carries the reserved class CHART_BODY_CLASS, which nothing else may use,
 *   so a file that carries it is a body's. In CSS the signal is marks.css, which every body
 *   imports: a body's own scoped styles do not carry the class. This is
 *   the bundle-level backstop to scripts/chart-body-imports.test.ts, which checks the imports.
 * - Load-imported views: a view a universal load awaits (/progress and the reviews' VIEWS maps)
 *   is server-rendered, so SvelteKit links its CSS into the page; the route's CSS count is those
 *   links. A view whose CSS is missing from the count would ship CSS no budget sees, so the
 *   guard fails on it.
 *
 * Each guard also fails when it would pass blind: no file carries the class, or no view brings
 * CSS, means the build changed under the guard, not that every route is clean.
 */
import path from 'node:path';

/** The class only chart bodies and marks.css use (src/lib/ui/charts/marks.css). */
export const CHART_BODY_CLASS = 'pc-chart-body';

/** The class as a whole word: `pc-chart-body-x` or `xpc-chart-body` are other classes. */
const CLASS_WORD = new RegExp(`(?<![\\w-])${CHART_BODY_CLASS}(?![\\w-])`);

export const carriesChartBody = (text: string) => CLASS_WORD.test(text);

/** What a route loads before it is interactive, as file paths in the client build. */
export interface RouteAssets {
	route: string;
	/** Initial JS: the static closure of the entry and its nodes, and of what its loads await. */
	js: Iterable<string>;
	/** The stylesheets the route renders with (linked or inlined). */
	css: Iterable<string>;
}

/**
 * Each route whose initial JS or render-blocking CSS carries a chart body, and a problem when no
 * file of `clientFiles` (every .js and .css the browser can fetch) carries one at all.
 */
export function chartBodyProblems(
	routes: readonly RouteAssets[],
	clientFiles: readonly string[],
	read: (file: string) => string
): string[] {
	const carries = (file: string) => carriesChartBody(read(file));
	const problems: string[] = [];
	if (!clientFiles.some(carries)) {
		problems.push(
			`no client file carries ${CHART_BODY_CLASS}: the chart bodies or marks.css changed, update CHART_BODY_CLASS`
		);
	}
	for (const { route, js, css } of routes) {
		for (const file of [...js].filter(carries)) {
			problems.push(`${route}: ${path.basename(file)} (initial JS) carries a chart body`);
		}
		for (const file of [...css].filter(carries)) {
			problems.push(`${route}: ${path.basename(file)} (route CSS) carries a chart body`);
		}
	}
	return problems;
}

/** A route's CSS count and the views its loads await, each with the CSS of its static closure. */
export interface RouteViews {
	route: string;
	/** The stylesheets the route's CSS budget counts. */
	counted: ReadonlySet<string>;
	views: readonly { view: string; css: readonly string[] }[];
}

/**
 * Each load-imported view's stylesheet the route's CSS count misses, and a problem when no view
 * brings CSS at all. `counted` is the number of view stylesheets the guard found counted.
 */
export function viewCssProblems(routes: readonly RouteViews[]): {
	problems: string[];
	counted: number;
} {
	const problems: string[] = [];
	let counted = 0;
	for (const { route, counted: css, views } of routes) {
		for (const { view, css: sheets } of views) {
			for (const sheet of sheets) {
				if (css.has(sheet)) counted++;
				else {
					problems.push(
						`${route}: ${path.basename(sheet)} of ${path.basename(view)} (awaited by its load) is not in its CSS count`
					);
				}
			}
		}
	}
	if (!routes.some((r) => r.views.some((v) => v.css.length))) {
		problems.push('no view a load awaits brings CSS: update this guard');
	}
	return { problems, counted };
}
