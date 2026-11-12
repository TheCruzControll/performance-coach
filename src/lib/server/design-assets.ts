/**
 * The Graphite 2004 preview's assets, written into every page for the pre-paint script in
 * src/app.html, which fetches them only on a device that chose that design (src/lib/client/design.ts).
 *
 * Both are build assets with hashed names that only the build knows, so the template carries
 * placeholders in a <meta> and the server fills them in; the script itself never changes, so its
 * CSP hash (vite.config.ts) holds. The stylesheet is imported as a URL, never as CSS, so it is in
 * no route's CSS and today's design ships none of it.
 */
import stylesheet from '#lib/ui/styles/graphite.css?url';
import font from '@fontsource-variable/source-sans-3/files/source-sans-3-latin-wght-normal.woff2?url';

export interface DesignAssets {
	stylesheet: string;
	font: string;
}

export const GRAPHITE_ASSETS: DesignAssets = { stylesheet, font };

const PLACEHOLDERS = {
	stylesheet: '%pc.graphite.stylesheet%',
	font: '%pc.graphite.font%'
} as const;

/** `html` (a whole page or a chunk of one) with the template's design placeholders filled in. */
export function withDesignAssets(html: string, assets: DesignAssets = GRAPHITE_ASSETS): string {
	return html
		.replace(PLACEHOLDERS.stylesheet, assets.stylesheet)
		.replace(PLACEHOLDERS.font, assets.font);
}
