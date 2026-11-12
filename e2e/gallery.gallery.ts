/**
 * The screen gallery (.github/workflows/screen-gallery.yml; E2E_GALLERY=1 only, never a PR leg):
 * full-page PNGs of every main screen and important state, for design reviews, on the device the
 * project names (an iPhone 15 in WebKit, a 1440 × 900 desktop in Chromium) in both designs (today's
 * and the Graphite 2004 preview, for the owner to compare) and both themes.
 *
 * Each group seeds the one owner with the existing test-support seeds (fixture programs, the
 * analytics and review histories, the coach fixtures, a workout started from the server's kit),
 * then shoots its screens. Every group runs once per design and theme in a fresh signed-in context,
 * so it seeds again: the seeds each start from a reset. The design and the theme are the app's own
 * saved preferences (localStorage, read before first paint by src/app.html), with the matching
 * colour scheme.
 *
 * A shot that fails is recorded as failed, with why, and the group goes on: this spec captures,
 * it does not judge. Each shot appends a record to test-results/gallery/results-<device>.jsonl,
 * from which scripts/gallery-index.ts writes the contact sheet. A screen that is not on main yet
 * (its route, or the link to it, is missing) throws NotOnMainYet, saying what is missing, and shows
 * up there as 'not on main yet' rather than failed until it lands.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
	expect,
	test,
	type APIRequestContext,
	type BrowserContext,
	type Page,
	type TestInfo
} from '@playwright/test';
import {
	GALLERY_DESIGNS,
	GALLERY_DEVICES,
	GALLERY_THEMES,
	NotOnMainYet,
	recordOf,
	shotFileName,
	type GalleryDesign,
	type GalleryDevice,
	type GalleryTheme,
	type ShotRecord
} from '../scripts/gallery-index';
import { ANALYTICS_TZ, seedAnalytics } from './analytics-support';
import { COACH_TZ, openThread, postTurn, resetCoach, seedCoach } from './coach-support';
import { PROGRAM_TZ, seedProgram } from './program-support';
import { resetReviews, seedReview } from './review-support';
import { gotoHydrated, query, resetTrainingProfile, signedOut } from './support';
import { startFromKit } from './workout-start-support';

const DIR = 'test-results/gallery';
/** The app's saved display preferences (src/lib/client/preferences.svelte.ts PREFERENCES_KEY). */
const PREFERENCES_KEY = 'pc:prefs:v1';
/** This device's design (src/lib/client/design.ts DESIGN_KEY). */
const DESIGN_KEY = 'pc:design:v1';
/** What the coach fixture 'split-squat-week' answers with a proposal (coach-proposals spec). */
const REPLACE = 'I hate Bulgarian split squats, so replace them';

interface Fixtures {
	page: Page;
	context: BrowserContext;
	request: APIRequestContext;
	browserName: string;
}

interface Shooter {
	/**
	 * Run `open`, then capture the whole page as <screen>--<state>--<device>--<design>--<theme>.png. A
	 * failure is recorded, never thrown (NotOnMainYet as absent); with `skip`, nothing runs and the
	 * reason is recorded.
	 */
	shot(
		screen: string,
		state: string,
		open: () => Promise<unknown>,
		options?: { skip?: string }
	): Promise<boolean>;
	/** Record a failure outside any shot (a group's seed), so the sheet shows it. */
	fail(screen: string, state: string, err: unknown): void;
}

interface Group {
	name: string;
	timezoneId: string;
	signedOut?: boolean;
	/** The test's timeout, per design and theme. */
	minutes: number;
	run(shooter: Shooter, fixtures: Fixtures): Promise<void>;
}

/** The page settles: fonts loaded, no view transition and no finite animation running. */
async function settle(page: Page): Promise<void> {
	await expect(page.locator('body')).toBeVisible();
	await expect
		.poll(
			() =>
				page.evaluate(
					() =>
						document.fonts.status === 'loaded' &&
						!document.activeViewTransition &&
						document
							.getAnimations()
							.every(
								(a) =>
									a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity
							)
				),
			{ timeout: 10_000 }
		)
		.toBe(true)
		.catch(() => {}); // a screen that never settles is still worth a look
}

function shooter(
	page: Page,
	testInfo: TestInfo,
	design: GalleryDesign,
	theme: GalleryTheme
): Shooter {
	const device = testInfo.project.metadata.galleryDevice as GalleryDevice;
	if (!GALLERY_DEVICES.includes(device)) {
		throw new Error(`project ${testInfo.project.name} names no gallery device`);
	}
	mkdirSync(DIR, { recursive: true });
	const record = (entry: ShotRecord) =>
		appendFileSync(path.join(DIR, `results-${device}.jsonl`), `${JSON.stringify(entry)}\n`);
	return {
		async shot(screen, state, open, { skip } = {}) {
			const file = shotFileName({ screen, state, device, design, theme });
			const key = { screen, state, device, design, theme };
			if (skip) {
				record({ ...key, status: 'skipped', reason: skip });
				return false;
			}
			try {
				await open();
				await settle(page);
				await page.screenshot({
					path: path.join(DIR, file),
					fullPage: true,
					animations: 'disabled'
				});
				record({ ...key, status: 'captured', file });
				return true;
			} catch (err) {
				record(recordOf(key, err));
				return false;
			}
		},
		fail(screen, state, err) {
			record(recordOf({ screen, state, device, design, theme }, err));
		}
	};
}

/** Open `path` once the network settles, and check its level-1 heading when given. */
async function visit(page: Page, to: string, heading?: string | RegExp) {
	await gotoHydrated(page, to);
	if (heading) await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
}

/** Onboarding done, as the Today specs mark it: Today then shows the program, not the setup card. */
const onboarded = () => query('update athlete_profiles set onboarding_completed_at = now()');

/** Follow the first link on the page whose href starts with `prefix`. */
async function follow(page: Page, prefix: string) {
	await page.locator(`main a[href^="${prefix}"]`).first().click();
	await page.waitForURL((url) => url.pathname.startsWith(prefix));
	await page.waitForLoadState('networkidle');
}

const GROUPS: Group[] = [
	{
		name: 'today',
		timezoneId: PROGRAM_TZ,
		minutes: 4,
		async run({ shot }, { page, request }) {
			await shot('today', 'sessions', async () => {
				await seedProgram(request, { fixture: 'today', start: 'this_week' });
				await onboarded();
				await visit(page, '/today', 'Today');
			});
			await shot('today', 'rest-day', async () => {
				await seedProgram(request, { fixture: 'today-rest', start: 'this_week' });
				await onboarded();
				await visit(page, '/today', 'Today');
			});
			await shot('today', 'setup-card', async () => {
				await resetTrainingProfile();
				await visit(page, '/today', 'Today');
				await expect(page.getByTestId('today-setup')).toBeVisible();
			});
			for (const [state, to] of [
				['welcome', '/onboarding'],
				['goals', '/onboarding/goals'],
				['experience', '/onboarding/experience']
			] as const) {
				await shot('onboarding', state, () => visit(page, to));
			}
			// A read that fails while Today loads (as today.serial.e2e.ts makes one): the designed
			// error inside the shell. The table is back before the screenshot.
			await shot('error', 'load-failed', async () => {
				await query('alter table athlete_profiles rename to athlete_profiles_away');
				try {
					await page.goto('/today');
					await expect(page.getByTestId('today-setup-error')).toBeVisible();
				} finally {
					await query('alter table athlete_profiles_away rename to athlete_profiles');
				}
			});
			await shot('error', 'not-found', async () => {
				await page.goto(`/train/session/${crypto.randomUUID()}`);
				await expect(page.getByTestId('error-view')).toBeVisible();
			});
		}
	},
	{
		// Twelve weeks of hybrid training: the program, its history, a workout in progress.
		name: 'history',
		timezoneId: ANALYTICS_TZ,
		minutes: 8,
		async run({ shot }, { page, context, request, browserName }) {
			const seeded = await seedAnalytics(request, 'twelve-weeks');
			await onboarded();
			await shot('today', 'history', () => visit(page, '/today', 'Today'));
			await shot('train', 'week', () => visit(page, '/train', 'Train'));
			await shot('train', 'session', async () => {
				await visit(page, '/train', 'Train');
				await follow(page, '/train/session/');
			});
			await shot('train', 'program-history', () => visit(page, '/train/history'));
			for (const [state, to] of [
				['overview', '/progress'],
				['strength', '/progress?view=strength'],
				['running', '/progress?view=running'],
				['general', '/progress?view=general']
			] as const) {
				await shot('progress', state, () => visit(page, to, 'Progress'));
			}
			await shot('progress', 'exercise', async () => {
				const squat = seeded.exercises.back_squat;
				if (!squat) throw new Error('twelve-weeks logged no back squat');
				await visit(page, `/progress/exercises/${squat}`);
			});
			await shot('progress', 'workout-history', () => visit(page, '/progress/workouts'));
			await shot('progress', 'workout-detail', async () => {
				await visit(page, '/progress/workouts');
				await follow(page, '/progress/workouts/');
			});
			await shot('progress', 'reviews', () => visit(page, '/progress/reviews'));
			for (const [state, to] of [
				['main', '/profile'],
				['security', '/profile/security'],
				['equipment', '/profile/equipment'],
				['schedule', '/profile/schedule']
			] as const) {
				await shot('profile', state, () => visit(page, to));
			}
			await shot('offline', 'page', () => visit(page, '/offline'));
			// Offline emulation reaches service-worker traffic in Chromium only (offline.e2e.ts).
			await shot(
				'offline',
				'today',
				async () => {
					await page.goto('/train');
					await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
						timeout: 15_000
					});
					await context.setOffline(true);
					await page
						.getByRole('navigation', { name: 'Primary' })
						.getByRole('link', { name: 'Today' })
						.click();
					await expect(page.getByTestId('offline-state')).toBeVisible();
				},
				browserName === 'chromium' ? {} : { skip: 'offline emulation is Chromium-only' }
			);
			await context.setOffline(false);
		}
	},
	{
		name: 'reviews',
		timezoneId: ANALYTICS_TZ,
		minutes: 4,
		async run({ shot }, { page, request }) {
			const week = await seedReview(request, 'week-complete');
			const monday = week.review.kind === 'weekly' ? week.review.weekStartsOn : '';
			await shot('progress', 'weekly-review-due', () => visit(page, '/progress/reviews'));
			await shot('progress', 'weekly-review', async () => {
				await visit(page, '/progress/reviews');
				await page
					.locator(`[data-testid="review-create"]:has(input[value="${monday}"])`)
					.getByRole('button')
					.click();
				await page.waitForURL(new RegExp(`/progress/reviews/w-${monday}$`));
				await expect(page.getByTestId('weekly-review')).toBeVisible();
			});
			await seedReview(request, 'block-end');
			await shot('progress', 'cycle-review-due', () => visit(page, '/progress/reviews'));
			await shot('progress', 'cycle-review', async () => {
				await resetReviews(request);
				const seeded = await seedAnalytics(request, 'block-reviewed');
				const { cycleReviewId } = seeded as typeof seeded & { cycleReviewId: string };
				// Every c- key is the 404 page until the cycle review screen lands (load.ts).
				const url = `/progress/reviews/c-${cycleReviewId}`;
				if ((await page.request.get(url)).status() === 404) {
					throw new NotOnMainYet('A stored cycle review has no screen to open it yet.');
				}
				await visit(page, url);
				await page.waitForLoadState('networkidle');
			});
		}
	},
	{
		// The strength session from the server's kit, logged as the owner would.
		name: 'workout',
		timezoneId: PROGRAM_TZ,
		minutes: 4,
		async run({ shot }, { page, request }) {
			await shot('workout', 'strength', async () => {
				await startFromKit(page, request);
				await expect(page.getByTestId('set-logger')).toBeVisible();
			});
			await shot('workout', 'rest-timer', async () => {
				// The kit invents no weight for the top set (Weight 0), and a set without one is refused:
				// log it at 100 kg, as the strength journey does, so its rest starts.
				const logger = page.getByTestId('set-logger');
				const load = logger.getByTestId('logger-load').getByRole('spinbutton');
				await load.click();
				await load.fill('100');
				await load.press('Enter');
				await logger.getByTestId('complete-set').click();
				await expect(page.getByTestId('rest-timer')).toHaveAttribute('data-phase', 'running');
			});
			await shot('workout', 'this-hurts', async () => {
				const card = page.getByTestId('workout-main').getByTestId('exercise');
				await card.getByTestId('exercise-actions').click();
				await page.getByTestId('exercise-actions-sheet').getByTestId('action-pain').click();
				await expect(page.getByTestId('pain-sheet')).toBeVisible();
			});
			await shot('workout', 'finish', async () => {
				// This hurts opens over the quick actions sheet: close both, or its scrim takes the tap.
				await page.keyboard.press('Escape');
				await expect(page.getByTestId('pain-sheet')).toBeHidden();
				const actions = page.getByTestId('exercise-actions-sheet');
				await expect(actions).toBeVisible();
				await page.keyboard.press('Escape');
				await expect(actions).toBeHidden();
				await page.getByTestId('workout-menu-button').click();
				await page.getByTestId('workout-menu').getByTestId('menu-finish').click();
				await expect(page.getByTestId('finish-sheet')).toBeVisible();
			});
		}
	},
	{
		// Today's interval run from the same kit, in a context of its own (one workout a device).
		name: 'workout-run',
		timezoneId: PROGRAM_TZ,
		minutes: 3,
		async run({ shot }, { page, request }) {
			await shot('workout', 'run', async () => {
				await startFromKit(page, request, {
					pick: (p) => p.sessions.find((s) => s.date === p.today && /run|interval/i.test(s.title))
				});
				await expect(page.getByTestId('run-entry')).toBeVisible();
			});
		}
	},
	{
		name: 'coach',
		timezoneId: COACH_TZ,
		minutes: 4,
		async run({ shot }, { page, request }) {
			await shot('coach', 'empty', async () => {
				await resetCoach(request);
				await visit(page, '/coach', 'Coach');
			});
			await shot('coach', 'proposal', async () => {
				await seedCoach(request, 'split-squat-week');
				const turn = await postTurn(request, REPLACE);
				const started = turn.events.find((event) => event.type === 'run_started');
				if (started?.type !== 'run_started') throw new Error(`the turn answered ${turn.status}`);
				await openThread(page, started.threadId);
				await expect(page.getByTestId('proposal-card')).toBeVisible();
			});
			await shot('coach', 'memory', async () => {
				await page.getByRole('button', { name: 'What it knows' }).click();
				await expect(page.getByTestId('knows-sheet')).toBeVisible();
				await expect(page.getByTestId('knows-loading')).toHaveCount(0);
			});
			await shot('coach', 'proposals-inbox', async () => {
				await visit(page, '/coach', 'Coach');
				// CoachHeader's ProposalsLink renders nothing until the proposals inbox lands.
				const inbox = page.getByRole('link', { name: /proposals/i });
				if ((await inbox.count()) === 0) {
					throw new NotOnMainYet('Coach has no link to the proposals inbox yet.');
				}
				await inbox.first().click();
				await page.waitForLoadState('networkidle');
			});
		}
	},
	{
		name: 'signed-out',
		timezoneId: PROGRAM_TZ,
		signedOut: true,
		minutes: 2,
		async run({ shot }, { page }) {
			await shot('sign-in', 'main', async () => {
				await visit(page, '/');
				await expect(page.getByTestId('passkey-signin')).toBeVisible();
			});
			await shot('sign-in', 'recover', () => visit(page, '/recover'));
		}
	}
];

// The load-failed shot renames athlete_profiles; put it back even when a timeout skips its finally.
test.afterEach(async () => {
	await query('alter table if exists athlete_profiles_away rename to athlete_profiles');
});

for (const group of GROUPS) {
	test.describe(group.name, () => {
		test.use({ timezoneId: group.timezoneId });
		if (group.signedOut) test.use({ storageState: signedOut });

		for (const design of GALLERY_DESIGNS) {
			for (const theme of GALLERY_THEMES) {
				test.describe(`${design} ${theme}`, () => {
					test.use({ colorScheme: theme });

					test(`${group.name} screens in the ${design} design, ${theme} theme`, async ({
						page,
						context,
						request,
						browserName
					}, testInfo) => {
						test.setTimeout(group.minutes * 60_000);
						await context.addInitScript(
							([prefsKey, designKey, savedTheme, savedDesign]) => {
								try {
									localStorage.setItem(prefsKey!, JSON.stringify({ theme: savedTheme }));
									localStorage.setItem(designKey!, savedDesign!);
								} catch {
									// about:blank has no storage: nothing to apply there.
								}
							},
							[PREFERENCES_KEY, DESIGN_KEY, theme, design]
						);
						const shots = shooter(page, testInfo, design, theme);
						try {
							await group.run(shots, { page, context, request, browserName });
						} catch (err) {
							shots.fail(group.name, 'seed', err);
						}
					});
				});
			}
		}
	});
}
