/**
 * The Lighthouse settings scripts/lighthouse.ts audits with, per form factor (pure).
 *
 * - 'mobile' is Lighthouse's default config, unchanged: a Moto G Power screen, simulated slow 4G
 *   and a 4× CPU slowdown. CI asserts it on every PR.
 * - 'desktop' is Lighthouse's own desktop preset (its throttling and user agent) on the screen
 *   the desktop layout is designed and e2e-tested at: 1440 × 900 at 1x (docs/design-system.md),
 *   where the preset's 1350 × 940 would sit between the layout's breakpoints.
 */
import { desktopConfig, type Config } from 'lighthouse';

export type FormFactor = 'mobile' | 'desktop';

/** The desktop viewport the app's desktop layout is verified at (e2e/desktop.ts). */
export const DESKTOP_SCREEN = {
	mobile: false,
	width: 1440,
	height: 900,
	deviceScaleFactor: 1,
	disabled: false
} as const;

/**
 * The config passed to `lighthouse()`. `undefined` for 'mobile': Lighthouse then uses its
 * default config, exactly what every mobile run before --desktop measured.
 */
export function lighthouseConfig(formFactor: FormFactor): Config | undefined {
	if (formFactor === 'mobile') return undefined;
	return {
		...desktopConfig,
		settings: { ...desktopConfig.settings, screenEmulation: { ...DESKTOP_SCREEN } }
	};
}

/** Where a form factor's reports go: desktop runs never overwrite the mobile reports. */
export function reportDir(formFactor: FormFactor): string {
	return formFactor === 'desktop' ? 'lighthouse-reports/desktop' : 'lighthouse-reports';
}
