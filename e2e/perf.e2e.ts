import { test, type APIRequestContext } from '@playwright/test';
import { expectLoadBudget, GUARD_MS, type Seeded } from './load-budget';
import { resetPrograms, seedProgram } from './program-support';
import { query } from './support';

/**
 * The main-thread budget while each of the app's screens loads (e2e/load-budget.ts: median
 * blocking time of 5 cold loads at 4× CPU, within GUARD_MS). The workout screens, measured with a
 * workout in progress or a full History, are perf-workout-load.e2e.ts's; the coach's on their
 * fixtures perf-coach-load.e2e.ts's; M6's (/progress views and reviews) perf-progress-load.e2e.ts's.
 *
 * Program screens (PROGRAM_SCREENS) are also held to MAX_SHIFT: the sum of layout shifts no input
 * explains, on every load, so a streamed or lazy panel never pushes content once it has painted.
 */
/** The hybrid fixture's week-1 strength session, whose lineage is known once it is seeded. */
const STRENGTH_SESSION = '/train/session/<strength>';
/** History with the hybrid fixture's version 1 and its decisions. */
const HISTORY = '/train/history';
/** Today once onboarding is complete and there is no program: the Build card over the summary. */
const TODAY_BUILD = '/today (build)';
/** Today with the 'today' fixture's week 1 around the server's today: its sessions and Up next. */
const TODAY_PROGRAM = '/today (program)';
const PROGRAM_SCREENS = [TODAY_BUILD, TODAY_PROGRAM, '/train', STRENGTH_SESSION, HISTORY];
const SCREENS = [
	'/',
	'/today',
	TODAY_BUILD,
	TODAY_PROGRAM,
	'/train',
	STRENGTH_SESSION,
	HISTORY,
	'/progress',
	'/coach',
	'/profile',
	'/profile/security',
	'/profile/equipment',
	'/profile/schedule',
	'/onboarding'
];

/**
 * Seed what `path` is measured on through the fixture route: the URL to load, and how to put the
 * owner's onboarding back afterwards, so the screens measured next see it as they would have.
 */
async function seedFor(path: string, request: APIRequestContext): Promise<Seeded> {
	const none = { url: path, restore: async () => {} };
	if (!PROGRAM_SCREENS.includes(path)) return none;
	// Train is measured in its program state: a hybrid week, strength, runs and Muay Thai;
	// the session screen on that week's strength session, its longest; History on its versions.
	const fixture = path === TODAY_BUILD || path === TODAY_PROGRAM ? 'today' : 'hybrid';
	const seeded = await seedProgram(request, { fixture, start: 'this_week' });
	if (path === '/train' || path === HISTORY) return none;
	if (path === STRENGTH_SESSION) {
		const strength = seeded.sessions.find((s) => s.title === 'Full body');
		return { ...none, url: `/train/session/${strength!.lineage}` };
	}
	// Today picks its state from onboarding: complete, with the program or (removed) without it.
	if (path === TODAY_BUILD) await resetPrograms();
	const [before] = await query<{ at: Date | null }>(
		'select onboarding_completed_at as at from athlete_profiles'
	);
	await query('update athlete_profiles set onboarding_completed_at = now()');
	return {
		url: '/today',
		restore: async () => {
			await query('update athlete_profiles set onboarding_completed_at = $1', [before?.at ?? null]);
		}
	};
}

test.describe('main-thread budget (4× CPU)', () => {
	test.skip(({ browserName }) => browserName !== 'chromium', 'CPU throttling uses CDP');
	test.afterAll(() => resetPrograms());

	for (const path of SCREENS) {
		test(`${path} blocks the main thread ≤ ${GUARD_MS} ms while loading`, async ({
			browser,
			request
		}, testInfo) => {
			await expectLoadBudget(path, await seedFor(path, request), {
				browser,
				testInfo,
				maxShift: PROGRAM_SCREENS.includes(path)
			});
		});
	}
});
