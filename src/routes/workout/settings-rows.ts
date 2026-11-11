/**
 * What the workout settings sheet (SettingsSheet.svelte) shows: each on/off setting with its
 * words, and only those this browser can act on (feedback.ts's feedbackSupport). iOS Safari has
 * no Vibration API, so its sheet offers vibration only where the iPhone's haptic can tap (iOS 18,
 * on Complete set) and desktop Safari's none; a browser without Web Audio no tone, and one
 * without the Screen Wake Lock no keep-awake. Starting rest by itself works everywhere. Change the
 * words here.
 */
import type { feedbackSupport } from '#lib/client/workout/feedback.ts';
import type { WorkoutSettings } from '#lib/client/workout/settings.ts';

/** The settings that are on or off: every one but the rest per class. */
export type SettingToggle = Exclude<keyof WorkoutSettings, 'rest'>;

export interface ToggleRow {
	key: SettingToggle;
	label: string;
	description: string;
}

type Support = ReturnType<typeof feedbackSupport>;

const ROWS: readonly (ToggleRow & { needs: keyof Support | null })[] = [
	{
		key: 'autoStartRest',
		label: 'Start rest after each set',
		description: 'Completing a set starts its rest. Off: tap Start rest when you want one.',
		needs: null
	},
	{
		key: 'sound',
		label: 'Sound',
		description: 'A short tone when rest is over. The silent switch mutes it.',
		needs: 'tone'
	},
	{
		key: 'vibration',
		label: 'Vibration',
		description: 'Two short pulses when rest is over. On iPhone, a tap when you complete a set.',
		needs: 'vibration'
	},
	{
		key: 'keepAwake',
		label: 'Keep the screen awake',
		description: 'The screen stays on while you rest.',
		needs: 'wakeLock'
	}
];

/** The on/off rows this browser can act on, in order. */
export function toggleRows(support: Support): ToggleRow[] {
	return ROWS.filter((row) => row.needs === null || support[row.needs]).map(
		({ key, label, description }) => ({ key, label, description })
	);
}
