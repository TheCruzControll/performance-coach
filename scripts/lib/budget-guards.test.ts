import { describe, expect, it } from 'vitest';
import {
	carriesChartBody,
	chartBodyProblems,
	viewCssProblems,
	type RouteAssets,
	type RouteViews
} from './budget-guards.ts';

/**
 * A scratch client build: what each file holds. LineChart's chunk and marks.css carry the reserved
 * class, as the real bodies do; the rest is app code and a stylesheet without it.
 */
const FILES: Record<string, string> = {
	'_app/immutable/entry/app.js': 'import"./chunks/shell.js";',
	'_app/immutable/chunks/shell.js': 'const a=1;',
	'_app/immutable/chunks/StrengthView.js': 'b(`<div class="pc-strength-view svelte-x">`);',
	'_app/immutable/chunks/LineChart.js': 'b(`<div class="pc-chart-body line svelte-y">`);',
	'_app/immutable/assets/boot.css': '.pc-shell{display:grid}',
	'_app/immutable/assets/marks.css': '.pc-chart-body .pc-area{position:relative}',
	'_app/immutable/assets/StrengthView.css': '.pc-strength-view.svelte-x{gap:8px}'
};
const read = (file: string) => FILES[file] ?? '';
const ALL = Object.keys(FILES);

/** /progress as it should build: its view awaited by the load, the body lazy. */
const CLEAN: RouteAssets = {
	route: '/(app)/progress',
	js: [
		'_app/immutable/entry/app.js',
		'_app/immutable/chunks/shell.js',
		'_app/immutable/chunks/StrengthView.js'
	],
	css: ['_app/immutable/assets/boot.css', '_app/immutable/assets/StrengthView.css']
};

describe('chartBodyProblems', () => {
	it('passes a route whose bodies load after hydration', () => {
		expect(chartBodyProblems([CLEAN], ALL, read)).toEqual([]);
	});

	it('fails a scratch route that imports a chart body statically (its JS)', () => {
		const route = { ...CLEAN, js: [...CLEAN.js, '_app/immutable/chunks/LineChart.js'] };
		expect(chartBodyProblems([route], ALL, read)).toEqual([
			'/(app)/progress: LineChart.js (initial JS) carries a chart body'
		]);
	});

	it('fails a route that links marks.css, as a body imported without the SSR guard makes it', () => {
		const route = { ...CLEAN, css: [...CLEAN.css, '_app/immutable/assets/marks.css'] };
		expect(chartBodyProblems([route], ALL, read)).toEqual([
			'/(app)/progress: marks.css (route CSS) carries a chart body'
		]);
	});

	it('fails blind: a build in which no file carries the class', () => {
		expect(chartBodyProblems([CLEAN], ['_app/immutable/chunks/shell.js'], read)).toEqual([
			'no client file carries pc-chart-body: the chart bodies or marks.css changed, update CHART_BODY_CLASS'
		]);
	});

	it('reads the class as a whole word', () => {
		expect(carriesChartBody('class="pc-chart-body line"')).toBe(true);
		expect(carriesChartBody('.pc-chart-body .pc-area{}')).toBe(true);
		expect(carriesChartBody('class="pc-chart-body-frame"')).toBe(false);
		expect(carriesChartBody('class="xpc-chart-body"')).toBe(false);
	});
});

describe('viewCssProblems', () => {
	const VIEW = '_app/immutable/chunks/StrengthView.js';
	const SHEET = '_app/immutable/assets/StrengthView.css';
	const progress = (counted: string[]): RouteViews => ({
		route: '/(app)/progress',
		counted: new Set(counted),
		views: [{ view: VIEW, css: [SHEET] }]
	});

	it("passes when every view's CSS is in the route's count", () => {
		expect(viewCssProblems([progress(['_app/immutable/assets/boot.css', SHEET])])).toEqual({
			problems: [],
			counted: 1
		});
	});

	it("fails a load-imported view whose CSS the route's count misses", () => {
		expect(viewCssProblems([progress(['_app/immutable/assets/boot.css'])])).toEqual({
			problems: [
				'/(app)/progress: StrengthView.css of StrengthView.js (awaited by its load) is not in its CSS count'
			],
			counted: 0
		});
	});

	it('fails blind: no view a load awaits brings CSS', () => {
		const bare: RouteViews = { ...progress([]), views: [{ view: VIEW, css: [] }] };
		expect(viewCssProblems([bare]).problems).toEqual([
			'no view a load awaits brings CSS: update this guard'
		]);
	});
});
