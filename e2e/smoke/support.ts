/**
 * What a smoke spec (`*.smoke.e2e.ts`) may use. Smoke specs also verify real deployments
 * (e2e/projects.ts, the deployed modes), so they are signed out and read-only: they never touch a
 * database, never import ../support.ts (which does), and never send a request that could change
 * state. `test` here enforces that: its `request` refuses any method but GET and HEAD, and its
 * `page` fails the test when the page sends one to the app's origin.
 */
import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import { e2eMode } from '../projects';

/** True when the run verifies a deployment, real or local, with test auth off. */
export function isDeployed(env: NodeJS.ProcessEnv = process.env): boolean {
	const mode = e2eMode(env);
	return mode === 'deployed' || mode === 'local-deployed';
}

/** The methods a smoke spec may send. */
export const READ_ONLY_METHODS = ['GET', 'HEAD'] as const;

const isReadOnly = (method: string | undefined) =>
	(READ_ONLY_METHODS as readonly string[]).includes((method ?? 'GET').toUpperCase());

/** `request` with every state-changing call refused before it is sent. */
export function readOnlyRequest(request: APIRequestContext): APIRequestContext {
	const refuse = (method: string) => () => {
		throw new Error(`smoke specs are read-only: ${method} is not allowed`);
	};
	return new Proxy(request, {
		get(target, property, receiver) {
			if (property === 'post' || property === 'put' || property === 'patch') {
				return refuse(property.toUpperCase());
			}
			if (property === 'delete') return refuse('DELETE');
			if (property === 'fetch') {
				return (url: Parameters<APIRequestContext['fetch']>[0], options?: { method?: string }) => {
					const method = typeof url === 'string' ? options?.method : url.method();
					if (!isReadOnly(method)) return refuse(method!.toUpperCase())();
					return target.fetch(url, options);
				};
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
}

/**
 * No session (`test.use({ storageState: signedOut })` in every smoke spec): a deployed run has none
 * to start from, and a local run must not lean on one.
 */
export const signedOut = { cookies: [], origins: [] };

/** How long the page must be quiet, after the test body and its last request, before the check. */
export const QUIET_MS = 500;
const SETTLE_TIMEOUT_MS = 10_000;

/**
 * Records every state-changing request `page`'s context sends to `origin`. `settle` waits until
 * nothing is in flight and the context has been quiet for QUIET_MS (so a write the page starts
 * after hydration, an onMount for one, is caught), then returns them.
 */
export function watchWrites(page: Page, origin: string): { settle(): Promise<string[]> } {
	const writes: string[] = [];
	let inFlight = 0;
	let lastActivity = Date.now();
	const context = page.context();
	context.on('request', (req) => {
		inFlight++;
		lastActivity = Date.now();
		if (new URL(req.url()).origin === origin && !isReadOnly(req.method())) {
			writes.push(`${req.method()} ${new URL(req.url()).pathname}`);
		}
	});
	const done = () => {
		inFlight--;
		lastActivity = Date.now();
	};
	context.on('requestfinished', done);
	context.on('requestfailed', done);
	return {
		async settle() {
			const from = Date.now();
			while (Date.now() - from < SETTLE_TIMEOUT_MS) {
				const quietSince = Math.max(lastActivity, from);
				if (inFlight <= 0 && Date.now() - quietSince >= QUIET_MS) break;
				await new Promise((r) => setTimeout(r, 50));
			}
			return writes;
		}
	};
}

export const test = base.extend({
	request: async ({ request }, use) => {
		await use(readOnlyRequest(request));
	},
	page: async ({ page, baseURL }, use) => {
		// No conditional UI: the sign-in screen's passkey autofill would ask the server for a
		// challenge, and storing one is a write.
		await page.addInitScript(() => {
			if (typeof PublicKeyCredential === 'undefined') return;
			Object.defineProperty(PublicKeyCredential, 'isConditionalMediationAvailable', {
				value: async () => false
			});
		});
		// page.request and context.request send without a 'request' event: refuse their writes too.
		for (const owner of [page, page.context()]) {
			Object.defineProperty(owner, 'request', { value: readOnlyRequest(owner.request) });
		}
		const watch = watchWrites(page, new URL(baseURL!).origin);
		await use(page);
		expect(await watch.settle(), 'state-changing requests a smoke page sent').toEqual([]);
	}
});

export { expect };
