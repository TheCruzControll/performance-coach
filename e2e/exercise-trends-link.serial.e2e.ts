/**
 * The history sheet's 'See trends' link (src/lib/ui/workout/ExerciseHistorySheet.svelte): from an
 * exercise's name in a History workout's detail, the sheet links to the exercise's Progress
 * detail (/progress/exercises/[id]), whose best e1RM equals the SQL oracle (e2e/oracles/) on the
 * twelve-weeks history. Back returns to the workout's detail. The link is a 44 px target, axe is
 * clean on the open sheet in both themes, and on a desktop window (the sheet a centred dialog)
 * the link takes keyboard focus and follows with Enter.
 *
 * Serial: the history is the one owner's, which every browser and worker shares.
 */
import { expect, test, type Page } from '@playwright/test';
import { addDays } from '../src/lib/domain/calendar';
import {
	ANALYTICS_TZ,
	auditBothThemes,
	query,
	seedAnalytics,
	type SeededAnalytics
} from './analytics-support';
import { DESKTOP, expectNoSideScroll } from './desktop';
import { bestE1rmBetween } from './oracles/exercise';
import { gotoHydrated, trackConsoleErrors } from './support';

test.use({ timezoneId: ANALYTICS_TZ });
test.describe.configure({ mode: 'serial' });

const LIFT = 'back_squat';
const NAME = 'Back squat';
/** The exercise detail's default period, in complete weeks before this one. */
const DEFAULT_WEEKS = 12;
const MIN_TARGET_PX = 44;

const sheet = (page: Page) => page.getByTestId('exercise-history-sheet');
const trendsLink = (page: Page) => sheet(page).getByRole('link', { name: /See trends/ });

let seeded: SeededAnalytics;
let detail: string;

test.beforeAll(async ({ request }) => {
	seeded = await seedAnalytics(request, 'twelve-weeks');
	// The latest completed, undeleted workout with live sets of the lift.
	const [row] = await query<{ id: string }>(
		`select w.id from workouts w
		join set_records s on s.workout_id = w.id and s.deleted_at is null
		join exercises e on e.id = s.exercise_id
		where e.key = $1 and w.status = 'completed' and w.deleted_at is null
		order by w.started_at desc limit 1`,
		[LIFT]
	);
	expect(row, `a completed ${LIFT} workout in twelve-weeks`).toBeDefined();
	detail = `/progress/workouts/${row!.id}`;
});

/** The History workout's detail, with the lift's history sheet open and loaded. */
async function openSheet(page: Page) {
	await gotoHydrated(page, detail);
	await page
		.getByTestId('workout-detail')
		.getByTestId('exercise-history-open')
		.filter({ hasText: NAME })
		.first()
		.click();
	await expect(sheet(page)).toBeVisible();
	await expect(sheet(page).getByTestId('history-best')).toBeVisible();
}

async function expectExerciseDetail(page: Page) {
	await expect(page).toHaveURL(new RegExp(`/progress/exercises/${seeded.exercises[LIFT]}$`));
	await expect(page.getByRole('heading', { level: 1, name: NAME })).toBeVisible();
	const from = addDays(seeded.weekStart, -7 * DEFAULT_WEEKS);
	const to = addDays(seeded.weekStart, -1);
	const best = await bestE1rmBetween(LIFT, from, to);
	expect(best, `${LIFT} has estimates in ${DEFAULT_WEEKS} weeks`).not.toBeNull();
	const tile = page.getByTestId('exercise-e1rm');
	await expect(tile).toHaveAttribute('data-value', /\d/);
	expect(Number(await tile.getAttribute('data-value')), 'best e1RM').toBeCloseTo(best!, 1);
}

test('the sheet’s See trends opens the exercise detail at the oracle’s best e1RM; Back returns to the workout', async ({
	page
}) => {
	const errors = trackConsoleErrors(page);
	await openSheet(page);
	const link = trendsLink(page);
	await expect(link).toBeVisible();
	await expect(link).toHaveAttribute('href', `/progress/exercises/${seeded.exercises[LIFT]}`);

	await link.click();
	await expectExerciseDetail(page);

	await page.goBack();
	await expect(page).toHaveURL(new RegExp(`${detail}$`));
	await expect(page.getByTestId('workout-detail')).toBeVisible();
	expect(errors).toEqual([]);
});

test('the link is a 44 px target, and the open sheet is axe-clean in both themes', async ({
	page
}) => {
	await openSheet(page);
	const box = await trendsLink(page).boundingBox();
	expect(box, 'the link is laid out').not.toBeNull();
	expect(box!.height, 'tall enough to tap').toBeGreaterThanOrEqual(MIN_TARGET_PX);
	expect(box!.width, 'wide enough to tap').toBeGreaterThanOrEqual(MIN_TARGET_PX);
	await auditBothThemes(page, 'history sheet with See trends');
});

test.describe('on a desktop window', () => {
	test.use(DESKTOP);

	test('the link in the centred dialog takes keyboard focus and follows with Enter', async ({
		page
	}) => {
		await openSheet(page);
		await expectNoSideScroll(page);
		const link = trendsLink(page);
		await link.focus();
		await expect(link).toBeFocused();
		await page.keyboard.press('Enter');
		await expectExerciseDetail(page);
	});
});
