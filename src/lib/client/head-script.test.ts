import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEAVING_RESET_MS } from './leaving.ts';

/** The head script of src/app.html, which runs before any of the app's code. */
const HEAD_SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(
	readFileSync(new URL('../../app.html', import.meta.url), 'utf8')
)![1]!;

/** A window as far as the head script sees it. */
let page: EventTarget & { __pcLeftAt?: number };
/** This device's localStorage, as far as the head script sees it. */
const stored = new Map<string, string>();

function runHeadScript() {
	page = new EventTarget();
	const storage = {
		getItem: (key: string) => stored.get(key) ?? null,
		removeItem: (key: string) => stored.delete(key)
	};
	new Function('window', 'addEventListener', 'localStorage', 'document', 'matchMedia', HEAD_SCRIPT)(
		page,
		page.addEventListener.bind(page),
		storage,
		{},
		() => ({ matches: false })
	);
}

/** An unhandled rejection reaching the window; true when something cancelled its report. */
function rejectUnhandled(reason: unknown): boolean {
	const event = new Event('unhandledrejection', { cancelable: true });
	Object.defineProperty(event, 'reason', { value: reason });
	page.dispatchEvent(event);
	return event.defaultPrevented;
}

const WEBKIT_IMPORT = new TypeError('Importing a module script failed.');
const CHROMIUM_IMPORT = new TypeError(
	'Failed to fetch dynamically imported module: https://coach.test/_app/immutable/entry/start.js'
);

beforeEach(() => {
	vi.useFakeTimers();
	stored.clear();
	runHeadScript();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('the head script, on a module that fails to load', () => {
	it('lets it be reported on a page nobody is leaving: a real import failure is an error', () => {
		expect(rejectUnhandled(WEBKIT_IMPORT)).toBe(false);
		expect(rejectUnhandled(CHROMIUM_IMPORT)).toBe(false);
	});

	it.each(['beforeunload', 'pagehide'])(
		'cancels its report once the page is being left (%s)',
		(leave) => {
			page.dispatchEvent(new Event(leave));
			expect(rejectUnhandled(WEBKIT_IMPORT)).toBe(true);
			expect(rejectUnhandled(CHROMIUM_IMPORT)).toBe(true);
		}
	);

	it('leaves any other rejection alone on the way out', () => {
		page.dispatchEvent(new Event('beforeunload'));
		expect(rejectUnhandled(new TypeError('x is not a function'))).toBe(false);
		expect(rejectUnhandled(new Error('Importing a module script failed.'))).toBe(false);
		expect(rejectUnhandled('module')).toBe(false);
	});

	it('reports again once the leave has expired, as leaving.ts says it does', () => {
		page.dispatchEvent(new Event('beforeunload'));
		vi.advanceTimersByTime(LEAVING_RESET_MS - 1);
		expect(rejectUnhandled(WEBKIT_IMPORT)).toBe(true);
		vi.advanceTimersByTime(1);
		expect(rejectUnhandled(WEBKIT_IMPORT)).toBe(false);
	});
});

describe('the head script, on a device an earlier version saved a design choice on', () => {
	it('removes the choice, and keeps the device’s preferences', () => {
		stored.set('pc:prefs:v1', JSON.stringify({ theme: 'dark' }));
		stored.set('pc:design:v1', 'graphite');
		runHeadScript();
		expect([...stored.keys()]).toEqual(['pc:prefs:v1']);
	});
});
