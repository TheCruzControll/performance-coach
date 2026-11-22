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

/** journey-strength's journey 1: Today to History on the 'workout-day' program. */
const STRENGTH_JOURNEY = {
	file: 'journey-strength.serial.e2e.ts',
	title:
		'journey 1: Today → log with weight, reps and RPE → rest → plates → a machine swap → a refresh restores exactly → finish → History, exercise history and Done'
};

/** journey-strength's start from a week 1 the real generator built. */
const GENERATED_START = {
	file: 'journey-strength.serial.e2e.ts',
	title:
		'a week 1 the generator built: its first strength session asks for a load by RPE, invents none, and a logged set reaches Postgres'
};

/** journey-weekly-review's loop, on an iPhone and in a desktop window, and its late decision. */
const WEEKLY = 'journey-weekly-review.serial.e2e.ts';
const WEEKLY_TITLE =
	'journey: log today’s last session → review the week from Today → a half step and one left out → next week in Train, History and the inbox';
const WEEKLY_JOURNEY = { file: WEEKLY, title: `on an iPhone › ${WEEKLY_TITLE}` };
const WEEKLY_JOURNEY_DESKTOP = { file: WEEKLY, title: `in a desktop window › ${WEEKLY_TITLE}` };
const WEEKLY_AGED = {
	file: WEEKLY,
	title:
		'review-aged: decided late in the week › the passed changes are struck through, the rest are applied, and Train lists only those'
};
/** coach-journeys' journeys (the M5 brief's list), each a test on an iPhone and on a desktop window. */
const COACH_JOURNEYS = [
	'journey 1: how has my bench progressed: the facts and their sources are the sets Postgres holds',
	'journey 2: change today’s workout, Accept, and Train shows the new version with the why',
	'journey 3: a rejection’s reason reaches the next turn’s get_coach_proposals and the memory panel',
	'journey 4: a dislike said to the coach is in Profile, and accepted, out of next week',
	'in a workout › journey 5: the leg press is taken: a substitution in the workout, no preference, the same version',
	'journey 6: the knee report is in the memory panel, and a pain message gets the safety block with no banned phrase',
	'in a workout › journey 7: the coach unavailable, while a set logged in the workout reaches Postgres',
	'journey 8: a reload keeps the conversation and its proposal, in Coach and in the inbox'
];

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
	{
		id: 'start-workout',
		prd: '§19: start workout',
		projects: SERIAL,
		tests: [STRENGTH_JOURNEY, GENERATED_START]
	},
	{ id: 'log-sets', prd: '§19: log sets/reps/RPE', projects: SERIAL, tests: [STRENGTH_JOURNEY] },
	{ id: 'rest-timer', prd: '§19: rest timer', projects: SERIAL, tests: [STRENGTH_JOURNEY] },
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
	{
		id: 'substitute',
		prd: '§19: substitute an unavailable exercise',
		projects: SERIAL,
		tests: [STRENGTH_JOURNEY]
	},
	{
		id: 'refresh-restore',
		prd: '§19: refresh and restore active workout',
		projects: SERIAL,
		tests: [STRENGTH_JOURNEY]
	},
	{
		id: 'complete-workout',
		prd: '§19: complete workout',
		projects: SERIAL,
		tests: [STRENGTH_JOURNEY]
	},
	{ id: 'view-history', prd: '§19: view history', projects: SERIAL, tests: [STRENGTH_JOURNEY] },
	{
		id: 'weekly-review',
		prd: '§19: weekly review',
		projects: SERIAL,
		tests: [WEEKLY_JOURNEY, WEEKLY_JOURNEY_DESKTOP]
	},
	{
		id: 'next-week',
		prd: '§19: generate next week',
		projects: SERIAL,
		tests: [WEEKLY_JOURNEY, WEEKLY_JOURNEY_DESKTOP, WEEKLY_AGED]
	},
	{
		id: 'concurrent-disciplines',
		prd: '§19: multiple concurrent disciplines',
		pending: 'journey-concurrent-disciplines'
	},
	{
		id: 'coach',
		prd: COACH_PRD,
		projects: SERIAL,
		tests: COACH_JOURNEYS.map((title) => ({
			file: 'coach-journey.serial.e2e.ts',
			title: `on an iPhone › ${title}`
		}))
	}
];

/**
 * persistence-gaps' matrix (PRD §18). Where an engine cannot do what a case needs (WebKit's
 * processes not carrying the profile path, its service worker script fetch not reaching
 * context.route, its offline emulation not reaching the worker), the test records the gap and its
 * reason as an annotation at run time, so every title is still required in both serial projects.
 */
const PERSISTENCE_MATRIX = 'persistence-matrix.serial.e2e.ts';
const CRASH_AND_REOPEN =
	'a browser crash and reopen › the browser is killed with SIGKILL after 3 sets online and 3 offline: relaunched on its profile, the workout resumes with its exercise, 6 sets and rest timer, and syncs exactly 6 rows';
const CLOSED_MID_SYNC =
	'the network during a sync › a page closed while its sync request is held: reopened, the sets replay, one row per set';
const NETWORK_FLAPS =
	'the network during a sync › the network drops at 10 counted steps of a 20-set flush, before and after the server commits: 20 rows in order, none duplicated';
const APP_UPDATE =
	'an app update mid-workout › a byte-different service worker installs mid-workout: the workout stays intact, and once the app is reopened the new worker is active and the workout carries on';
const OFFLINE_RELOAD =
	'an offline reload › a reload of /workout offline restores the workout from IndexedDB, and reconnecting syncs it once';

export const PERSISTENCE: readonly JourneyEntry[] = [
	{
		id: 'refresh-mid-workout',
		prd: '§18: refresh mid-workout',
		projects: SERIAL,
		tests: [STRENGTH_JOURNEY]
	},
	{
		id: 'close-reopen',
		prd: '§18: close/reopen',
		projects: SERIAL,
		tests: [
			{ file: PERSISTENCE_MATRIX, title: CRASH_AND_REOPEN },
			{ file: PERSISTENCE_MATRIX, title: CLOSED_MID_SYNC },
			{ file: PERSISTENCE_MATRIX, title: APP_UPDATE }
		]
	},
	{ id: 'network-loss', prd: '§18: temporary network loss', pending: 'journey-offline-sync' },
	{
		id: 'restore-active',
		prd: '§18: restoring an active workout',
		projects: SERIAL,
		tests: [STRENGTH_JOURNEY]
	},
	{ id: 'sync-sets', prd: '§18: syncing completed sets', pending: 'journey-offline-sync' },
	{ id: 'no-duplicates', prd: '§18: no duplicates', pending: 'journey-offline-sync' },
	// Journey 3 of journey-offline-sync: a 500 then a 200, a lost response, an invalid mutation.
	{
		id: 'failed-sync',
		prd: '§18: recovery from failed sync',
		projects: SERIAL,
		tests: [
			'the sync answers 500, then 200: retried, and the sets land once',
			'an answer lost after the server committed: answered duplicate on the resend, one row',
			'a permanently invalid change is shown with its reason, then discarded: nothing in Postgres'
		].map((title) => ({
			file: 'journey-offline.serial.e2e.ts',
			title: `journey 3: a failed sync recovers › ${title}`
		}))
	},
	{
		id: 'offline-online',
		prd: '§18: safe offline↔online transitions',
		projects: SERIAL,
		tests: [
			{ file: PERSISTENCE_MATRIX, title: NETWORK_FLAPS },
			{ file: PERSISTENCE_MATRIX, title: OFFLINE_RELOAD }
		]
	}
];
