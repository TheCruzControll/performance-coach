/**
 * The exercise quick actions on /workout (ExerciseActionsSheet, AlternativeList and Fix in
 * fix/structure.ts), against the real server and the server's own kit (startFromKit):
 * - Machine unavailable swaps for this session only: the substitute logs as itself, never with
 *   the planned exercise's load, shows its own last session inline (fetched and attached), or
 *   'No previous sets on this device' offline; SQL holds today's substitution only.
 * - I don't like this exercise asks first: Cancel changes nothing; confirmed, the dislike is a
 *   preference, the plan swaps from today, and Profile → Exercises lists it.
 * - An assisted alternative logs assistance; with nothing that fits, the sheet says why and offers
 *   Skip exercise; Skip exercise skips what is left and moves on; a refused swap or dislike is
 *   fixed from the sync sheet.
 * - axe in both themes, the screens, and the desktop dialog with its keyboard and hover.
 * A refused swap is injected naming an exercise id the server cannot know (not a uuid), so the
 * schemas refuse it at payload.toExerciseId; a refused dislike names the plank, which is no
 * alternative to the leg press, so the plan's swap refuses it.
 * Serial: programs, workouts and the profile are the one owner's.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { Mutation, StrengthKit, SyncResponse } from '../src/lib/domain/workout';
import { createMutation } from '../src/lib/domain/workout/mutations';
import { DESKTOP, expectNoSideScroll } from './desktop';
import { PROGRAM_TZ, type SeededProgram } from './program-support';
import {
	captureScreen,
	gotoHydrated,
	profileAction,
	query,
	resetTrainingProfile,
	SAME_ORIGIN
} from './support';
import { injectMutation, readOutbox } from './workout-support';
import { startFromKit } from './workout-start-support';

test.use({ timezoneId: PROGRAM_TZ });

test.beforeEach(async () => {
	await resetTrainingProfile();
});

const DAY = 24 * 60 * 60 * 1000;

const main = (page: Page) => page.getByTestId('workout-main');
const heading = (page: Page) =>
	main(page).getByTestId('exercise').getByRole('heading', { level: 2 });
const card = (page: Page) => main(page).getByTestId('exercise');
const sheet = (page: Page) => page.getByTestId('exercise-actions-sheet');
const logger = (page: Page) => page.getByTestId('set-logger');
const loadField = (page: Page) => logger(page).getByTestId('logger-load');
const option = (page: Page, name: string) =>
	sheet(page)
		.getByTestId('alternative')
		.filter({ has: page.getByText(name, { exact: true }) });

/** The id of the catalogue exercise with this key. */
async function exerciseId(key: string): Promise<string> {
	const [row] = await query<{ id: string }>(
		'select id from exercises where owner_id is null and key = $1',
		[key]
	);
	if (!row) throw new Error(`no catalogue exercise '${key}'`);
	return row.id;
}

/** Next until the card shows `name`. */
async function goTo(page: Page, name: string) {
	for (let i = 0; i < 6 && (await heading(page).textContent())?.trim() !== name; i++) {
		await main(page).getByTestId('exercise-next').click();
	}
	await expect(heading(page)).toHaveText(name);
}

/** Opens the card's quick actions and picks one of them. */
async function act(page: Page, action: string) {
	await card(page).getByTestId('exercise-actions').click();
	await expect(sheet(page)).toBeVisible();
	await sheet(page).getByTestId(`action-${action}`).click();
}

/**
 * A finished ad-hoc workout yesterday with one set of `key`, through the real sync API: that
 * exercise's last session.
 */
async function history(page: Page, key: string, weight: number, reps: number) {
	const workoutId = crypto.randomUUID();
	const at = (minutes: number) => new Date(Date.now() - DAY + minutes * 60_000).toISOString();
	const mutations: Mutation[] = [
		createMutation('workout.start', {
			workoutId,
			at: at(0),
			payload: {
				kind: 'strength',
				title: 'Legs',
				sessionType: 'strength',
				discipline: 'strength',
				plannedSessionId: null,
				plannedLineage: null,
				programId: null
			}
		}),
		createMutation('set.log', {
			workoutId,
			at: at(5),
			payload: {
				position: 1,
				plannedLineage: null,
				setIndex: 1,
				exerciseId: await exerciseId(key),
				reps,
				seconds: null,
				metres: null,
				weight,
				assistance: null,
				unit: 'kg',
				rpe: 8,
				missedReps: 0,
				isWarmup: false,
				isExtra: false
			}
		}),
		createMutation('workout.finish', { workoutId, at: at(30), payload: {} })
	];
	const response = await page.request.post('/api/workouts/sync', {
		headers: SAME_ORIGIN,
		data: { v: 1, mutations }
	});
	expect(response.status()).toBe(200);
	const { results } = (await response.json()) as SyncResponse;
	expect(results.map((r) => r.status)).toEqual(['applied', 'applied', 'applied']);
}

const substitutions = (workoutId: string) =>
	query<{
		id: string;
		reason: string;
		position: number;
		lineage: string | null;
		from_key: string;
		to_key: string;
	}>(
		`select s.client_mutation_id as id, s.reason, s.exercise_position as position,
		        s.planned_exercise_lineage_id as lineage, f.key as from_key, t.key as to_key
		   from workout_substitutions s
		   join workouts w on w.id = s.workout_id
		   join exercises f on f.id = s.from_exercise_id
		   join exercises t on t.id = s.to_exercise_id
		  where w.client_id = $1 and s.deleted_at is null`,
		[workoutId]
	);

const preferences = () =>
	query<{ exercise: string; sentiment: string; source: string }>(
		'select exercise, sentiment, source from exercise_preferences order by exercise'
	);

const versions = async () =>
	(await query<{ n: number }>('select max(number)::int as n from program_versions'))[0]!.n;

/** Each version's exercise names in a session, oldest first. */
const exercisesIn = (lineage: string) =>
	query<{ number: number; names: string[] }>(
		`select v.number, array_agg(x.name order by pe.position) as names
		   from planned_sessions s
		   join program_version_weeks vw on vw.week_id = s.week_id
		   join program_versions v on v.id = vw.version_id
		   join planned_exercises pe on pe.session_id = s.id
		   join exercises x on x.id = pe.exercise_id
		  where s.lineage_id = $1
		  group by v.number
		  order by v.number`,
		[lineage]
	);

/** Next week's 'Lower body & pull'. */
const nextWeek = (program: SeededProgram) =>
	program.sessions.filter((s) => s.title === 'Lower body & pull')[1]!;

const synced = (page: Page) => expect.poll(() => readOutbox(page), { timeout: 15_000 }).toEqual([]);

/** axe in the dark and the light theme, the page as it is. */
async function audit(page: Page, what: string) {
	for (const theme of ['dark', 'light']) {
		await page.evaluate((t) => {
			if (t === 'light') document.documentElement.dataset.theme = t;
			else delete document.documentElement.dataset.theme;
		}, theme);
		await page.waitForFunction(() =>
			document
				.getAnimations()
				.every(
					(a) => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity
				)
		);
		const { violations } = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();
		const found = violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
		expect(found, `${what}, ${theme}`).toEqual([]);
	}
	await page.evaluate(() => delete document.documentElement.dataset.theme);
}

/** Leg press's last session, 200 kg × 10, for the kit to carry. */
const legPressHistory = (page: Page) => () => history(page, 'leg_press', 200, 10);

test.describe('machine unavailable', () => {
	test('swaps for this session only: the substitute logs as itself, never with the planned load', async ({
		page,
		request
	}, testInfo) => {
		const { workoutId, kit, program } = await startFromKit(page, request, {
			before: legPressHistory(page)
		});
		await goTo(page, 'Leg press');
		await expect(card(page).getByTestId('exercise-previous')).toContainText('200 kg × 10');
		await expect(loadField(page).getByRole('spinbutton')).toHaveValue(/^200/);

		await act(page, 'machine_unavailable');
		await expect(sheet(page).getByRole('heading', { name: 'Swap for this session' })).toBeVisible();
		await expect(option(page, 'Hack squat')).toContainText(/Needs /);
		await captureScreen(page, testInfo, 'workout-substitute');
		await option(page, 'Hack squat').click();
		await expect(sheet(page)).toBeHidden();

		await expect(heading(page)).toHaveText('Hack squat');
		await expect(card(page).getByTestId('slot-state')).toHaveText(
			/Swapped for this session\s*Instead of Leg press/
		);
		// Its own last session: none, so nothing to start from but the RPE.
		await expect(card(page).getByTestId('exercise-previous')).toHaveText('Last time · none yet');
		await expect(card(page)).not.toContainText('200 kg');
		await expect(loadField(page).getByRole('spinbutton')).not.toHaveValue(/^200/);
		await expect(loadField(page)).toContainText(/Pick a load that feels like RPE|Enter the weight/);

		await loadField(page).getByRole('spinbutton').fill('120');
		await loadField(page).getByRole('spinbutton').press('Enter');
		await logger(page).getByTestId('complete-set').click();
		await synced(page);

		const hack = await exerciseId('hack_squat');
		const sets = await query<{ exercise_id: string; weight: number }>(
			`select r.exercise_id, r.weight::float8 as weight
			   from set_records r join workouts w on w.id = r.workout_id
			  where w.client_id = $1 and r.exercise_position = 2`,
			[workoutId]
		);
		expect(sets).toEqual([{ exercise_id: hack, weight: 120 }]);
		const legPress = (kit as StrengthKit).exercises.find((e) => e.exercise.key === 'leg_press')!;
		expect(await substitutions(workoutId)).toEqual([
			{
				id: expect.any(String),
				reason: 'equipment_unavailable',
				position: legPress.position,
				lineage: legPress.plannedLineage,
				from_key: 'leg_press',
				to_key: 'hack_squat'
			}
		]);
		expect(await preferences()).toEqual([]);
		expect(await versions()).toBe(1);
		const week2 = await exercisesIn(nextWeek(program).lineage);
		expect(week2).toHaveLength(1);
		expect(week2[0]!.names).toContain('Leg press');
	});

	test('a load entered for the planned exercise never carries into the substitute', async ({
		page,
		request
	}) => {
		await startFromKit(page, request, { before: legPressHistory(page) });
		await goTo(page, 'Leg press');
		await loadField(page).getByRole('spinbutton').fill('230');
		await loadField(page).getByRole('spinbutton').press('Enter');
		await expect(loadField(page).getByRole('spinbutton')).toHaveValue(/^230/);

		await act(page, 'machine_unavailable');
		await option(page, 'Hack squat').click();
		await expect(heading(page)).toHaveText('Hack squat');
		await expect(loadField(page).getByRole('spinbutton')).not.toHaveValue(/^230/);
	});

	test('a substitute’s set rows and logger never show the planned load; logged sets stay', async ({
		page,
		request
	}) => {
		await startFromKit(page, request);
		await expect(heading(page)).toHaveText('Back squat');
		await loadField(page).getByRole('spinbutton').fill('100');
		await loadField(page).getByRole('spinbutton').press('Enter');
		await logger(page).getByTestId('complete-set').click();
		await expect(card(page).getByTestId('set').nth(1)).toContainText('≈ 97.5 kg');
		await expect(logger(page)).toContainText('≈ 97.5 kg');

		await act(page, 'machine_unavailable');
		await sheet(page).getByTestId('alternative').first().click();
		await expect(sheet(page)).toBeHidden();
		await expect(heading(page)).not.toHaveText('Back squat');
		await expect(card(page).getByTestId('set').first()).toContainText('100 kg ×');
		await expect(card(page).getByTestId('set').filter({ hasText: '≈' })).toHaveCount(0);
		await expect(logger(page)).not.toContainText('≈');
	});

	test('shows the substitute’s own last session inline, attached so a reload keeps it', async ({
		page,
		request
	}) => {
		await startFromKit(page, request, {
			before: async () => {
				await legPressHistory(page)();
				await history(page, 'hack_squat', 140, 8);
			}
		});
		await goTo(page, 'Leg press');
		await act(page, 'machine_unavailable');
		await option(page, 'Hack squat').click();

		const previous = card(page).getByTestId('exercise-previous');
		await expect(previous).toContainText(/Last time · (yesterday|today|\d+ days ago)/);
		await expect(previous).toContainText('140 kg × 8');
		await expect(previous).not.toContainText('200 kg');
		await expect(loadField(page).getByRole('spinbutton')).toHaveValue(/^140/);

		await page.reload();
		await expect(page.locator('main#main[data-store]')).toBeAttached();
		await expect(heading(page)).toHaveText('Hack squat');
		await expect(card(page).getByTestId('exercise-previous')).toContainText('140 kg × 8');
	});

	test('offline, says there are no previous sets here, and the swap syncs once back online', async ({
		page,
		context,
		request
	}) => {
		const { workoutId } = await startFromKit(page, request, {
			before: () => history(page, 'hack_squat', 140, 8)
		});
		await goTo(page, 'Leg press');
		// The sheet's code is loaded online; a device offline from the start has it precached.
		await card(page).getByTestId('exercise-actions').click();
		await expect(sheet(page)).toBeVisible();
		await context.setOffline(true);
		await sheet(page).getByTestId('action-machine_unavailable').click();
		await option(page, 'Hack squat').click();
		await expect(heading(page)).toHaveText('Hack squat');
		await expect(card(page).getByTestId('exercise-previous')).toHaveText(
			'No previous sets on this device'
		);
		await expect
			.poll(async () => (await readOutbox(page)).map((e) => e.envelope.type))
			.toEqual(['exercise.substitute']);

		await context.setOffline(false);
		await synced(page);
		const rows = await substitutions(workoutId);
		expect(rows.map((r) => [r.reason, r.to_key])).toEqual([
			['equipment_unavailable', 'hack_squat']
		]);
	});
});

test.describe("I don't like this exercise", () => {
	test('asks first: Cancel changes nothing', async ({ page, request }, testInfo) => {
		const { workoutId } = await startFromKit(page, request);
		await goTo(page, 'Leg press');
		await act(page, 'dislike');
		await option(page, 'Hack squat').click();
		await expect(
			sheet(page).getByRole('heading', { name: "Don't prescribe Leg press again?" })
		).toBeVisible();
		await expect(sheet(page).getByTestId('dislike-confirmation')).toHaveText(
			"Today you'll do Hack squat, and your plan uses it from today. You can change this in Profile → Exercises."
		);
		await captureScreen(page, testInfo, 'workout-dislike-confirm');
		await sheet(page).getByTestId('dislike-cancel').click();
		await expect(sheet(page)).toBeHidden();

		await expect(heading(page)).toHaveText('Leg press');
		await expect(card(page).getByTestId('slot-state')).toHaveCount(0);
		expect(await readOutbox(page)).toEqual([]);
		expect(await substitutions(workoutId)).toEqual([]);
		expect(await preferences()).toEqual([]);
	});

	test('confirmed: a lasting dislike, the plan swaps from today, and Profile lists it', async ({
		page,
		request
	}) => {
		const { workoutId, program } = await startFromKit(page, request);
		await goTo(page, 'Leg press');
		await act(page, 'dislike');
		await option(page, 'Hack squat').click();
		await sheet(page).getByTestId('dislike-confirm').click();
		await expect(sheet(page)).toBeHidden();
		await expect(heading(page)).toHaveText('Hack squat');
		await expect(card(page).getByTestId('slot-state')).toHaveText(
			/Won't be prescribed again\s*Instead of Leg press/
		);
		await synced(page);

		expect(await preferences()).toEqual([
			{ exercise: 'Leg press', sentiment: 'dislike', source: 'workout' }
		]);
		expect((await substitutions(workoutId)).map((r) => r.reason)).toEqual(['dislike']);
		expect(await versions()).toBe(2);
		const week2 = nextWeek(program);
		const latest = (await exercisesIn(week2.lineage)).at(-1)!;
		expect(latest.number).toBe(2);
		expect(latest.names).toContain('Hack squat');
		expect(latest.names).not.toContain('Leg press');

		await gotoHydrated(page, `/train/session/${week2.lineage}`);
		await expect(page.getByRole('heading', { name: 'Hack squat', exact: true })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Leg press', exact: true })).toHaveCount(0);
		await gotoHydrated(page, '/profile/exercises');
		await expect(page.getByTestId('dislikes')).toContainText('Leg press');
	});
});

test.describe('other cases', () => {
	test('an assisted alternative asks for assistance and stores it, with no weight or e1RM', async ({
		page,
		request
	}) => {
		const { workoutId } = await startFromKit(page, request);
		await goTo(page, 'Pull-up');
		await act(page, 'suggest_alternative');
		await expect(sheet(page).getByRole('heading', { name: 'Alternatives' })).toBeVisible();
		await option(page, 'Assisted pull-up').click();
		await expect(heading(page)).toHaveText('Assisted pull-up');

		const assistance = logger(page).getByRole('spinbutton', { name: /Assistance/ });
		await expect(assistance).toBeVisible();
		await expect(logger(page).getByRole('spinbutton', { name: /^Weight/ })).toHaveCount(0);
		await assistance.fill('20');
		await assistance.press('Enter');
		await logger(page).getByTestId('complete-set').click();
		await synced(page);

		const rows = await query<{ assistance: number; weight: number | null; e1rm: number | null }>(
			`select r.assistance::float8 as assistance, r.weight::float8 as weight,
			        r.e1rm_kg::float8 as e1rm
			   from set_records r
			   join workouts w on w.id = r.workout_id
			   join exercises x on x.id = r.exercise_id
			  where w.client_id = $1 and x.key = 'assisted_pull_up'`,
			[workoutId]
		);
		expect(rows).toEqual([{ assistance: 20, weight: null, e1rm: null }]);
	});

	test('with bodyweight only nothing fits the power clean: why, and Skip exercise', async ({
		page,
		request
	}, testInfo) => {
		await profileAction(request, '/profile/equipment?/save', {
			gymType: 'none',
			equipment: [],
			homeEquipment: [],
			notes: null
		});
		await startFromKit(page, request, {
			fixture: 'hybrid',
			pick: (p) => p.sessions.find((s) => s.title === 'Full body')
		});
		await goTo(page, 'Power clean');
		await act(page, 'suggest_alternative');
		const empty = sheet(page).getByTestId('alternatives-empty');
		await expect(empty).toContainText('Nothing fits right now');
		await expect(empty.getByTestId('alternatives-blocked')).toContainText(/Needs/);
		await expect(sheet(page).getByTestId('alternative')).toHaveCount(0);
		await captureScreen(page, testInfo, 'workout-substitute-empty');
		await audit(page, 'the empty alternatives');

		await empty.getByTestId('empty-skip').click();
		await expect(sheet(page)).toBeHidden();
		await expect(heading(page)).not.toHaveText('Power clean');
	});

	test('Skip exercise skips the remaining sets and moves on', async ({ page, request }) => {
		const { workoutId } = await startFromKit(page, request);
		await expect(heading(page)).toHaveText('Back squat');
		await act(page, 'skip');
		await expect(sheet(page)).toBeHidden();
		await expect(heading(page)).toHaveText('Leg press');
		await synced(page);
		const rows = await query<{ skipped: boolean }>(
			`select r.is_skipped as skipped
			   from set_records r join workouts w on w.id = r.workout_id
			  where w.client_id = $1 and r.exercise_position = 1`,
			[workoutId]
		);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((r) => r.skipped)).toBe(true);
		await main(page).getByTestId('exercise-prev').click();
		await expect(card(page).getByTestId('slot-state')).toHaveText('Skipped');
		await expect(card(page).getByTestId('exercise-actions')).toHaveCount(0);
	});

	test('a refused swap: Fix reopens the alternatives with why, and the choice lands once', async ({
		page,
		request
	}) => {
		const { workoutId, kit } = await startFromKit(page, request);
		const legPress = (kit as StrengthKit).exercises.find((e) => e.exercise.key === 'leg_press')!;
		const refused = createMutation('exercise.substitute', {
			workoutId,
			at: new Date().toISOString(),
			payload: {
				position: legPress.position,
				plannedLineage: legPress.plannedLineage,
				fromExerciseId: legPress.exercise.id,
				toExerciseId: 'not-an-exercise',
				reason: 'owner_choice'
			}
		});
		await injectMutation(page, refused);
		await fix(page);

		const fixSheet = page.getByTestId('substitute-fix');
		await expect(fixSheet).toBeVisible();
		await expect(fixSheet.getByTestId('alternatives-error')).toBeVisible();
		await fixSheet
			.getByTestId('alternative')
			.filter({ has: page.getByText('Hack squat', { exact: true }) })
			.click();
		await synced(page);
		const rows = await substitutions(workoutId);
		expect(rows).toEqual([
			expect.objectContaining({ id: refused.id, reason: 'owner_choice', to_key: 'hack_squat' })
		]);
	});

	test("a refused dislike: 'Just swap it today' lands as today's swap, with no preference", async ({
		page,
		request
	}) => {
		const { workoutId, kit } = await startFromKit(page, request);
		const legPress = (kit as StrengthKit).exercises.find((e) => e.exercise.key === 'leg_press')!;
		// The plank is no alternative to the leg press: the plan's swap refuses it.
		const refused = createMutation('exercise.dislike', {
			workoutId,
			at: new Date().toISOString(),
			payload: {
				position: legPress.position,
				plannedLineage: legPress.plannedLineage,
				fromExerciseId: legPress.exercise.id,
				toExerciseId: await exerciseId('plank'),
				note: null
			}
		});
		await injectMutation(page, refused);
		await fix(page, 'Just swap it today');
		await synced(page);

		expect(await substitutions(workoutId)).toEqual([
			expect.objectContaining({ id: refused.id, reason: 'situational', to_key: 'plank' })
		]);
		expect(await preferences()).toEqual([]);
		expect(await versions()).toBe(1);
	});

	test('the sheet passes axe in dark and light, with its alternatives open', async ({
		page,
		request
	}) => {
		await startFromKit(page, request);
		await goTo(page, 'Leg press');
		await card(page).getByTestId('exercise-actions').click();
		await expect(sheet(page)).toBeVisible();
		await audit(page, 'the quick actions');
		await sheet(page).getByTestId('action-suggest_alternative').click();
		await expect(sheet(page).getByTestId('alternative').first()).toBeVisible();
		await audit(page, 'the alternatives');
	});
});

/** Opens the sync sheet and taps the refused change's Fix (or its one-tap rewrite). */
async function fix(page: Page, label = 'Fix') {
	const pill = page.getByTestId('sync-pill');
	await expect(pill).toHaveText('1 needs attention', { timeout: 15_000 });
	await pill.click();
	const issue = page.getByTestId('sync-sheet').getByTestId('sync-issue');
	await expect(issue).toHaveCount(1);
	await expect(issue.getByTestId('fix-change')).toHaveText(label);
	await issue.getByTestId('fix-change').click();
}

test.describe('desktop', () => {
	test.use(DESKTOP);

	test('the sheet is a dialog: options by Tab and arrows, with hover and focus states', async ({
		page,
		request
	}, testInfo) => {
		await startFromKit(page, request);
		await goTo(page, 'Leg press');
		await act(page, 'suggest_alternative');
		const dialog = page.getByRole('dialog', { name: 'Alternatives' });
		await expect(dialog).toBeVisible();
		const options = sheet(page).getByTestId('alternative');
		await expect(options.first()).toBeFocused();
		const count = await options.count();
		expect(count).toBeGreaterThan(1);

		await page.keyboard.press('Tab');
		await expect(options.nth(1)).toBeFocused();
		await page.keyboard.press('ArrowUp');
		await expect(options.first()).toBeFocused();
		await page.keyboard.press('ArrowDown');
		await expect(options.nth(1)).toBeFocused();
		await page.keyboard.press('End');
		await expect(options.nth(count - 1)).toBeFocused();
		await page.keyboard.press('Home');
		await expect(options.first()).toBeFocused();
		// A keyboard focus shows a ring on every option.
		for (let i = 0; i < count; i++) {
			if (i > 0) await page.keyboard.press('ArrowDown');
			await expect(options.nth(i)).toHaveCSS('outline-style', 'solid');
		}

		// Hover strengthens the option's border.
		const last = options.nth(count - 1);
		await page.keyboard.press('Home');
		const before = await last.evaluate((el) => getComputedStyle(el).borderTopColor);
		await last.hover();
		await expect
			.poll(() => last.evaluate((el) => getComputedStyle(el).borderTopColor))
			.not.toBe(before);
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'workout-substitute-desktop');
	});
});
