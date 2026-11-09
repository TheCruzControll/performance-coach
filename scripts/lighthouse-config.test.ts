/**
 * The form factors scripts/lighthouse.ts audits with: desktop is Lighthouse's desktop preset on
 * the 1440 × 900 window the desktop layout is verified at, and mobile is exactly what CI has
 * always asserted (Lighthouse's defaults).
 */
import { describe, expect, it } from 'vitest';
import { lighthouseConfig, reportDir } from './lib/lighthouse-config.ts';

describe('lighthouseConfig', () => {
	it("'desktop' is the desktop form factor on a 1440 × 900 screen at 1x", () => {
		const settings = lighthouseConfig('desktop')?.settings;
		expect(lighthouseConfig('desktop')?.extends).toBe('lighthouse:default');
		expect(settings?.formFactor).toBe('desktop');
		expect(settings?.screenEmulation).toEqual({
			mobile: false,
			width: 1440,
			height: 900,
			deviceScaleFactor: 1,
			disabled: false
		});
		expect(settings?.emulatedUserAgent).toMatch(/Macintosh/);
		expect(settings?.emulatedUserAgent).not.toMatch(/Mobile/);
	});

	it("'desktop' uses Lighthouse's desktop throttling: dense 4G, no CPU slowdown", () => {
		expect(lighthouseConfig('desktop')?.settings?.throttling).toMatchObject({
			rttMs: 40,
			throughputKbps: 10_240,
			cpuSlowdownMultiplier: 1
		});
	});

	it("'mobile' passes no config, so Lighthouse runs its defaults exactly as before", () => {
		expect(lighthouseConfig('mobile')).toBeUndefined();
	});

	it('keeps desktop reports apart from the mobile reports CI uploads', () => {
		expect(reportDir('mobile')).toBe('lighthouse-reports');
		expect(reportDir('desktop')).toBe('lighthouse-reports/desktop');
	});
});
