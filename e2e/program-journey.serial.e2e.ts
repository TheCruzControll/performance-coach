/**
 * The M3 journeys (PRD §19: leaving 1RMs blank, generating the week-1 baseline program), end to
 * end through the real onboarding, generator and screens, with no fixture program.
 *
 * 1. Onboarding through M2's screens with every 1RM blank: a Muay Thai fight, a marathon and
 *    keeping strength, around Muay Thai classes on Tuesday and Thursday evenings, 5 days a week
 *    (the generator's 'journey' scenario). Today → Build → preview → Start with Next Monday, so
 *    every session is ahead on any weekday. Train's week 1 holds strength, running and Muay Thai,
 *    the classes on Tue/Thu, and breaks no 'avoid' interference rule; a strength session works up
 *    to RPE-based top sets with the baseline instructions. A move and a one-off swap make versions
 *    2 and 3, which History lists with their why; after reloads, every screen and Postgres agree.
 * 2. A powerlifter with measured 1RMs, set up through the profile actions and built from Today:
 *    every main lift is a percentage of the measured 1RM with a load in kg, never RPE alone.
 *
 * Serial: the one owner's profile and program. Dates come from the server's today in PROGRAM_TZ.
 */
import AxeBuilder from '@axe-core/playwright';
import {
	expect,
	test,
	type APIRequestContext,
	type Locator,
	type Page,
	type TestInfo
} from '@playwright/test';
import { addDays, mondayOf, weekdayOf } from '../src/lib/domain/calendar';
import { localDay } from '../src/lib/domain/dates';
import { WEEKDAY_INFO } from '../src/lib/domain/profile/catalog';
import { BASELINE_INSTRUCTION } from '../src/lib/domain/training/describe';
import { BASELINE_CALLOUT } from '../src/lib/ui/program/session-words';
import { longDate, shortDate } from '../src/lib/ui/program/words';
import { DESKTOP, expectMainCentred, expectNoSideScroll } from './desktop';
import { PROGRAM_TZ, weekViolations } from './program-support';
import {
	captureScreen,
	gotoHydrated,
	profileAction,
	query,
	resetTrainingProfile,
	SAME_ORIGIN,
	toastWith,
	trackConsoleErrors
} from './support';

test.use({ timezoneId: PROGRAM_TZ });
// Onboarding, a real build and three screens: well past the default 30 s on WebKit.
test.describe.configure({ timeout: 180_000 });

test.beforeEach(async () => {
	await resetTrainingProfile();
});

test.afterAll(async () => {
	await resetTrainingProfile();
});

/** Week 1's first day for Build's default 'Next Monday', from the server's today in PROGRAM_TZ. */
function nextMonday(): string {
	const today = localDay(new Date(), PROGRAM_TZ);
	const monday = mondayOf(today);
	return monday === today ? today : addDays(monday, 7);
}

async function audit(page: Page): Promise<string[]> {
	await page.waitForFunction(() => document.fonts.status === 'loaded');
	await page.waitForTimeout(400); // entrance transitions settle: contrast on final colours
	const { violations } = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.analyze();
	return violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
}

// ---- Onboarding -----------------------------------------------------------------------------

/** The step's editor has loaded in place of its skeleton. */
async function stepReady(page: Page, step: string) {
	await expect(page.locator(`.step[data-step="${step}"]`)).toBeVisible();
	await expect(page.getByTestId('section-editor')).toHaveAttribute('aria-busy', 'false');
}

/** Continue (or Skip) and land on the next step, ready. */
async function moveOn(page: Page, button: 'continue' | 'skip', to: string) {
	await page.getByTestId(button === 'continue' ? 'step-continue' : 'step-skip').click();
	await expect(page).toHaveURL(`/onboarding/${to}`);
	await stepReady(page, to);
}

/** Add a goal through the goals step's sheet: an event with its date, or a general goal. */
async function addGoal(
	page: Page,
	goal: { title: string; discipline: string } & (
		{ event: string; date: string } | { focus: string; measure: string }
	)
) {
	const sheet = page.getByTestId('goal-sheet');
	await expect(sheet.getByRole('heading', { name: 'New goal' })).toBeVisible();
	if ('focus' in goal) await sheet.getByRole('radio', { name: 'General', exact: true }).click();
	await sheet.getByRole('textbox', { name: 'Goal', exact: true }).fill(goal.title);
	await sheet.getByRole('checkbox', { name: goal.discipline, exact: true }).check();
	if ('event' in goal) {
		await sheet.getByRole('button', { name: goal.event, exact: true }).click();
		await sheet.getByLabel('Event date').fill(goal.date);
	} else {
		await sheet.getByRole('textbox', { name: 'What to improve', exact: true }).fill(goal.focus);
		await sheet.getByRole('textbox', { name: 'How it’s measured', exact: true }).fill(goal.measure);
	}
	await sheet.getByRole('button', { name: 'Save goal' }).click();
	await expect(sheet).toBeHidden();
}

/** Every onboarding step, as a thumb would: scenario 6, with every 1RM left blank. */
async function onboardBlank(page: Page, testInfo: TestInfo) {
	const start = nextMonday();
	await gotoHydrated(page, '/onboarding');
	await stepReady(page, 'welcome');
	await page.getByRole('textbox', { name: 'What should your coach call you?' }).fill('Niko');
	for (const [group, unit] of [
		['Weights in', 'kg'],
		['Distances in', 'km']
	]) {
		await page
			.getByRole('radiogroup', { name: group })
			.getByRole('radio', { name: unit, exact: true })
			.check();
	}
	await moveOn(page, 'continue', 'goals');

	// The fight in week 5 comes first, then the marathon in week 20, then keeping strength.
	await page.getByTestId('goal-path-event').click();
	const fight = addDays(start, 7 * 4 + 5);
	await addGoal(page, {
		title: 'First Muay Thai fight',
		discipline: 'Muay Thai',
		event: 'Muay Thai fight',
		date: fight
	});
	await page.getByTestId('add-goal').click();
	const marathon = addDays(start, 7 * 19 + 6);
	await addGoal(page, {
		title: 'Valencia marathon',
		discipline: 'Half / marathon',
		event: 'Marathon',
		date: marathon
	});
	await page.getByTestId('add-goal').click();
	await addGoal(page, {
		title: 'Keep my strength',
		discipline: 'Strength',
		focus: 'Hold squat and deadlift',
		measure: 'Top sets at RPE 8 stay within 5%'
	});
	await expect(page.getByTestId('goal-row')).toHaveCount(3);
	await captureScreen(page, testInfo, 'journey-onboarding-goals');
	await moveOn(page, 'continue', 'experience');

	const entries = page.getByTestId('experience-entry');
	await expect(entries).toHaveCount(3);
	for (const entry of await entries.all()) {
		const level = (await entry.textContent())!.includes('Muay Thai') ? 'Intermediate' : 'Novice';
		await entry.getByRole('radio', { name: level, exact: true }).check();
	}
	await moveOn(page, 'continue', 'strength');

	// Leaving 1RMs blank: week 1 finds them.
	await page.getByRole('switch', { name: 'I don’t know my 1RMs' }).check();
	await captureScreen(page, testInfo, 'journey-onboarding-strength');
	await moveOn(page, 'continue', 'specifics');
	for (const [step, to] of [
		['specifics', 'equipment'],
		['equipment', 'injuries'],
		['injuries', 'exercises'],
		['exercises', 'schedule']
	] as const) {
		await expect(page.locator(`.step[data-step="${step}"]`)).toBeVisible();
		await moveOn(page, 'skip', to);
	}

	// Monday to Saturday, mornings or evenings, 5 days, Muay Thai on Tuesday and Thursday evenings.
	const available = page.getByRole('group', { name: 'Days you can train' });
	for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']) {
		await available.getByRole('checkbox', { name: day, exact: true }).check();
	}
	const times = page.getByRole('group', { name: 'Best times to train' });
	for (const time of ['Morning', 'Evening'])
		await times.getByRole('checkbox', { name: time, exact: true }).check();
	const days = page.getByRole('spinbutton', { name: 'Training days a week' });
	await expect(days).toHaveAttribute('aria-valuenow', '4');
	await page.getByRole('button', { name: 'Increase Training days a week' }).click();
	await expect(days).toHaveAttribute('aria-valuenow', '5');
	await page.getByTestId('add-commitment').click();
	const card = page.getByTestId('commitment').first();
	await card.getByRole('textbox', { name: 'What is it?' }).fill('Muay Thai class');
	await card
		.getByRole('group', { name: 'Discipline' })
		.getByRole('radio', { name: 'Muay Thai' })
		.check();
	const picker = card.getByRole('group', { name: 'Days', exact: true });
	for (const day of ['Tuesday', 'Thursday'])
		await picker.getByRole('checkbox', { name: day, exact: true }).check();
	await card
		.getByRole('group', { name: 'Time' })
		.getByRole('radio', { name: 'Evening', exact: true })
		.check();
	await captureScreen(page, testInfo, 'journey-onboarding-schedule');
	await moveOn(page, 'continue', 'body');
	await moveOn(page, 'skip', 'review');

	await expect(page.getByTestId('summary-strength').getByTestId('summary-week-one')).toContainText(
		'Week one'
	);
	await expect(page.getByTestId('summary-schedule')).toContainText('5 days a week');
	await captureScreen(page, testInfo, 'journey-onboarding-review');
	await page.getByTestId('step-continue').click();
	await expect(page).toHaveURL('/today');
	await gotoHydrated(page, '/today');

	expect(
		await query(
			'select baselines_unknown, onboarding_completed_at is not null as done from athlete_profiles'
		)
	).toEqual([{ baselines_unknown: true, done: true }]);
	expect(await query('select count(*)::int as lifts from strength_baselines')).toEqual([
		{ lifts: 0 }
	]);
}

// ---- Build ----------------------------------------------------------------------------------

/** Today → Build my program → the preview → Start week 1 (Next Monday), landing on Train. */
async function buildFromToday(page: Page, testInfo: TestInfo, tag = '') {
	await gotoHydrated(page, '/today');
	const cta = page.getByTestId('today-build-cta');
	await expect(page.getByTestId('today-build')).toBeVisible();
	await captureScreen(page, testInfo, `journey-today-build${tag}`);
	await cta.click();
	const preview = page.getByTestId('build-preview');
	await expect(page.getByTestId('build-preview-ready')).toBeVisible({ timeout: 15_000 });
	await expect(
		page.getByTestId('build-start-choice').getByRole('radio', { name: /Next Monday/ })
	).toBeChecked();
	await expect(preview).toHaveAttribute('data-first-planned-day', nextMonday());
	await captureScreen(page, testInfo, `journey-build-preview${tag}`);
	await page.getByTestId('build-start').click();
	await expect(page).toHaveURL('/train');
	await gotoHydrated(page, '/train');
	await expect(page.getByTestId('program-position')).toContainText('Week 1 of');
}

// ---- Reading the stored program -------------------------------------------------------------

interface WeekSession {
	lineage: string;
	date: string;
	discipline: string;
	title: string;
	time_of_day: string | null;
	strength: boolean;
}

/** The current version's sessions in the week from `weekStart`, in day order. */
const weekSessions = (weekStart: string) =>
	query<WeekSession>(
		`select s.lineage_id as lineage, s.scheduled_on::text as date, s.discipline, s.title,
		        s.time_of_day, exists (select 1 from planned_exercises pe where pe.session_id = s.id)
		          as strength
		   from programs p
		   join program_version_weeks vw on vw.version_id = p.current_version_id
		   join program_weeks w on w.id = vw.week_id
		   join planned_sessions s on s.week_id = w.id
		  where w.starts_on = $1
		  order by s.scheduled_on, s.order_in_day`,
		[weekStart]
	);

/** Every working line (top and back-off sets) of the week's main lifts: those with a top set. */
const mainLiftLines = (weekStart: string) =>
	query<{
		lineage: string;
		name: string;
		lift: string | null;
		role: string;
		load_kind: string;
		load_basis: string | null;
	}>(
		`select s.lineage_id as lineage, x.name, pe.baseline_lift as lift, sp.role, sp.load_kind,
		        sp.load_basis
		   from programs p
		   join program_version_weeks vw on vw.version_id = p.current_version_id
		   join program_weeks w on w.id = vw.week_id
		   join planned_sessions s on s.week_id = w.id
		   join planned_exercises pe on pe.session_id = s.id
		   join exercises x on x.id = pe.exercise_id
		   join set_prescriptions sp on sp.planned_exercise_id = pe.id
		  where w.starts_on = $1 and sp.role in ('top', 'back_off')
		    and exists (select 1 from set_prescriptions t
		                 where t.planned_exercise_id = pe.id and t.role = 'top')
		  order by s.scheduled_on, s.order_in_day, pe.position, sp.position`,
		[weekStart]
	);

/** Every version's copy of a session, oldest first: its day and status in each. */
const versionsOf = (lineage: string) =>
	query<{ number: number; scheduled_on: string; status: string; moved_from: string | null }>(
		`select v.number, s.scheduled_on::text, s.status, s.moved_from::text
		   from planned_sessions s
		   join program_version_weeks vw on vw.week_id = s.week_id
		   join program_versions v on v.id = vw.version_id
		  where s.lineage_id = $1
		  order by v.number`,
		[lineage]
	);

// ---- Screens --------------------------------------------------------------------------------

const cards = (page: Page) => page.getByTestId('session-card');
const dayOf = (page: Page, date: string) =>
	page.getByTestId('week-strip').getByRole('radio', { name: new RegExp(`^${longDate(date)}\\b`) });
const exercise = (page: Page, name: string) =>
	page.getByTestId('exercise').filter({ has: page.getByRole('heading', { name, exact: true }) });
const setLines = (page: Page, name: string): Locator =>
	exercise(page, name)
		.getByRole('list', { name: `${name}: sets` })
		.getByRole('listitem');

/** Select `date` on Train's week strip and wait for its sessions. */
async function showDay(page: Page, date: string) {
	await dayOf(page, date).click();
	await expect(page.getByTestId('day-sessions').getByRole('heading').first()).toHaveText(
		longDate(date)
	);
}

test('blank 1RMs: onboarding, a week-1 baseline program built from Today, a move and a one-off swap, all in History and persisted', async ({
	page
}, testInfo) => {
	const errors = trackConsoleErrors(page);
	const weekStart = nextMonday();
	const week = Array.from({ length: 7 }, (_, i) => addDays(mondayOf(weekStart), i));

	await test.step('onboarding through every step, 1RMs blank', async () => {
		await onboardBlank(page, testInfo);
	});

	await test.step('Today → Build → preview → Start with Next Monday', async () => {
		await buildFromToday(page, testInfo);
		expect(await query('select number from program_versions')).toEqual([{ number: 1 }]);
	});

	const sessions = await weekSessions(mondayOf(weekStart));

	await test.step('Train week 1: strength, running and Muay Thai, the classes on Tue/Thu, no avoid', async () => {
		expect(new Set(sessions.map((s) => s.discipline))).toEqual(
			new Set(['strength', 'distance_running', 'muay_thai'])
		);
		const classes = sessions.filter((s) => s.discipline === 'muay_thai');
		expect(classes.map((s) => [weekdayOf(s.date), s.time_of_day])).toEqual([
			['tue', 'evening'],
			['thu', 'evening']
		]);
		for (const date of week) {
			await showDay(page, date);
			const planned = sessions.filter((s) => s.date === date);
			await expect(cards(page).locator('.title')).toHaveText(planned.map((s) => s.title));
			const lines = cards(page).locator('.line');
			await expect(lines.filter({ hasText: /^Muay Thai/ })).toHaveCount(
				classes.some((s) => s.date === date) ? 1 : 0
			);
			if (planned.length === 0) await expect(page.getByTestId('rest-day')).toBeVisible();
		}
		await showDay(page, sessions[0]!.date);
		await captureScreen(page, testInfo, 'journey-train-week-1');
		expect(await audit(page), 'Train week 1').toEqual([]);

		const avoid = (await weekViolations(mondayOf(weekStart))).filter((v) => v.severity === 'avoid');
		expect(avoid.map((v) => v.message)).toEqual([]);
	});

	const strength = sessions.find((s) => s.strength)!;
	const mains = (await mainLiftLines(mondayOf(weekStart))).filter(
		(l) => l.lineage === strength.lineage
	);
	const main = mains[0]!.name;

	await test.step('a strength session works up to RPE-based top sets, with the baseline instructions', async () => {
		// Blank 1RMs: every main lift's top set is RPE-based, so nothing has a load yet.
		const lines = await mainLiftLines(mondayOf(weekStart));
		expect(lines.filter((l) => l.role === 'top').map((l) => l.load_kind)).not.toContain(
			'percent_1rm'
		);
		expect(new Set(lines.filter((l) => l.role === 'top').map((l) => l.load_kind))).toEqual(
			new Set(['rpe_based'])
		);

		await showDay(page, strength.date);
		await cards(page).filter({ hasText: strength.title }).click();
		await expect(page).toHaveURL(`/train/session/${strength.lineage}`);
		await page.waitForLoadState('networkidle');
		await expect(page.getByRole('heading', { level: 1 })).toHaveText(strength.title);
		await expect(page.getByTestId('baseline-callout')).toContainText(BASELINE_CALLOUT.title);
		const top = setLines(page, main).first();
		await expect(top).toContainText(/Work up to a set of \d+ @ RPE \d/);
		await expect(top).toContainText(BASELINE_INSTRUCTION);
		await expect(page.getByTestId('exercise').locator('.load')).toHaveCount(0);
		await captureScreen(page, testInfo, 'journey-session-baseline');
		expect(await audit(page), 'baseline session').toEqual([]);
	});

	// Sunday, or Saturday for a session already on Sunday: a day of its own week, still ahead.
	const target = weekdayOf(strength.date) === 'sun' ? week[5]! : week[6]!;
	const day = (date: string) => WEEKDAY_INFO[weekdayOf(date)];
	let swappedTo = '';

	await test.step('move the session, then swap its main lift for this session only', async () => {
		await page.getByTestId('move-session').click();
		const move = page.getByRole('dialog', { name: 'Move session' });
		await move.getByRole('radio', { name: new RegExp(`^${shortDate(target)}\\b`) }).check();
		await expect(
			move.getByTestId('move-check').or(move.getByTestId('move-warnings')).first()
		).toBeVisible();
		await move.getByLabel(/^Reason/).fill('Work trip');
		await captureScreen(page, testInfo, 'journey-move');
		await move.getByTestId('edit-save').click();
		await expect(toastWith(page, `Moved to ${day(target).label} · version 2`)).toBeVisible();
		await expect(move).toBeHidden();
		await expect(page.getByTestId('session-status')).toHaveText(
			`Moved from ${day(strength.date).short}`
		);

		await page.getByRole('button', { name: `Swap ${main}`, exact: true }).click();
		const swap = page.getByRole('dialog', { name: 'Swap exercise' });
		const options = swap.getByRole('radio');
		await expect(options.first()).toBeVisible();
		await expect(swap.getByRole('switch', { name: /^Never prescribe/ })).not.toBeChecked();
		swappedTo = await options
			.first()
			.evaluate((el) => el.closest('label')?.querySelector('.label')?.textContent?.trim() ?? '');
		expect(swappedTo).not.toBe('');
		await options.first().check();
		await captureScreen(page, testInfo, 'journey-swap');
		await swap.getByTestId('edit-save').click();
		await expect(
			toastWith(page, `Swapped for ${swappedTo}, this session only · version 3`)
		).toBeVisible();
		await expect(swap).toBeHidden();
		await expect(exercise(page, swappedTo).getByTestId('exercise-swapped')).toHaveText(
			'This session only'
		);
		await expect(exercise(page, main)).toHaveCount(0);
	});

	const versionCards = (p: Page) => p.getByTestId('version');
	const expectHistory = async () => {
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('History');
		await expect(versionCards(page)).toHaveCount(3);
		const links = page.getByTestId('version-link');
		await expect(links.nth(0)).toContainText(/Version 3\s*Current/);
		await expect(links.nth(0)).toContainText(`Swapped ${main} for ${swappedTo}`);
		await expect(links.nth(1)).toContainText(
			`Moved ${strength.title} from ${day(strength.date).short} to ${day(target).short}`
		);
		await expect(links.nth(2)).toContainText('Version 1');
		const why = (n: number) => versionCards(page).nth(n).getByTestId('decision');
		await expect(why(0)).toHaveCount(1);
		await expect(why(0)).toContainText(`You swapped ${main} for ${swappedTo}`);
		await expect(why(0)).toContainText('this session only');
		await expect(why(1)).toHaveCount(1);
		await expect(why(1)).toContainText(
			`You moved ${strength.title} from ${day(strength.date).short} to ${day(target).short}. Work trip.`
		);
		expect(await why(2).count()).toBeGreaterThan(3);
	};

	await test.step('History lists the move and the swap with their why', async () => {
		await page.getByTestId('back-to-train').click();
		await expect(page).toHaveURL(/\/train(\?|$)/);
		await page.getByTestId('open-history').click();
		await expect(page).toHaveURL('/train/history');
		await page.waitForLoadState('networkidle');
		await expectHistory();
		await captureScreen(page, testInfo, 'journey-history');
		expect(await audit(page), 'History').toEqual([]);
	});

	await test.step('reloaded, Train, the session and History keep it all, as Postgres does', async () => {
		await gotoHydrated(page, '/train/history');
		await expectHistory();

		await gotoHydrated(page, '/train');
		await showDay(page, target);
		await expect(cards(page).filter({ hasText: strength.title })).toContainText(
			`Moved from ${day(strength.date).short}`
		);
		await showDay(page, strength.date);
		await expect(cards(page).filter({ hasText: strength.title })).toHaveCount(0);

		await gotoHydrated(page, `/train/session/${strength.lineage}`);
		await expect(page.getByTestId('session-status')).toHaveText(
			`Moved from ${day(strength.date).short}`
		);
		await expect(exercise(page, swappedTo).getByTestId('exercise-swapped')).toHaveText(
			'This session only'
		);
		await expect(exercise(page, main)).toHaveCount(0);

		expect(
			await query('select number, created_by from program_versions order by number')
		).toMatchObject([
			{ number: 1 },
			{ number: 2, created_by: 'owner' },
			{ number: 3, created_by: 'owner' }
		]);
		expect(
			await query(
				`select v.number, d.kind from programming_decisions d
				   join program_versions v on v.id = d.version_id
				  where d.decided_by = 'owner' order by d.id`
			)
		).toEqual([
			{ number: 2, kind: 'session_moved' },
			{ number: 3, kind: 'exercise_swapped' }
		]);
		expect(await versionsOf(strength.lineage)).toEqual([
			{ number: 1, scheduled_on: strength.date, status: 'planned', moved_from: null },
			{ number: 2, scheduled_on: target, status: 'moved', moved_from: strength.date },
			{ number: 3, scheduled_on: target, status: 'moved', moved_from: strength.date }
		]);
		expect(
			await query(
				`select v.number, x.name, f.name as was, pe.substitution_reason as reason
				   from planned_sessions s
				   join program_version_weeks vw on vw.week_id = s.week_id
				   join program_versions v on v.id = vw.version_id
				   join planned_exercises pe on pe.session_id = s.id
				   join exercises x on x.id = pe.exercise_id
				   join exercises f on f.id = pe.substituted_from_exercise_id
				  where s.lineage_id = $1`,
				[strength.lineage]
			)
		).toEqual([{ number: 3, name: swappedTo, was: main, reason: 'situational' }]);
		// A one-off swap never becomes a preference.
		expect(await query('select exercise from exercise_preferences')).toEqual([]);
	});

	expect(errors).toEqual([]);
});

// ---- Journey 2: measured 1RMs ---------------------------------------------------------------

/** The generator's 'powerlifter' scenario, through the profile actions, then onboarding done. */
async function powerlifterProfile(request: APIRequestContext) {
	const start = nextMonday();
	await profileAction(request, '/profile/goals?/saveGoal', {
		kind: 'event',
		title: 'Spring meet',
		disciplines: ['powerlifting'],
		eventType: 'Powerlifting meet',
		eventDate: addDays(start, 7 * 15 + 5)
	});
	await profileAction(request, '/profile/experience?/save', {
		entries: [{ discipline: 'powerlifting', level: 'advanced' }]
	});
	const tested = (lift: string, value: number) => ({
		lift,
		source: 'tested',
		value,
		unit: 'kg',
		achievedOn: addDays(start, -21)
	});
	await profileAction(request, '/profile/strength?/save', {
		unknown: false,
		lifts: [tested('back_squat', 180), tested('bench_press', 120), tested('deadlift', 220)]
	});
	await profileAction(request, '/profile/equipment?/save', {
		gymType: 'strength',
		equipment: [],
		homeEquipment: [],
		notes: null
	});
	await profileAction(request, '/profile/schedule?/save', {
		daysPerWeek: 4,
		availableDays: ['mon', 'tue', 'thu', 'fri', 'sat'],
		preferredTimes: ['morning'],
		sessionMinutes: 90,
		commitments: []
	});
	const finish = await request.post('/onboarding/review?/complete', {
		headers: { ...SAME_ORIGIN, accept: 'application/json', 'x-sveltekit-action': 'true' },
		multipart: { payload: '{}' }
	});
	expect(await finish.json()).toMatchObject({ type: 'redirect', location: '/today' });
}

test('measured 1RMs: every main lift is a percentage of the measured 1RM with a load in kg, never RPE alone', async ({
	page,
	request
}, testInfo) => {
	const errors = trackConsoleErrors(page);
	const weekStart = mondayOf(nextMonday());

	await test.step('profile through the profile actions, then Build from Today', async () => {
		await powerlifterProfile(request);
		await buildFromToday(page, testInfo, '-measured');
	});

	const lines = await mainLiftLines(weekStart);

	await test.step('in Postgres: squat, bench and deadlift, each line a share of the measured 1RM', async () => {
		expect(new Set(lines.map((l) => l.lift))).toEqual(
			new Set(['back_squat', 'bench_press', 'deadlift'])
		);
		for (const line of lines) {
			expect(line, `${line.name} ${line.role}`).toMatchObject({
				load_kind: 'percent_1rm',
				load_basis: 'measured'
			});
		}
	});

	await test.step('on the screen: every main lift line has its kg load and says what it is a share of', async () => {
		const first = lines[0]!.lineage;
		await gotoHydrated(page, `/train/session/${first}`);
		for (const name of new Set(lines.filter((l) => l.lineage === first).map((l) => l.name))) {
			const sets = setLines(page, name);
			const count = lines.filter((l) => l.lineage === first && l.name === name).length;
			await expect(sets).toHaveCount(count);
			await expect(sets.locator('.load')).toHaveCount(count);
			for (const set of await sets.all()) {
				await expect(set.locator('.load')).toHaveText(/^\d+(\.\d+)? kg$/);
				await expect(set).toContainText('% of your measured 1RM');
			}
		}
		await captureScreen(page, testInfo, 'journey-session-measured');
		expect(await audit(page), 'measured session').toEqual([]);
	});

	expect(errors).toEqual([]);
});

test.describe('in a desktop window', () => {
	test.use(DESKTOP);

	test('the built program’s Train week, session and History sit centred beside the rail', async ({
		page,
		request
	}, testInfo) => {
		await powerlifterProfile(request);
		await buildFromToday(page, testInfo, '-desktop');
		const [first] = await mainLiftLines(mondayOf(nextMonday()));
		for (const [path, name] of [
			['/train', 'journey-train-week-1-desktop'],
			[`/train/session/${first!.lineage}`, 'journey-session-measured-desktop'],
			['/train/history', 'journey-history-desktop']
		] as const) {
			await gotoHydrated(page, path);
			await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
			await expectMainCentred(page);
			await expectNoSideScroll(page);
			await captureScreen(page, testInfo, name);
		}
	});
});
