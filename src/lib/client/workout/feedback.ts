/**
 * What the rest timer does besides showing the time (PRD §8): a vibration and a short tone when a
 * rest is over, and the screen kept awake during rest. Whether each is wanted is the device's
 * settings (settings.ts); `feedbackSupport` tells the settings sheet which to hide.
 *
 * - Each fails silently where the platform lacks it or refuses it, so a screen calls them without
 *   checking first: iOS Safari has no Vibration API, its silent switch mutes the tone, and the
 *   Screen Wake Lock needs Safari 16.4 or a recent Chromium.
 * - None of them alerts while the phone is locked: a web app cannot (the M4 plan's open
 *   questions). The rest timer's 'Rest over' on screen is the guarantee.
 * - Only the screens that use it load it, with a dynamic import.
 * `platform` is the page's own globals unless a test hands in fakes.
 */

/** What feedback reads from the browser. */
export interface FeedbackPlatform {
	navigator?: { vibrate?: Navigator['vibrate']; wakeLock?: Pick<WakeLock, 'request'> };
	document?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
	AudioContext?: typeof AudioContext;
	/** Safari before 14.1. */
	webkitAudioContext?: typeof AudioContext;
}

const page = globalThis as FeedbackPlatform;

/** Which of the three this browser has. */
export function feedbackSupport(platform: FeedbackPlatform = page) {
	return {
		vibration: typeof platform.navigator?.vibrate === 'function',
		tone: typeof (platform.AudioContext ?? platform.webkitAudioContext) === 'function',
		wakeLock: typeof platform.navigator?.wakeLock?.request === 'function'
	};
}

// ---- Vibration ------------------------------------------------------------------------------

/** 'Rest over': two short pulses. */
export const REST_OVER_VIBRATION: readonly number[] = Object.freeze([200, 100, 200]);

/**
 * Vibrates, where the Vibration API exists; false where it does not, or where the browser blocks
 * it (Chromium does until the page has had a tap).
 */
export function vibrate(
	pattern: number | readonly number[] = REST_OVER_VIBRATION,
	platform: FeedbackPlatform = page
): boolean {
	try {
		return (
			platform.navigator?.vibrate?.(typeof pattern === 'number' ? pattern : [...pattern]) ?? false
		);
	} catch {
		return false;
	}
}

// ---- The tone -------------------------------------------------------------------------------

/** 'Rest over': an A5 sine for 180 ms at a quarter of full volume, faded in and out over 10 ms. */
export const REST_OVER_TONE = Object.freeze({ hz: 880, ms: 180, gain: 0.25, fadeMs: 10 });

/** Gestures browsers let start audio: a tap, or a key press. */
const UNLOCK_EVENTS = ['pointerup', 'keydown'] as const;

export interface Tone {
	/** Plays the tone; false, and silent, before the page's first tap or without Web Audio. */
	play(): boolean;
	/** Stops listening for taps and closes the audio. */
	dispose(): void;
}

/**
 * A short tone. Browsers start audio only from a gesture, so the audio context is created and
 * resumed by the first tap or key press after this is called; iOS suspends it again after an
 * interruption (a call), so any later tap resumes it.
 */
export function createTone(platform: FeedbackPlatform = page): Tone {
	const Context = platform.AudioContext ?? platform.webkitAudioContext;
	const doc = platform.document;
	if (!Context || !doc) return { play: () => false, dispose: () => {} };

	let context: AudioContext | null = null;
	const unlock = () => {
		if (context?.state === 'running') return;
		try {
			context ??= new Context();
			context.resume().catch(() => {});
		} catch {
			// No audio context is allowed: the tone stays silent.
		}
	};
	for (const type of UNLOCK_EVENTS) {
		doc.addEventListener(type, unlock, { capture: true, passive: true });
	}

	return {
		play() {
			if (context?.state !== 'running') return false;
			try {
				const { hz, ms, gain: peak, fadeMs } = REST_OVER_TONE;
				const start = context.currentTime;
				const end = start + ms / 1000;
				const oscillator = context.createOscillator();
				const gain = context.createGain();
				oscillator.frequency.value = hz;
				gain.gain.setValueAtTime(0, start);
				gain.gain.linearRampToValueAtTime(peak, start + fadeMs / 1000);
				gain.gain.setValueAtTime(peak, end - fadeMs / 1000);
				gain.gain.linearRampToValueAtTime(0, end);
				oscillator.connect(gain).connect(context.destination);
				oscillator.start(start);
				oscillator.stop(end);
				return true;
			} catch {
				return false;
			}
		},
		dispose() {
			for (const type of UNLOCK_EVENTS) doc.removeEventListener(type, unlock, { capture: true });
			const closing = context;
			context = null;
			closing?.close().catch(() => {});
		}
	};
}

// ---- Keeping the screen awake ---------------------------------------------------------------

export interface ScreenWakeLock {
	/** Keeps the screen on until released; false where there is no Wake Lock or it is refused. */
	acquire(): Promise<boolean>;
	release(): Promise<void>;
}

/**
 * The Screen Wake Lock. The browser drops it whenever the page is hidden, so it is taken again
 * each time the page is shown, until released; a refusal (battery saver, a hidden page) is not
 * an error.
 */
export function createWakeLock(platform: FeedbackPlatform = page): ScreenWakeLock {
	const wakeLock = platform.navigator?.wakeLock;
	const doc = platform.document;
	if (typeof wakeLock?.request !== 'function' || !doc) {
		return { acquire: () => Promise.resolve(false), release: () => Promise.resolve() };
	}

	let wanted = false;
	let sentinel: WakeLockSentinel | null = null;
	let pending: Promise<void> | null = null;
	const held = () => sentinel !== null && !sentinel.released;

	const take = async () => {
		try {
			const next = await wakeLock.request('screen');
			if (wanted && !held()) sentinel = next;
			else await next.release();
		} catch {
			// Refused: the screen follows its own auto-lock.
		}
	};
	const request = () => (pending ??= take().finally(() => (pending = null)));
	const onVisibility = () => {
		if (wanted && doc.visibilityState === 'visible' && !held()) void request();
	};

	return {
		async acquire() {
			if (!wanted) doc.addEventListener('visibilitychange', onVisibility);
			wanted = true;
			if (!held()) await request();
			return held();
		},
		async release() {
			wanted = false;
			doc.removeEventListener('visibilitychange', onVisibility);
			const releasing = sentinel;
			sentinel = null;
			try {
				await releasing?.release();
			} catch {
				// Already released by the browser.
			}
		}
	};
}
