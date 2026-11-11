/**
 * When a change is on screen, for the workout's own timings (Logger.svelte's pc:set-confirmed). An
 * animation-frame callback runs before the browser's style, layout and paint for that frame, so a
 * measure ended there leaves the rendering out. A message posted from it runs in the next task,
 * once that rendering step is done: the frame has been presented to the compositor. A message, not
 * a timer, because timers may be clamped. A hidden page renders no frame, so nothing runs there.
 * `platform` is the page's own globals unless a test hands in fakes.
 */

/** What the timing reads from the browser. */
export interface FramePlatform {
	requestAnimationFrame: (callback: FrameRequestCallback) => unknown;
	MessageChannel?: typeof MessageChannel;
	setTimeout: (callback: () => void) => unknown;
	performance: Pick<Performance, 'now' | 'measure'>;
}

const page = globalThis as unknown as FramePlatform;

/** Runs `run` in the first task after the next frame has been rendered. */
export function afterPresented(run: () => void, platform: FramePlatform = page) {
	platform.requestAnimationFrame(() => {
		const Channel = platform.MessageChannel;
		if (!Channel) {
			platform.setTimeout(run);
			return;
		}
		const { port1, port2 } = new Channel();
		port1.onmessage = () => {
			port1.close();
			run();
		};
		port2.postMessage(null);
	});
}

/** performance.measure(`name`) from `start` to the frame that shows what changed since. */
export function measureToPresented(name: string, start: number, platform: FramePlatform = page) {
	afterPresented(
		() => platform.performance.measure(name, { start, end: platform.performance.now() }),
		platform
	);
}
