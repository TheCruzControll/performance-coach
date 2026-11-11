import { describe, expect, it, vi } from 'vitest';
import { afterPresented, measureToPresented, type FramePlatform } from './presented.ts';

/**
 * A page run by hand, in the browser's order: `frame()` runs the animation-frame callbacks (style,
 * layout and paint follow them in the same rendering step), `tasks()` the posted messages, which
 * the event loop runs only once that step is done. The clock moves as the test says.
 */
function page(options: { channel?: boolean } = {}) {
	let now = 0;
	const frames: FrameRequestCallback[] = [];
	const messages: (() => void)[] = [];
	const closed: unknown[] = [];
	const measures: { name: string; start: number; end: number }[] = [];
	class FakeChannel {
		port1 = {
			onmessage: null as null | (() => void),
			close: () => closed.push(this.port1)
		};
		port2 = {
			postMessage: () => messages.push(() => this.port1.onmessage?.())
		};
	}
	const platform: FramePlatform = {
		requestAnimationFrame: (callback) => frames.push(callback),
		MessageChannel:
			options.channel === false ? undefined : (FakeChannel as unknown as typeof MessageChannel),
		setTimeout: (callback: () => void) => messages.push(callback),
		performance: {
			now: () => now,
			measure: ((name: string, { start, end }: { start: number; end: number }) =>
				measures.push({ name, start, end })) as unknown as Performance['measure']
		}
	};
	return {
		platform,
		measures,
		closed,
		advance: (ms: number) => (now += ms),
		frame: () => frames.splice(0).forEach((callback) => callback(now)),
		tasks: () => messages.splice(0).forEach((run) => run())
	};
}

describe('afterPresented', () => {
	it('runs in the task after the next frame is rendered, never inside the frame callback', () => {
		const fake = page();
		const run = vi.fn();
		afterPresented(run, fake.platform);
		fake.tasks();
		expect(run, 'not before the frame').not.toHaveBeenCalled();
		fake.frame();
		expect(run, 'not in the frame callback, before style, layout and paint').not.toHaveBeenCalled();
		fake.tasks();
		expect(run).toHaveBeenCalledOnce();
		expect(fake.closed, 'the channel is closed once used').toHaveLength(1);
	});

	it('falls back to a timer task after the frame where there is no MessageChannel', () => {
		const fake = page({ channel: false });
		const run = vi.fn();
		afterPresented(run, fake.platform);
		fake.frame();
		expect(run).not.toHaveBeenCalled();
		fake.tasks();
		expect(run).toHaveBeenCalledOnce();
	});
});

describe('measureToPresented', () => {
	it('ends the measure when the frame that shows the change has been rendered', () => {
		const fake = page();
		measureToPresented('pc:set-confirmed', 3, fake.platform);
		fake.advance(9);
		// The frame callback runs at 12; its style, layout and paint take 30 ms more.
		fake.frame();
		fake.advance(30);
		expect(fake.measures).toEqual([]);
		fake.tasks();
		expect(fake.measures).toEqual([{ name: 'pc:set-confirmed', start: 3, end: 39 }]);
	});
});
