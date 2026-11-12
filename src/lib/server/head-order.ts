/**
 * Puts a page's styles first among the tags SvelteKit writes into <head>.
 *
 * SvelteKit writes its preload hints (the font preload, then every modulepreload) first, then
 * the page's <svelte:head>, then the inlined <style> and the stylesheet links. The styles are
 * what first paint waits for; the hints are not. This moves the <style> blocks and the
 * stylesheet links that load (not the disabled placeholders SvelteKit adds for inlined sheets)
 * to just before the first preload hint, in their order. Everything before that hint stays in
 * front of them: the template's tags and, on a prerendered page, the CSP <meta>, which governs
 * only what follows it.
 */
const HEAD = /<head>[\s\S]*?<\/head>/;
const LINK = /<link\b[^>]*>/g;
const HINT = /\brel="(modulepreload|preload)"/;
const STYLE_OR_LINK = /\s*(<style\b[^>]*>[\s\S]*?<\/style>|<link\b[^>]*>)/g;
const LOADING_STYLESHEET = (tag: string) =>
	tag.startsWith('<style') || (/\brel="stylesheet"/.test(tag) && !/\sdisabled\b/.test(tag));

export function stylesFirst(html: string): string {
	return html.replace(HEAD, (head) => {
		const hint = [...head.matchAll(LINK)].find(([tag]) => HINT.test(tag))?.index;
		if (hint === undefined) return head;
		const moved: string[] = [];
		const rest = head.slice(hint).replace(STYLE_OR_LINK, (all, tag: string) => {
			if (!LOADING_STYLESHEET(tag)) return all;
			moved.push(tag);
			return '';
		});
		if (!moved.length) return head;
		return `${head.slice(0, hint)}${moved.join('\n\t\t')}\n\t\t${rest}`;
	});
}
