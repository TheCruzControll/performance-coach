/**
 * 'This hurts' on /workout (PainSheet, opened from ExerciseActionsSheet; Fix in fix/pain.ts),
 * against the real server and the server's own kit (startFromKit):
 * - what to do comes first: Stop, then the gentler options, then End the workout here, with where
 *   it hurts, how bad and the note folded under 'Add details (optional)'; Stop is in view on a
 *   phone as the sheet opens
 * - the gentler options are the kit's for the chosen area: none that loads the lower back on the
 *   Romanian deadlift, none that bends the knee deep on the leg press; with none, Stop is offered
 * - Stop reads Stopped and stores the report; a gentler option swaps with reason pain; severe
 *   offers End the workout here, which opens the finish
 * - the sheet's words never suggest carrying on through pain and name no diagnosis
 * - Profile → Injuries opens, and the workout stays on the device
 * - a refused report (a 600-character note) is fixed from the sync sheet and lands once
 * - offline, it waits in the outbox and syncs once
 * - axe in both themes, the screens, and the desktop dialog with its keyboard and hover
 * - in Graphite 2004, the choices as one box, axe in both themes.
 * Serial: programs, workouts and the profile are the one owner's.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { KitExercise, StrengthKit } from '../src/lib/domain/workout';
import { PAIN_COPY } from '../src/lib/domain/workout/copy';
import { createMutation } from '../src/lib/domain/workout/mutations';
import { DESKTOP, expectNoSideScroll } from './desktop';
import { PROGRAM_TZ, seedProgram } from './program-support';
import { captureScreen, query, resetTrainingProfile } from './support';
import {
	gotoWorkout,
	injectMutation,
	readOutbox,
	readWorkout,
	seedWorkout
} from './workout-support';
import { startFromKit } from './workout-start-support';

test.use({ timezoneId: PROGRAM_TZ });

test.beforeEach(async () => {
	await resetTrainingProfile();
});

/** What the pain copy must never say, and the words that name a diagnosis (copy.test.ts). */
const PUSH_THROUGH =
	/push (through|on)|work through|power through|tough it out|keep going|no pain,? no gain|ignore (the )?pain|shake it off/i;
const DIAGNOSIS = /diagnos|tendin|tear|sprain|strain|fracture|impinge/i;

const main = (page: Page) => page.getByTestId('workout-main');
const card = (page: Page) => main(page).getByTestId('exercise');
const heading = (page: Page) => card(page).getByRole('heading', { level: 2 });
const pain = (page: Page) => page.getByTestId('pain-sheet');
const options = (page: Page) => pain(page).getByTestId('alternative');
const area = (page: Page, label: string) =>
	pain(page).getByTestId('pain-area').getByRole('radio', { name: label, exact: true });
const severity = (page: Page, label: string) =>
	pain(page)
		.getByTestId('pain-severity')
		.getByRole('radio', { name: new RegExp(`^${label}`) });

/** Next until the card shows `name`. */
async function goTo(page: Page, name: string) {
	for (let i = 0; i < 6 && (await heading(page).textContent())?.trim() !== name; i++) {
		await main(page).getByTestId('exercise-next').click();
	}
	await expect(heading(page)).toHaveText(name);
}

/** Opens the card's quick actions, then This hurts. */
async function hurts(page: Page) {
	await card(page).getByTestId('exercise-actions').click();
	await page.getByTestId('exercise-actions-sheet').getByTestId('action-pain').click();
	await expect(pain(page)).toBeVisible();
	await expect(pain(page).getByTestId('pain-stop')).toBeVisible();
}

const toggle = (page: Page) => pain(page).getByTestId('pain-details-toggle');

/** Unfolds 'Add details (optional)': where it hurts, how bad and the note. */
async function details(page: Page) {
	await toggle(page).click();
	await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
}

/** Each option's text starts with its name. */
const names = (list: readonly { exercise: { name: string } }[]) =>
	list.map((o) => new RegExp('^' + o.exercise.name.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&')));

const entry = (kit: unknown, key: string): KitExercise =>
	(kit as StrengthKit).exercises.find((e) => e.exercise.key === key)!;

const reports = (workoutId: string) =>
	query<{
		id: string;
		area: string | null;
		severity: string | null;
		action: string;
		note: string | null;
		exercise: string;
		substitution: string | null;
	}>(
		`select p.id, p.body_area as area, p.severity, p.action, p.note, x.key as exercise,
		        p.substitution_client_id as substitution
		   from pain_reports p
		   join workouts w on w.id = p.workout_id
		   join exercises x on x.id = p.exercise_id
		  where w.client_id = $1 and p.deleted_at is null`,
		[workoutId]
	);

const synced = (page: Page) => expect.poll(() => readOutbox(page), { timeout: 15_000 }).toEqual([]);

/**
 * The choices' box, what to do (not the area and severity groups): its border and the gap between
 * its rows (graphite.css, the pain sheet).
 */
const boxed = (page: Page) =>
	pain(page)
		.getByRole('region', { name: PAIN_COPY.choices })
		.evaluate((el) => {
			const style = getComputedStyle(el);
			return { border: style.borderTopWidth, gap: style.rowGap };
		});

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

test.describe('reach mid-set', () => {
	test('Stop is first and in view, the details folded; the gentler options come second', async ({
		page,
		request
	}) => {
		await startFromKit(page, request);
		await goTo(page, 'Leg press');
		await hurts(page);
		await expect(pain(page).getByTestId('pain-stop')).toBeInViewport();
		await expect(pain(page)).toContainText('Stopping is always OK.');
		// Stop, then the fold; nothing about the area shown yet.
		const testids = (selectors: string[]) =>
			pain(page)
				.locator(selectors.map((id) => `[data-testid="${id}"]`).join(', '))
				.evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
		expect(await testids(['pain-stop', 'pain-details-toggle', 'pain-area'])).toEqual([
			'pain-stop',
			'pain-details-toggle'
		]);
		await expect(toggle(page)).toHaveText('Add details (optional)');
		await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
		// It names what it controls only while that is there.
		await expect(toggle(page)).not.toHaveAttribute('aria-controls');
		await expect(pain(page).getByTestId('pain-severity')).toHaveCount(0);
		await expect(pain(page).getByTestId('pain-note')).toHaveCount(0);

		await details(page);
		await expect(toggle(page)).toHaveAttribute('aria-controls', 'pain-details');
		await expect(pain(page).locator('#pain-details')).toBeVisible();
		await area(page, 'Knee').check();
		await severity(page, 'Severe').check();
		// The gentler options come second: after Stop, before End the workout here and the fold.
		await expect(options(page).first()).toBeVisible();
		const order = await testids([
			'pain-stop',
			'alternative',
			'pain-end',
			'pain-details-toggle',
			'pain-area'
		]);
		expect(order[0]).toBe('pain-stop');
		expect(order.slice(-3)).toEqual(['pain-end', 'pain-details-toggle', 'pain-area']);
		expect(order.slice(1, -3).length).toBeGreaterThan(0);
		expect(order.slice(1, -3).every((id) => id === 'alternative')).toBe(true);

		// Folded again, the choices stay as they were.
		await toggle(page).click();
		await expect(pain(page).getByTestId('pain-area')).toHaveCount(0);
		await expect(pain(page).getByTestId('pain-end')).toBeVisible();
		await expect(options(page).first()).toBeVisible();
	});
});

test.describe('the gentler options', () => {
	test('lower back on the Romanian deadlift: nothing that loads the spine, back-friendly first', async ({
		page,
		request
	}, testInfo) => {
		const { kit } = await startFromKit(page, request);
		const rdl = entry(kit, 'romanian_deadlift');
		const gentler = rdl.gentler!.lower_back!;
		// The plain alternatives include spinal loading, so the area really removes some.
		expect(rdl.alternatives!.some((a) => a.exercise.tags.includes('spinal_loading'))).toBe(true);
		expect(gentler.some((a) => a.exercise.tags.includes('spinal_loading'))).toBe(false);
		expect(gentler[0]!.exercise.tags).toContain('back_friendly');

		await goTo(page, 'Romanian deadlift');
		await hurts(page);
		await expect(options(page)).toHaveCount(0);
		await details(page);
		await area(page, 'Lower back').check();
		await severity(page, 'Moderate').check();
		await expect(pain(page).getByTestId('pain-gentler-heading')).toHaveText(
			'Gentler on your lower back'
		);
		await expect(options(page)).toHaveText(names(gentler));
		// Stop always comes first, and moderate pain offers no End the workout here.
		const choices = pain(page).locator('[data-testid="pain-stop"], [data-testid="alternative"]');
		await expect(choices.first()).toHaveAttribute('data-testid', 'pain-stop');
		await expect(pain(page).getByTestId('pain-end')).toHaveCount(0);
		await captureScreen(page, testInfo, 'workout-pain');
	});

	test('knee on the leg press: no deep knee bends; a gentler option swaps with reason pain', async ({
		page,
		request
	}) => {
		const { kit, workoutId } = await startFromKit(page, request);
		const gentler = entry(kit, 'leg_press').gentler!.knee!;
		expect(gentler.length).toBeGreaterThan(0);
		expect(gentler.some((a) => a.exercise.tags.includes('deep_knee_flexion'))).toBe(false);

		await goTo(page, 'Leg press');
		await hurts(page);
		await details(page);
		await area(page, 'Knee').check();
		await expect(options(page)).toHaveText(names(gentler));
		await options(page).first().click();
		await expect(pain(page)).toBeHidden();
		await expect(heading(page)).toHaveText(gentler[0]!.exercise.name);
		await expect(card(page).getByTestId('slot-state')).toContainText('Swapped for this session');
		await synced(page);

		const subs = await query<{ id: string; reason: string; to_key: string }>(
			`select s.client_mutation_id as id, s.reason, t.key as to_key
			   from workout_substitutions s
			   join workouts w on w.id = s.workout_id
			   join exercises t on t.id = s.to_exercise_id
			  where w.client_id = $1 and s.deleted_at is null`,
			[workoutId]
		);
		expect(subs).toEqual([
			{ id: expect.any(String), reason: 'pain', to_key: gentler[0]!.exercise.key }
		]);
		expect(await reports(workoutId)).toEqual([
			{
				id: expect.any(String),
				area: 'knee',
				severity: null,
				action: 'substituted',
				note: null,
				exercise: 'leg_press',
				substitution: subs[0]!.id
			}
		]);
		const preferences = await query('select 1 from exercise_preferences');
		expect(preferences).toEqual([]);
	});

	test('with nothing gentler for the area, it says so and still offers Stop', async ({
		page,
		request
	}) => {
		// The server finds gentler options for every area of this session, so the device's kit
		// is given none for the knee.
		const program = await seedProgram(request, { fixture: 'workout-day', start: 'this_week' });
		const session = program.sessions.find((s) => s.date === program.today)!;
		const kit = (await (
			await request.get(`/api/workouts/kit?lineage=${session.lineage}`)
		).json()) as StrengthKit;
		const bare: StrengthKit = {
			...kit,
			exercises: kit.exercises.map((e) =>
				e.exercise.key === 'leg_press' ? { ...e, gentler: { ...e.gentler, knee: [] } } : e
			)
		};
		await seedWorkout(page, bare);
		await gotoWorkout(page, 'strength', { sync: 'real' });
		await goTo(page, 'Leg press');
		await hurts(page);
		await details(page);
		await area(page, 'Knee').check();
		await expect(pain(page).getByTestId('pain-no-gentler')).toHaveText(
			'Nothing gentler on your knee today, so stopping is the safe choice.'
		);
		await expect(options(page)).toHaveCount(0);
		await expect(pain(page).getByTestId('pain-stop')).toBeVisible();
	});
});

test.describe('stopping', () => {
	test('Stop: the exercise reads Stopped, and the report is stored with what was said', async ({
		page,
		request
	}) => {
		const { workoutId } = await startFromKit(page, request);
		await goTo(page, 'Romanian deadlift');
		await hurts(page);
		await details(page);
		await area(page, 'Lower back').check();
		await severity(page, 'Moderate').check();
		await pain(page).getByTestId('pain-note').fill('Twinge on the way up');
		await pain(page).getByTestId('pain-stop').click();
		await expect(pain(page)).toBeHidden();
		await expect(heading(page)).not.toHaveText('Romanian deadlift');
		await main(page).getByTestId('exercise-prev').click();
		await expect(heading(page)).toHaveText('Romanian deadlift');
		await expect(card(page).getByTestId('slot-state')).toHaveText('Stopped');
		await synced(page);

		expect(await reports(workoutId)).toEqual([
			{
				id: expect.any(String),
				area: 'lower_back',
				severity: 'moderate',
				action: 'stopped',
				note: 'Twinge on the way up',
				exercise: 'romanian_deadlift',
				substitution: null
			}
		]);
		const sets = await query<{ skipped: boolean }>(
			`select r.is_skipped as skipped
			   from set_records r
			   join workouts w on w.id = r.workout_id
			   join exercises x on x.id = r.exercise_id
			  where w.client_id = $1 and x.key = 'romanian_deadlift'`,
			[workoutId]
		);
		expect(sets.length).toBeGreaterThan(0);
		expect(sets.every((s) => s.skipped)).toBe(true);
	});

	test('severe: End the workout here opens the finish, and the report says ended_workout', async ({
		page,
		request
	}) => {
		const { workoutId } = await startFromKit(page, request);
		await goTo(page, 'Leg press');
		await hurts(page);
		await expect(pain(page).getByTestId('pain-end')).toHaveCount(0);
		await details(page);
		await severity(page, 'Severe').check();
		const end = pain(page).getByTestId('pain-end');
		await expect(end).toHaveText(/End the workout here/);
		await end.click();
		await expect(pain(page)).toBeHidden();
		await expect(page.getByTestId('finish-sheet')).toBeVisible();
		await synced(page);
		expect(await reports(workoutId)).toEqual([
			expect.objectContaining({ severity: 'severe', action: 'ended_workout', area: null })
		]);
	});

	test('offline: the report waits on the device and syncs once', async ({
		page,
		context,
		request
	}) => {
		const { workoutId } = await startFromKit(page, request);
		await goTo(page, 'Leg press');
		// The sheet's code is loaded online; a device offline from the start has it precached.
		await hurts(page);
		await context.setOffline(true);
		await details(page);
		await area(page, 'Knee').check();
		await pain(page).getByTestId('pain-stop').click();
		await expect(pain(page)).toBeHidden();
		await expect
			.poll(async () => (await readOutbox(page)).map((e) => e.envelope.type))
			.toEqual(['exercise.skip', 'pain.report']);

		await context.setOffline(false);
		await synced(page);
		const rows = await reports(workoutId);
		expect(rows.map((r) => [r.area, r.action])).toEqual([['knee', 'stopped']]);
	});
});

test.describe('the words and the way out', () => {
	test('never suggests carrying on through pain, names no diagnosis, and offers Stop', async ({
		page,
		request
	}) => {
		await startFromKit(page, request);
		await goTo(page, 'Leg press');
		await hurts(page);
		// Every part shown: the gentler options and End the workout here.
		await details(page);
		await area(page, 'Lower back').check();
		await severity(page, 'Severe').check();
		await expect(pain(page).getByTestId('pain-end')).toBeVisible();
		const text = await pain(page).innerText();
		expect(text).toContain('Stop');
		expect(text).toContain('If the pain is sharp or persists, see a doctor or physiotherapist.');
		expect(text.match(PUSH_THROUGH)).toBeNull();
		expect(text.match(DIAGNOSIS)).toBeNull();
	});

	test('Profile → Injuries opens, and the workout is still on the device afterwards', async ({
		page,
		request
	}) => {
		const { workoutId } = await startFromKit(page, request);
		await goTo(page, 'Leg press');
		await hurts(page);
		await pain(page).getByTestId('pain-injuries').click();
		await expect(page).toHaveURL(/\/profile\/injuries$/);
		expect(await readWorkout(page, workoutId)).toMatchObject({
			id: workoutId,
			status: 'in_progress'
		});
		await page.goBack();
		await expect(page.locator('main#main[data-store]')).toBeAttached();
		await expect(card(page)).toBeVisible();
	});

	test('a refused report: Fix reopens the sheet with why, and the corrected one lands once', async ({
		page,
		request
	}) => {
		const { workoutId, kit } = await startFromKit(page, request);
		const legPress = entry(kit, 'leg_press');
		const refused = createMutation('pain.report', {
			workoutId,
			at: new Date().toISOString(),
			payload: {
				position: legPress.position,
				plannedLineage: legPress.plannedLineage,
				exerciseId: legPress.exercise.id,
				area: 'knee',
				severity: 'mild',
				action: 'stopped',
				substitutionId: null,
				note: 'x'.repeat(600)
			}
		});
		await injectMutation(page, refused);
		const pill = page.getByTestId('sync-pill');
		await expect(pill).toHaveText('1 needs attention', { timeout: 15_000 });
		await pill.click();
		const issue = page.getByTestId('sync-sheet').getByTestId('sync-issue');
		await expect(issue.getByTestId('fix-change')).toHaveText('Fix');
		await issue.getByTestId('fix-change').click();

		await expect(pain(page)).toBeVisible();
		await expect(pain(page).getByTestId('pain-error')).toBeVisible();
		// The details are the point of Fix: unfolded, with no choices and no fold.
		await expect(toggle(page)).toHaveCount(0);
		await expect(area(page, 'Knee')).toBeChecked();
		const note = pain(page).getByTestId('pain-note');
		await expect(note).toHaveValue('x'.repeat(600));
		await expect(pain(page).getByTestId('pain-stop')).toHaveCount(0);
		await note.fill('Sharp on the way down');
		await pain(page).getByTestId('pain-save').click();
		await synced(page);
		expect(await reports(workoutId)).toEqual([
			expect.objectContaining({
				id: refused.id,
				area: 'knee',
				severity: 'mild',
				action: 'stopped',
				note: 'Sharp on the way down'
			})
		]);
	});

	test('the sheet passes axe in dark and light, with its gentler options open', async ({
		page,
		request
	}) => {
		await startFromKit(page, request);
		await goTo(page, 'Leg press');
		await hurts(page);
		await audit(page, 'the pain sheet');
		await details(page);
		await area(page, 'Knee').check();
		await severity(page, 'Severe').check();
		await expect(options(page).first()).toBeVisible();
		await audit(page, 'the pain sheet with its choices');
		// Today's design: the choices stand apart, with no box around them.
		expect(await boxed(page)).toEqual({ border: '0px', gap: '8px' });
	});

	test('Graphite 2004: the choices are one box, and the sheet passes axe in dark and light', async ({
		page,
		request
	}) => {
		await page.addInitScript(() => localStorage.setItem('pc:design:v1', 'graphite'));
		await startFromKit(page, request);
		await expect(page.locator('html')).toHaveAttribute('data-design', 'graphite');
		await goTo(page, 'Leg press');
		await hurts(page);
		await area(page, 'Knee').check();
		await severity(page, 'Severe').check();
		await expect(options(page).first()).toBeVisible();
		expect(await boxed(page)).toEqual({ border: '1px', gap: '0px' });
		// Only what to do is boxed: the area and severity groups keep their own spacing, unboxed.
		for (const group of ['pain-area', 'pain-severity']) {
			const look = await pain(page)
				.getByTestId(group)
				.evaluate((el) => {
					const style = getComputedStyle(el);
					return { border: style.borderTopWidth, gap: style.rowGap };
				});
			expect(look, group).toEqual({ border: '0px', gap: '8px' });
		}
		await page.waitForFunction(() => document.fonts.status === 'loaded');
		await audit(page, 'the pain sheet in Graphite');
	});
});

test.describe('desktop', () => {
	test.use(DESKTOP);

	test('the sheet is a dialog: area and severity by keyboard, with hover and focus states', async ({
		page,
		request
	}, testInfo) => {
		await startFromKit(page, request);
		await goTo(page, 'Leg press');
		await hurts(page);
		await expect(page.getByRole('dialog', { name: 'This hurts' })).toBeVisible();

		// The details unfold by keyboard.
		await toggle(page).focus();
		await page.keyboard.press('Enter');
		await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');

		// The area by keyboard: Space picks, the arrows move the choice.
		await area(page, 'Neck').focus();
		await page.keyboard.press('Space');
		await expect(area(page, 'Neck')).toBeChecked();
		await page.keyboard.press('ArrowRight');
		await expect(area(page, 'Shoulder')).toBeChecked();
		// Tab leaves the group for the severity, where the arrows move the choice too.
		await page.keyboard.press('Tab');
		await expect(severity(page, 'Mild')).toBeFocused();
		await page.keyboard.press('Space');
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('ArrowDown');
		await expect(severity(page, 'Severe')).toBeChecked();
		await expect(pain(page).getByTestId('pain-end')).toBeVisible();

		// Back up the reading order: Stop comes before everything else, with a keyboard focus ring.
		const stop = pain(page).getByTestId('pain-stop');
		for (let i = 0; i < 30 && !(await stop.evaluate((el) => el === document.activeElement)); i++) {
			await page.keyboard.press('Shift+Tab');
		}
		await expect(stop).toBeFocused();
		await expect(stop).toHaveCSS('outline-style', 'solid');

		// Hover strengthens End the workout here's background.
		const end = pain(page).getByTestId('pain-end');
		const before = await end.evaluate((el) => getComputedStyle(el).backgroundColor);
		await end.hover();
		await expect
			.poll(() => end.evaluate((el) => getComputedStyle(el).backgroundColor))
			.not.toBe(before);
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'workout-pain-desktop');
	});
});
