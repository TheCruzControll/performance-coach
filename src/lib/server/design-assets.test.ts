import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GRAPHITE_ASSETS, withDesignAssets } from './design-assets.ts';

const TEMPLATE = readFileSync(new URL('../../app.html', import.meta.url), 'utf8');
const ASSETS = {
	stylesheet: '/_app/immutable/assets/graphite.D4x_9a-c.css',
	font: '/_app/immutable/assets/source-sans-3-latin-wght-normal.Bq3-x1.woff2'
};

describe('withDesignAssets', () => {
	it('fills the template’s <meta> with the URLs the head script fetches for Graphite', () => {
		const html = withDesignAssets(TEMPLATE, ASSETS);
		expect(html).toContain(
			`<meta name="pc-graphite" content="${ASSETS.stylesheet}" data-font="${ASSETS.font}" />`
		);
		expect(html).not.toContain('%pc.graphite');
	});

	it('changes nothing else, so the head script and its CSP hash stay as they are', () => {
		const html = withDesignAssets(TEMPLATE, ASSETS);
		const script = (page: string) => /<script>([\s\S]*?)<\/script>/.exec(page)![1];
		expect(script(html)).toBe(script(TEMPLATE));
		expect(
			html
				.replace(ASSETS.stylesheet, '%pc.graphite.stylesheet%')
				.replace(ASSETS.font, '%pc.graphite.font%')
		).toBe(TEMPLATE);
	});

	it('leaves a chunk without the placeholders untouched (the streamed rest of a page)', () => {
		const chunk = '<div>streamed</div><script>__sveltekit.resolve()</script>';
		expect(withDesignAssets(chunk, ASSETS)).toBe(chunk);
	});

	// The stylesheet's import is checked in src/lib/ui/styles/graphite.test.ts (Vitest leaves a
	// CSS URL empty).
	it('preloads the Source Sans 3 latin face that graphite.css declares', () => {
		expect(GRAPHITE_ASSETS.font).toMatch(/source-sans-3-latin-wght-normal\.woff2/);
	});
});
