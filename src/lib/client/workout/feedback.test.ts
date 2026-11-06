import { describe, expect, it, vi } from 'vitest';
import {
	createTone,
	createWakeLock,
	feedbackSupport,
	REST_OVER_TONE,
	REST_OVER_VIBRATION,
	vibrate
} from './feedback';
import type { FeedbackPlatform } from './feedback';

const platform = (fakes: Record<string, unknown>) => fakes as unknown as FeedbackPlatform;

/** A document: events and a visibility the test sets. */
const fakeDocument = (visibilityState: DocumentVisibilityState = 'visible') =>
	Object.assign(new EventTarget(), { visibilityState });

/** Lets resolved promises run, as the browser does between a tap and the next frame. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---- Web Audio ------------------------------------------------------------------------------

interface Scheduled {
	at: number;
	value: number;
	ramp: boolean;
}

/** An AudioContext that records what it is asked to play; resume runs a tick later. */
function fakeAudio(fail: { create?: boolean; resume?: boolean; play?: boolean } = {}) {
	const contexts: FakeContext[] = [];
	class FakeContext {
		state: AudioContextState | 'interrupted' = 'suspended';
		currentTime = 12;
		destination = { speakers: true };
		resumes = 0;
		played: { hz: number; start: number; stop: number; gain: Scheduled[]; to: unknown }[] = [];
		constructor() {
			if (fail.create) throw new DOMException('Too many contexts', 'NotSupportedError');
			contexts.push(this);
		}
		resume() {
			this.resumes++;
			if (fail.resume) return Promise.reject(new DOMException('No gesture', 'NotAllowedError'));
			return Promise.resolve().then(() => void (this.state = 'running'));
		}
		close() {
			this.state = 'closed';
			return Promise.resolve();
		}
		createOscillator() {
			if (fail.play) throw new DOMException('Gone', 'InvalidStateError');
			const note = { hz: 0, start: -1, stop: -1, gain: [] as Scheduled[], to: null as unknown };
			this.played.push(note);
			return {
				frequency: {
					set value(hz: number) {
						note.hz = hz;
					}
				},
				connect: (gain: { events: Scheduled[] }) => {
					note.gain = gain.events;
					return { connect: (to: unknown) => void (note.to = to) };
				},
				start: (at: number) => void (note.start = at),
				stop: (at: number) => void (note.stop = at)
			};
		}
		createGain() {
			const events: Scheduled[] = [];
			return {
				events,
				gain: {
					setValueAtTime: (value: number, at: number) =>
						void events.push({ at, value, ramp: false }),
					linearRampToValueAtTime: (value: number, at: number) =>
						void events.push({ at, value, ramp: true })
				}
			};
		}
	}
	return { AudioContext: FakeContext, contexts };
}

describe('feedback: the tone', () => {
	it('plays nothing until the first tap, then a short, quiet tone', async () => {
		const document = fakeDocument();
		const audio = fakeAudio();
		const tone = createTone(platform({ document, AudioContext: audio.AudioContext }));
		expect(tone.play()).toBe(false);
		expect(audio.contexts).toHaveLength(0);

		document.dispatchEvent(new Event('pointerup'));
		await settle();
		const [context] = audio.contexts;
		expect(context?.resumes).toBe(1);
		expect(tone.play()).toBe(true);

		const { ms, hz, gain } = REST_OVER_TONE;
		const end = 12 + ms / 1000;
		expect(context!.played).toEqual([
			{ hz, start: 12, stop: end, gain: expect.any(Array), to: context!.destination }
		]);
		const envelope = context!.played[0]!.gain;
		expect(envelope[0]).toEqual({ at: 12, value: 0, ramp: false });
		expect(envelope.at(-1)).toEqual({ at: end, value: 0, ramp: true });
		expect(Math.max(...envelope.map((e) => e.value))).toBe(gain);
		expect(gain).toBeLessThanOrEqual(0.5);
		expect(ms).toBeLessThanOrEqual(300);
	});

	it('is unlocked by a key press too, and by one context however many taps', async () => {
		const document = fakeDocument();
		const audio = fakeAudio();
		const tone = createTone(platform({ document, AudioContext: audio.AudioContext }));
		document.dispatchEvent(new Event('keydown'));
		await settle();
		document.dispatchEvent(new Event('pointerup'));
		document.dispatchEvent(new Event('keydown'));
		await settle();
		expect(audio.contexts).toHaveLength(1);
		expect(audio.contexts[0]!.resumes).toBe(1);
		expect(tone.play()).toBe(true);
	});

	it('goes quiet when the system interrupts audio, until the next tap resumes it', async () => {
		const document = fakeDocument();
		const audio = fakeAudio();
		const tone = createTone(platform({ document, AudioContext: audio.AudioContext }));
		document.dispatchEvent(new Event('pointerup'));
		await settle();
		audio.contexts[0]!.state = 'interrupted';
		expect(tone.play()).toBe(false);
		document.dispatchEvent(new Event('pointerup'));
		await settle();
		expect(audio.contexts[0]!.resumes).toBe(2);
		expect(tone.play()).toBe(true);
	});

	it('uses the prefixed webkitAudioContext of an older Safari', async () => {
		const document = fakeDocument();
		const audio = fakeAudio();
		const tone = createTone(platform({ document, webkitAudioContext: audio.AudioContext }));
		document.dispatchEvent(new Event('pointerup'));
		await settle();
		expect(tone.play()).toBe(true);
	});

	it('stops listening and closes its context once disposed', async () => {
		const document = fakeDocument();
		const audio = fakeAudio();
		const tone = createTone(platform({ document, AudioContext: audio.AudioContext }));
		document.dispatchEvent(new Event('pointerup'));
		await settle();
		tone.dispose();
		expect(audio.contexts[0]!.state).toBe('closed');
		expect(tone.play()).toBe(false);
		document.dispatchEvent(new Event('pointerup'));
		await settle();
		expect(audio.contexts).toHaveLength(1);
		expect(tone.play()).toBe(false);
	});

	it('is a silent no-op without Web Audio: no listener, nothing thrown', () => {
		const document = fakeDocument();
		const listen = vi.spyOn(document, 'addEventListener');
		const tone = createTone(platform({ document }));
		expect(listen).not.toHaveBeenCalled();
		expect(tone.play()).toBe(false);
		expect(() => tone.dispose()).not.toThrow();
		expect(createTone(platform({ AudioContext: fakeAudio().AudioContext })).play()).toBe(false);
	});

	it('stays silent, never throwing, when the browser refuses a context, a resume or a note', async () => {
		for (const fail of [{ create: true }, { resume: true }, { play: true }]) {
			const document = fakeDocument();
			const tone = createTone(platform({ document, AudioContext: fakeAudio(fail).AudioContext }));
			expect(() => document.dispatchEvent(new Event('pointerup'))).not.toThrow();
			await settle();
			expect(tone.play(), JSON.stringify(fail)).toBe(false);
		}
	});

	it("is a no-op on the page's own globals where there is no Web Audio (the server)", () => {
		const tone = createTone();
		expect(tone.play()).toBe(false);
		expect(() => tone.dispose()).not.toThrow();
	});
});

// ---- Vibration ------------------------------------------------------------------------------

describe('feedback: the vibration', () => {
	it("buzzes the 'Rest over' pattern through navigator.vibrate, called on the navigator", () => {
		const navigator = {
			vibrate: vi.fn(function (this: unknown) {
				// Chromium throws 'Illegal invocation' for a vibrate called off its navigator.
				if (this !== navigator) throw new TypeError('Illegal invocation');
				return true;
			})
		};
		expect(vibrate(undefined, platform({ navigator }))).toBe(true);
		expect(navigator.vibrate).toHaveBeenLastCalledWith([200, 100, 200]);
		expect(REST_OVER_VIBRATION).toEqual([200, 100, 200]);
		expect(vibrate(50, platform({ navigator }))).toBe(true);
		expect(navigator.vibrate).toHaveBeenLastCalledWith(50);
	});

	it('answers false when the browser blocks it (no tap on the page yet)', () => {
		expect(vibrate(undefined, platform({ navigator: { vibrate: () => false } }))).toBe(false);
	});

	it('is a no-op without navigator.vibrate (iOS Safari), or when it throws', () => {
		expect(vibrate(undefined, platform({ navigator: {} }))).toBe(false);
		expect(vibrate(undefined, platform({}))).toBe(false);
		const throwing = {
			vibrate: () => {
				throw new DOMException('Not allowed', 'NotAllowedError');
			}
		};
		expect(vibrate(undefined, platform({ navigator: throwing }))).toBe(false);
		expect(vibrate()).toBe(false);
	});
});

// ---- The Screen Wake Lock -------------------------------------------------------------------

interface FakeSentinel {
	type: 'screen';
	released: boolean;
	release: () => Promise<void>;
}

function fakeWakeLock(refuse = false) {
	const sentinels: FakeSentinel[] = [];
	const sentinel = (): FakeSentinel => {
		const held: FakeSentinel = {
			type: 'screen',
			released: false,
			release: vi.fn(async () => void (held.released = true))
		};
		sentinels.push(held);
		return held;
	};
	const wakeLock = {
		request: vi.fn(async (type: 'screen') => {
			expect(type).toBe('screen');
			if (refuse) throw new DOMException('Battery saver is on', 'NotAllowedError');
			return sentinel();
		})
	};
	return { wakeLock, sentinels, sentinel };
}

describe('feedback: keeping the screen awake', () => {
	it('takes the screen wake lock once, and lets it go on release', async () => {
		const document = fakeDocument();
		const { wakeLock, sentinels } = fakeWakeLock();
		const lock = createWakeLock(platform({ navigator: { wakeLock }, document }));
		expect(await lock.acquire()).toBe(true);
		expect(await lock.acquire()).toBe(true);
		expect(wakeLock.request).toHaveBeenCalledTimes(1);
		await lock.release();
		expect(sentinels[0]!.released).toBe(true);
		document.dispatchEvent(new Event('visibilitychange'));
		await settle();
		expect(wakeLock.request).toHaveBeenCalledTimes(1);
	});

	it('takes it again when the page is shown, since the browser drops it while hidden', async () => {
		const document = fakeDocument();
		const { wakeLock, sentinels } = fakeWakeLock();
		const lock = createWakeLock(platform({ navigator: { wakeLock }, document }));
		await lock.acquire();
		sentinels[0]!.released = true;
		document.visibilityState = 'hidden';
		document.dispatchEvent(new Event('visibilitychange'));
		await settle();
		expect(wakeLock.request).toHaveBeenCalledTimes(1);
		document.visibilityState = 'visible';
		document.dispatchEvent(new Event('visibilitychange'));
		await settle();
		expect(wakeLock.request).toHaveBeenCalledTimes(2);
		expect(sentinels[1]!.released).toBe(false);
		expect(await lock.acquire()).toBe(true);
		expect(wakeLock.request).toHaveBeenCalledTimes(2);
	});

	it('lets go of a lock that arrives after it was released', async () => {
		const document = fakeDocument();
		const { wakeLock, sentinel } = fakeWakeLock();
		let grant: (held: FakeSentinel) => void = () => {};
		wakeLock.request.mockImplementationOnce(() => new Promise((resolve) => (grant = resolve)));
		const lock = createWakeLock(platform({ navigator: { wakeLock }, document }));
		const acquired = lock.acquire();
		await lock.release();
		const late = sentinel();
		grant(late);
		expect(await acquired).toBe(false);
		expect(late.released).toBe(true);
	});

	it('answers false, never throwing, when the browser refuses it', async () => {
		const document = fakeDocument();
		const { wakeLock } = fakeWakeLock(true);
		const lock = createWakeLock(platform({ navigator: { wakeLock }, document }));
		expect(await lock.acquire()).toBe(false);
		await expect(lock.release()).resolves.toBeUndefined();
	});

	it('is a no-op without the Wake Lock API: no listener, nothing thrown', async () => {
		const document = fakeDocument();
		const listen = vi.spyOn(document, 'addEventListener');
		const lock = createWakeLock(platform({ navigator: {}, document }));
		expect(await lock.acquire()).toBe(false);
		await expect(lock.release()).resolves.toBeUndefined();
		expect(listen).not.toHaveBeenCalled();
		expect(await createWakeLock().acquire()).toBe(false);
	});
});

// ---- Support ----------------------------------------------------------------------------------

describe('feedback: what the platform supports', () => {
	it('names each feature that exists, for the settings sheet to hide the others', () => {
		const everything = platform({
			navigator: { vibrate: () => true, wakeLock: fakeWakeLock().wakeLock },
			AudioContext: fakeAudio().AudioContext
		});
		expect(feedbackSupport(everything)).toEqual({ vibration: true, tone: true, wakeLock: true });
		// iOS Safari: Web Audio and the Wake Lock (16.4), no Vibration API.
		const safari = platform({
			navigator: { wakeLock: fakeWakeLock().wakeLock },
			webkitAudioContext: fakeAudio().AudioContext
		});
		expect(feedbackSupport(safari)).toEqual({ vibration: false, tone: true, wakeLock: true });
		expect(feedbackSupport(platform({}))).toEqual({
			vibration: false,
			tone: false,
			wakeLock: false
		});
		expect(feedbackSupport()).toEqual({ vibration: false, tone: false, wakeLock: false });
	});
});
