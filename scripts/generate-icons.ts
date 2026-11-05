/**
 * Render the PWA / iOS icons from the SVG sources in static/icons using the Playwright
 * Chromium build (no native image dependencies).
 *
 *   pnpm icons
 */
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const OUT = 'static/icons';
const targets = [
	{ src: 'icon.svg', out: 'icon-192.png', size: 192 },
	{ src: 'icon.svg', out: 'icon-512.png', size: 512 },
	{ src: 'icon.svg', out: 'apple-touch-icon.png', size: 180 },
	{ src: 'icon-maskable.svg', out: 'icon-maskable-512.png', size: 512 }
];

const browser = await chromium.launch();
try {
	const page = await browser.newPage({ deviceScaleFactor: 1 });
	for (const { src, out, size } of targets) {
		const svg = readFileSync(`${OUT}/${src}`, 'utf8');
		await page.setViewportSize({ width: size, height: size });
		await page.setContent(
			`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`
		);
		await page.screenshot({ path: `${OUT}/${out}`, omitBackground: false });
		console.log(`icons: wrote ${OUT}/${out} (${size}×${size})`);
	}
} finally {
	await browser.close();
}
