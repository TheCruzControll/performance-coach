/**
 * The journey map (M9 acceptance 3): every PRD §19 Playwright journey, the coach's questions and
 * proposals, and every PRD §18 persistence case, each with the test titles that prove it and the
 * Playwright projects those tests must run in. Data only; scripts/journey-map.test.ts checks it
 * against `playwright test --list` and against the PRD's own lists.
 *
 * - `prd` is the PRD's wording, prefixed with its section, so a journey added to the PRD fails
 *   the check until it is mapped here.
 * - A test's `title` is its describe titles and its own title joined by ' › ', as Playwright
 *   lists it; `file` is relative to e2e/. A test's own `projects` replaces the entry's.
 * - A gap excuses one project from every test of the entry that requires it, and must say why
 *   (an engine limit, never "not written yet").
 * - A case no test proves yet names the plan slice that will: `{ pending: '<slice id>' }`.
 *   journeys-complete runs the check with STRICT=1, where nothing may be pending.
 */

/** A Playwright test by its file under e2e/ and its full title inside that file. */
export interface JourneyTest {
	file: string;
	title: string;
	/** The projects this test must run in, instead of the entry's (a setup project, say). */
	projects?: readonly string[];
}

/** A project the entry's tests may skip, and the engine limit that makes it so. */
export interface JourneyGap {
	project: string;
	reason: string;
}

export interface MappedJourney {
	id: string;
	prd: string;
	projects: readonly string[];
	tests: readonly JourneyTest[];
	gaps?: readonly JourneyGap[];
}

export interface PendingJourney {
	id: string;
	prd: string;
	/** The plan slice whose spec will prove this case (one of PROVING_SLICES). */
	pending: string;
}

export type JourneyEntry = MappedJourney | PendingJourney;

/**
 * The plan slices (M2–M9 plans) that add journey specs: the only ids a pending entry may name.
 * journey-run-muay-thai, journey-cycle-review and golden-path-journey add titles to entries
 * another slice opens.
 */
export const PROVING_SLICES = [
	'onboarding-review',
	'program-journey',
	'journey-strength',
	'journey-offline-sync',
	'journey-run-muay-thai',
	'coach-journeys',
	'journey-weekly-review',
	'journey-cycle-review',
	'journey-concurrent-disciplines',
	'persistence-gaps',
	'golden-path-journey'
] as const;

/** The journey the M9 brief adds to the PRD §19 list. */
export const COACH_PRD = 'M9 brief: coach questions and proposals';

/** The iPhone projects every journey runs in (CI adds WebKit; desktop projects come with desk-e2e). */
const IPHONE = ['iphone-chromium', 'iphone-webkit'] as const;

/** The iPhone projects serial specs (`*.serial.e2e.ts`, one owner's data) run in. */
const SERIAL = ['serial-chromium', 'serial-webkit'] as const;

/** program-journey's first journey: onboarding with blank 1RMs to an edited week-1 program. */
const BLANK_1RM_JOURNEY =
	'blank 1RMs: onboarding, a week-1 baseline program built from Today, a move and a one-off swap, all in History and persisted';

export const JOURNEYS: readonly JourneyEntry[] = [
	{
		id: 'login',
		prd: '§19: login via supported auth test flow',
		projects: IPHONE,
		tests: [
			{
				file: 'auth.setup.ts',
				title: 'owner completes first-run setup with a real passkey',
				projects: ['setup']
			},
			{
				file: 'auth.e2e.ts',
				title:
					'passkey authentication (real WebAuthn ceremonies) › sign-in with a passkey returns to the page that asked for it'
			},
			{
				file: 'auth-webkit.setup.ts',
				title: 'WebKit: mint an owner session through the test-only route',
				projects: ['setup-webkit']
			}
		],
		gaps: [
			{
				project: 'iphone-webkit',
				reason:
					'WebAuthn virtual authenticators are a Chromium DevTools Protocol feature; WebKit signs in with the session auth-webkit.setup.ts mints'
			}
		]
	},
	{ id: 'onboarding', prd: '§19: onboarding', pending: 'onboarding-review' },
	{
		id: 'blank-1rms',
		prd: '§19: leaving 1RMs blank',
		projects: SERIAL,
		tests: [{ file: 'program-journey.serial.e2e.ts', title: BLANK_1RM_JOURNEY }]
	},
	{
		id: 'week-1-baseline',
		prd: '§19: generate week-1 baseline program',
		projects: SERIAL,
		tests: [
			{ file: 'program-journey.serial.e2e.ts', title: BLANK_1RM_JOURNEY },
			{
				file: 'program-journey.serial.e2e.ts',
				title:
					'measured 1RMs: every main lift is a percentage of the measured 1RM with a load in kg, never RPE alone'
			}
		]
	},
	{ id: 'start-workout', prd: '§19: start workout', pending: 'journey-strength' },
	{ id: 'log-sets', prd: '§19: log sets/reps/RPE', pending: 'journey-strength' },
	{ id: 'rest-timer', prd: '§19: rest timer', pending: 'journey-strength' },
	{
		id: 'plate-calculator',
		prd: '§19: plate calculator',
		projects: IPHONE,
		tests: [
			{
				file: 'shell.e2e.ts',
				title:
					'app shell on an iPhone viewport › plate calculator sheet: stepper, unit switch, focus return'
			},
			{
				file: 'plate-calculator.e2e.ts',
				title: 'on a cold page the first tap opens the sheet, whose code is fetched on intent'
			}
		]
	},
	{ id: 'substitute', prd: '§19: substitute an unavailable exercise', pending: 'journey-strength' },
	{
		id: 'refresh-restore',
		prd: '§19: refresh and restore active workout',
		pending: 'journey-strength'
	},
	{ id: 'complete-workout', prd: '§19: complete workout', pending: 'journey-strength' },
	{ id: 'view-history', prd: '§19: view history', pending: 'journey-strength' },
	{ id: 'weekly-review', prd: '§19: weekly review', pending: 'journey-weekly-review' },
	{ id: 'next-week', prd: '§19: generate next week', pending: 'journey-weekly-review' },
	{
		id: 'concurrent-disciplines',
		prd: '§19: multiple concurrent disciplines',
		pending: 'journey-concurrent-disciplines'
	},
	{ id: 'coach', prd: COACH_PRD, pending: 'coach-journeys' }
];

export const PERSISTENCE: readonly JourneyEntry[] = [
	{ id: 'refresh-mid-workout', prd: '§18: refresh mid-workout', pending: 'journey-strength' },
	{ id: 'close-reopen', prd: '§18: close/reopen', pending: 'persistence-gaps' },
	{ id: 'network-loss', prd: '§18: temporary network loss', pending: 'journey-offline-sync' },
	{ id: 'restore-active', prd: '§18: restoring an active workout', pending: 'journey-strength' },
	{ id: 'sync-sets', prd: '§18: syncing completed sets', pending: 'journey-offline-sync' },
	{ id: 'no-duplicates', prd: '§18: no duplicates', pending: 'journey-offline-sync' },
	// Journey 3 of journey-offline-sync: a 500 then a 200, a lost response, an invalid mutation.
	{ id: 'failed-sync', prd: '§18: recovery from failed sync', pending: 'journey-offline-sync' },
	{
		id: 'offline-online',
		prd: '§18: safe offline↔online transitions',
		pending: 'persistence-gaps'
	}
];
