import { describe, expect, it } from 'vitest';
import { stylesFirst } from './head-order.ts';

/** The tags of a <head>, in order, as SvelteKit's render writes them (render.js `Head.build`). */
const page = (head: string[]) =>
	`<!doctype html>\n<html lang="en">\n\t<head>\n\t\t${head.join('\n\t\t')}\n\t</head>\n\t<body><div><style>.body{}</style><link href="/b.css" rel="stylesheet"></div></body>\n</html>`;
const tags = (html: string) =>
	[
		.../<head>([\s\S]*?)<\/head>/
			.exec(html)![1]!
			.matchAll(/<(style|link|meta|title|script)\b[^>]*>/g)
	].map(([tag]) => tag);

const META = '<meta charset="utf-8" />';
const THEME = '<script>var t;</script>';
const CSP = `<meta http-equiv="content-security-policy" content="style-src 'self' 'unsafe-inline'">`;
const FONT = '<link href="/f.woff2" rel="preload" as="font" type="font/woff2" crossorigin>';
const START = '<link href="/start.js" rel="modulepreload">';
const NODE = '<link href="/14.js" rel="modulepreload">';
const TITLE = '<title>Today · Performance Coach</title>';
const STYLE = '<style>.a{color:red}.b{color:blue}</style>';
const INLINED = '<link href="/0.css" rel="stylesheet" disabled media="(max-width: 0)">';
const LINKED = '<link href="/WeekStrip.css" rel="stylesheet">';

describe('stylesFirst', () => {
	it('moves the inlined styles and the loading stylesheets before the first preload hint', () => {
		const html = stylesFirst(page([META, THEME, FONT, START, NODE, TITLE, STYLE, INLINED, LINKED]));
		expect(tags(html)).toEqual([
			META,
			'<script>',
			'<style>',
			LINKED,
			FONT,
			START,
			NODE,
			'<title>',
			INLINED
		]);
		expect(html).toContain(STYLE);
	});

	it('keeps a prerendered page’s CSP <meta> in front of the styles it governs', () => {
		const html = stylesFirst(page([META, CSP, FONT, START, TITLE, STYLE, INLINED]));
		expect(tags(html)).toEqual([META, CSP, '<style>', FONT, START, '<title>', INLINED]);
	});

	it('keeps several stylesheets in their order', () => {
		const second = '<link href="/15.css" rel="stylesheet">';
		const html = stylesFirst(page([START, STYLE, LINKED, INLINED, second]));
		expect(tags(html)).toEqual(['<style>', LINKED, second, START, INLINED]);
	});

	it('leaves the body alone and moves no tag out of <head>', () => {
		const input = page([START, TITLE, STYLE, LINKED]);
		const html = stylesFirst(input);
		expect(html.slice(html.indexOf('<body>'))).toBe(input.slice(input.indexOf('<body>')));
		expect(html.length).toBe(input.length);
	});

	it('returns a page with no preload hint or no styles unchanged', () => {
		const noHints = page([META, TITLE, STYLE, LINKED]);
		expect(stylesFirst(noHints)).toBe(noHints);
		const noStyles = page([META, FONT, START, TITLE, INLINED]);
		expect(stylesFirst(noStyles)).toBe(noStyles);
	});
});
