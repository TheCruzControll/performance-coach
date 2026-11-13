/**
 * Server time and page data of M6's screens on seeded data (docs/performance.md, the m6 plan's
 * PAGE TIME and PAGE DATA): each /progress view and one lift's detail at 'all' on twelve-weeks,
 * a weekly review on week-complete and a cycle review on block-end.
 *
 * - Server-Timing: after one warm-up request, the median of SAMPLES full page requests holds
 *   'total' (the whole response, as hooks.server.ts writes it) and 'analytics' (the time inside
 *   the analytics facts, services/analytics/facts.ts) to GUARD_MS each. TARGET_MS is reported.
 *   Every /progress view reads its facts, so it must report 'analytics'; a review page reads its
 *   stored snapshot and reports it only when it does.
 * - Page data: the screen's __data.json, every node as a full load asks for it, is at most
 *   MAX_DATA_KB gzip.
 *
 * Requests only, so it runs once, on Chromium: no engine changes what the server does.
 * Serial: the history is the one owner's, which every browser and worker shares.
 */
import { gzipSync } from 'node:zlib';
import { expect, test, type APIRequestContext, type TestInfo } from '@playwright/test';
import { resetAnalytics, seedAnalytics, type SeededAnalytics } from './analytics-support';
import { resetReviews, seedReview, type SeededReview } from './review-support';
import { SAME_ORIGIN } from './support';

test.describe.configure({ mode: 'serial' });
test.skip(({ browserName }) => browserName !== 'chromium', 'server timing: one engine is enough');

/** The page-time target and the guard that fails the run (the plan's 150 and 300 ms). */
const TARGET_MS = 150;
const GUARD_MS = 300;
/** Page data per M6 page, gzip (KB of 1,024 B). */
const MAX_DATA_KB = 32;
/** Requests timed after the warm-up; the median counts. */
const SAMPLES = 5;

/** The load-failed notice of Progress, an exercise's detail and a review. */
const LOAD_FAILED = /data-testid="(progress|exercise|reviews)-failed"/;

const VIEWS = ['overview', 'strength', 'running', 'general'] as const;

/** Each Server-Timing metric's duration in ms: `analytics;dur=12.3;desc="4 ops", total;dur=40`. */
function serverTiming(header: string | undefined): Record<string, number> {
	const metrics: Record<string, number> = {};
	for (const part of (header ?? '').split(',')) {
		const [name, ...params] = part.trim().split(';');
		const dur = params.find((p) => p.trim().startsWith('dur='));
		if (name && dur) metrics[name] = Number(dur.trim().slice(4));
	}
	return metrics;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/**
 * Time `url` and weigh its page data, then check both: 'analytics' is required when `analytics`
 * is 'required'.
 */
async function measure(
	request: APIRequestContext,
	testInfo: TestInfo,
	url: string,
	analytics: 'required' | 'optional'
) {
	const timings: Record<string, number>[] = [];
	for (let i = 0; i <= SAMPLES; i++) {
		const response = await request.get(url, { headers: SAME_ORIGIN });
		expect(response.status(), url).toBe(200);
		// A read that throws still answers 200, fast, with the load-failed notice: not a pass.
		expect(await response.text(), `${url}: load-failed notice`).not.toMatch(LOAD_FAILED);
		if (i > 0) timings.push(serverTiming(response.headers()['server-timing']));
	}
	const total = median(timings.map((t) => t.total ?? Number.NaN));
	const reported = timings.filter((t) => t.analytics !== undefined);
	if (analytics === 'required')
		expect(reported.length, `${url}: Server-Timing analytics`).toBe(SAMPLES);
	const facts = reported.length ? median(reported.map((t) => t.analytics!)) : null;

	const { pathname, search } = new URL(url, 'https://coach.test');
	const data = await request.get(`${pathname.replace(/\/$/, '')}/__data.json${search}`, {
		headers: SAME_ORIGIN
	});
	expect(data.status(), `${url} __data.json`).toBe(200);
	const dataKb = gzipSync(await data.body()).length / 1024;

	const vs = (ms: number) =>
		`${Math.round(ms)} ms (${ms <= TARGET_MS ? 'meets' : 'above'} ${TARGET_MS})`;
	testInfo.annotations.push({
		type: 'server time',
		description: `${url}: total ${vs(total)} · analytics ${facts === null ? 'not reported' : vs(facts)} · __data.json ${dataKb.toFixed(1)} KB gzip`
	});
	expect(total, `${url}: total server time`).toBeLessThanOrEqual(GUARD_MS);
	if (facts !== null) expect(facts, `${url}: analytics server time`).toBeLessThanOrEqual(GUARD_MS);
	expect(dataKb, `${url}: __data.json (KB gzip)`).toBeLessThanOrEqual(MAX_DATA_KB);
}

test.describe('Progress on twelve-weeks', () => {
	let seeded: SeededAnalytics;

	test.beforeAll(async ({ request }) => {
		seeded = await seedAnalytics(request, 'twelve-weeks');
	});
	test.afterAll(() => resetAnalytics());

	for (const view of VIEWS) {
		test(`the ${view} view at 'all' answers within ${GUARD_MS} ms with ≤ ${MAX_DATA_KB} KB of data`, async ({
			request
		}, testInfo) => {
			await measure(request, testInfo, `/progress?view=${view}&period=all`, 'required');
		});
	}

	test(`a lift's detail at 'all' answers within ${GUARD_MS} ms with ≤ ${MAX_DATA_KB} KB of data`, async ({
		request
	}, testInfo) => {
		const url = `/progress/exercises/${seeded.exercises.back_squat}?period=all`;
		await measure(request, testInfo, url, 'optional');
	});
});

test.describe('reviews', () => {
	test.afterAll(({ request }) => resetReviews(request));

	/** Create the seeded review through the list's form action, as a no-JS Create posts it. */
	async function create(request: APIRequestContext, seeded: SeededReview): Promise<string> {
		const { review } = seeded;
		const { action, form } =
			review.kind === 'weekly'
				? { action: 'create', form: { weekStartsOn: review.weekStartsOn } }
				: {
						action: 'createCycle',
						form: { programId: seeded.programId!, blockLineage: review.blockLineageId }
					};
		const response = await request.post(`/progress/reviews?/${action}`, {
			// A browser's no-JS post asks for HTML; Playwright's default */* gets the action's JSON.
			headers: { ...SAME_ORIGIN, accept: 'text/html' },
			form,
			maxRedirects: 0
		});
		expect(response.status(), `creating the ${review.kind} review`).toBe(303);
		return new URL(response.headers().location!, 'https://coach.test').pathname;
	}

	for (const scenario of ['week-complete', 'block-end'] as const) {
		const kind = scenario === 'week-complete' ? 'weekly' : 'cycle';
		test(`a ${kind} review answers within ${GUARD_MS} ms with ≤ ${MAX_DATA_KB} KB of data`, async ({
			request
		}, testInfo) => {
			const url = await create(request, await seedReview(request, scenario));
			await measure(request, testInfo, url, 'optional');
		});
	}
});
