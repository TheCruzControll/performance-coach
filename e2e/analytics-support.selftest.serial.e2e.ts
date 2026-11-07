/**
 * The analytics specs' support (e2e/analytics-support.ts) and SQL oracles (e2e/oracles/) against
 * the real server: twelve-weeks is seeded through the test-only route, and every oracle file
 * agrees with numbers worked out by hand from the fixture's formulas
 * (src/lib/server/test-support/analytics-fixtures/dashboards.ts) for week 9, whose history holds
 * an off-plan run beside the six planned sessions. The abandoned workout (week 10), the
 * soft-deleted one (week 11) and the one in progress each hold sets heavy enough to change every
 * strength figure, and none reaches an oracle.
 *
 * Serial: the history is the one owner's, which every browser and worker shares.
 */
import { expect, test } from '@playwright/test';
import { addDays } from '../src/lib/domain/calendar';
import {
	ANALYTICS_TZ,
	query,
	resetAnalytics,
	seedAnalytics,
	type SeededAnalytics
} from './analytics-support';
import * as general from './oracles/general';
import * as running from './oracles/running';
import * as strength from './oracles/strength';
import { SAME_ORIGIN } from './support';

test.use({ timezoneId: ANALYTICS_TZ });
test.describe.configure({ mode: 'serial' });

/** RTS chart, the share of 1RM: 5 reps at RPE 8 and 9, 10 reps at RPE 8. */
const FIVE_AT_8 = 0.811;
const FIVE_AT_9 = 0.837;
const TEN_AT_8 = 0.68;

let seeded: SeededAnalytics;
/** Monday and Sunday of the fixture's week n. */
const monday = (n: number) => addDays(seeded.historyStart!, 7 * (n - 1));
const sunday = (n: number) => addDays(monday(n), 6);

test.beforeAll(async ({ request }) => {
	seeded = await seedAnalytics(request, 'twelve-weeks');
});

test.afterAll(async () => {
	await resetAnalytics();
});

test('the route seeds twelve weeks before this one, at the server’s today', async () => {
	expect(seeded).toMatchObject({ fixture: 'twelve-weeks', timeZone: ANALYTICS_TZ });
	expect(seeded.historyStart).toBe(addDays(seeded.weekStart, -84));
	expect(Object.keys(seeded.workouts).sort()).toEqual([
		'abandoned',
		'deleted',
		'inProgress',
		'offPlan'
	]);
	const [profile] = await query<{ time_zone: string }>('select time_zone from athlete_profiles');
	expect(profile!.time_zone).toBe(ANALYTICS_TZ);
});

test('a seed on top of the history is refused, and an unknown fixture too; nothing changes', async ({
	request
}) => {
	const count = async () =>
		(await query<{ n: number }>('select count(*)::int as n from workouts'))[0]!.n;
	const before = await count();
	const post = (fixture: string) =>
		request.post('/api/test-support/analytics', {
			headers: SAME_ORIGIN,
			data: { fixture, timeZone: ANALYTICS_TZ }
		});
	const again = await post('new-user');
	expect(again.status()).toBe(409);
	expect(await again.json()).toMatchObject({ error: 'training_data_exists' });
	const unknown = await post('marathon');
	expect(unknown.status()).toBe(400);
	expect(await unknown.json()).toMatchObject({ error: 'invalid' });
	expect(await count()).toBe(before);
});

test('strength: week 9 by hand, and no discarded set anywhere', async () => {
	const tonnage = await strength.weeklyTonnage(seeded.today);
	const week = (n: number) => tonnage.find((w) => w.weekStart === monday(n));
	// Squat 3 × 5 × 120, bench 3 × 5 × 75, row 3 × 8 × 65, deadlift 2 × 5 × 160, press
	// 3 × 5 × 50, curl 3 × 10 × 14; the warm-ups never count.
	expect(week(9)).toEqual({ weekStart: monday(9), tonnageKg: 7255, inProgress: false });
	// Week 10: Strength A alone (squat 122.5, bench 80, row 65), not the abandoned 2 × 3 × 230.
	expect(week(10)!.tonnageKg).toBe(1837.5 + 1200 + 1560);
	// Week 11: the full week, not the soft-deleted 3 × 10 × 24 curls.
	expect(week(11)!.tonnageKg).toBe(1875 + 1237.5 + 1560 + 1650 + 768.75 + 420);
	expect(tonnage).toHaveLength(13);
	expect(tonnage.at(-1)).toMatchObject({ weekStart: seeded.weekStart, inProgress: true });

	// The best e1RMs: never the in-progress 150 × 5 squats, the abandoned 230 × 3 deadlifts or the
	// deleted 24 kg curls.
	const lastSquat = seeded.today > seeded.weekStart ? 130 : 127.5;
	const best = Object.fromEntries((await strength.bestE1rms()).map((b) => [b.key, b.e1rmKg]));
	expect(best.back_squat).toBeCloseTo(lastSquat / FIVE_AT_8, 6);
	expect(best.deadlift).toBeCloseTo(190 / FIVE_AT_9, 6);
	expect(best.dumbbell_curl).toBeCloseTo(14 / TEN_AT_8, 6);

	const change = await strength.e1rmChange('back_squat', monday(1), sunday(12));
	expect(change!.first).toBeCloseTo(100 / FIVE_AT_8, 6);
	expect(change!.last).toBeCloseTo(127.5 / FIVE_AT_8, 6);
	expect(change!.change).toBeCloseTo(27.5 / FIVE_AT_8, 6);
	expect(change!.pct).toBeCloseTo(27.5, 6);
	expect(
		await strength.e1rmChange('back_squat', addDays(seeded.today, 1), addDays(seeded.today, 9))
	).toBeNull();

	// Five reps only: the warm-up is not a rep max, and the abandoned triples never happened.
	expect(await strength.repMaxes('deadlift')).toEqual([{ reps: 5, weightKg: 190 }]);

	// Squat rises every week: from week 2 each session breaks all three records.
	const prs = await strength.prRows('back_squat');
	expect(prs.filter((p) => p.day === monday(9))).toEqual([
		{
			kind: 'e1rm',
			reps: null,
			day: monday(9),
			value: expect.closeTo(120 / FIVE_AT_8, 6),
			previous: expect.closeTo(117.5 / FIVE_AT_8, 6)
		},
		{ kind: 'rep_max', reps: 5, day: monday(9), value: 120, previous: 117.5 },
		{ kind: 'volume', reps: null, day: monday(9), value: 1800, previous: 1762.5 }
	]);
	expect(prs.some((p) => p.day === monday(1))).toBe(false);
	expect(prs.filter((p) => p.kind === 'rep_max').every((p) => p.value < 150)).toBe(true);
	// Bench is flat and noisy: 85 kg in week 5 is the last rep max it sets.
	const benchMaxes = (await strength.prRows('bench_press')).filter((p) => p.kind === 'rep_max');
	expect(benchMaxes.map((p) => [p.day, p.value])).toEqual([
		[monday(2), 82.5],
		[monday(5), 85]
	]);

	// Hard sets: bench at RPE 6.5 is not hard; a primary muscle gives 1, a secondary 0.5, and a
	// group its best once per set.
	const hard = await strength.hardSetsByGroup(seeded.today);
	const groups = (n: number) =>
		Object.fromEntries(
			hard.filter((h) => h.weekStart === monday(n)).map((h) => [h.group, h.hardSets])
		);
	expect(groups(9)).toEqual({
		back: 8,
		biceps: 4.5,
		core: 1.5,
		forearms: 4,
		hamstrings: 2,
		hips: 5,
		quads: 4,
		shoulders: 4.5,
		triceps: 1.5
	});
	// Week 10's only hamstring work was in the abandoned workout.
	expect(groups(10).hamstrings).toBeUndefined();

	// 17 rated working sets: 3 × 8, 3 × 6.5, 3 × 7, 2 × 8, 3 × 8, 3 × 8; bench 1.5 under its 8.
	const rpe = await strength.rpeSummary(monday(9), sunday(9));
	expect(rpe).toMatchObject({ sets: 17, rated: 17, deviationSets: 17 });
	expect(rpe.meanRpe).toBeCloseTo(128.5 / 17, 6);
	expect(rpe.deviation).toBeCloseTo(-4.5 / 17, 6);
});

test('running: week 9 by hand', async () => {
	const weeks = await running.weeklyRunning(seeded.today);
	const week9 = weeks.find((w) => w.weekStart === monday(9))!;
	// Intervals 7300 m in 2294 s, tempo 7500 m in 2355 s, long 18 km in 5940 s, and the off-plan
	// 5 km in 1800 s; week 8 ran 7300 + 7500 + 17000.
	expect(week9).toEqual({
		weekStart: monday(9),
		metres: 37800,
		runs: 4,
		seconds: 12389,
		longestMetres: 18000,
		inProgress: false,
		previousMetres: 31800,
		changeMetres: 6000,
		changePct: expect.closeTo((6000 / 31800) * 100, 6)
	});
	// Week 6: the tempo run was skipped.
	expect(weeks.find((w) => w.weekStart === monday(6))).toMatchObject({
		runs: 2,
		metres: 7300 + 15000
	});
	expect(weeks.at(-1)).toMatchObject({ weekStart: seeded.weekStart, inProgress: true });

	const longest = seeded.today === addDays(seeded.weekStart, 6) ? 22000 : 21000;
	expect(await running.longestRun()).toMatchObject({ metres: longest, sessionType: 'long_run' });

	// Four 800 m reps in 191 s; the 5 km tempo segment in 1455 s; the long run at 330 s/km.
	expect(await running.paceByType(monday(9), sunday(9))).toEqual([
		{ sessionType: 'interval_run', secondsPerKm: 238.75, runs: 1 },
		{ sessionType: 'long_run', secondsPerKm: 330, runs: 1 },
		{ sessionType: 'recovery_run', secondsPerKm: 360, runs: 1 },
		{ sessionType: 'tempo_run', secondsPerKm: 291, runs: 1 }
	]);
});

test('general: week 9 by hand, and the abandoned workout is missed, not done', async () => {
	const adherence = await general.adherence(monday(6), sunday(10), seeded.today);
	const at = (n: number) => adherence.find((w) => w.weekStart === monday(n));
	expect(at(9)).toEqual({
		weekStart: monday(9),
		planned: 6,
		completed: 6,
		skipped: 0,
		missed: 0,
		moved: 0,
		pending: 0,
		extra: 1,
		pct: 100
	});
	expect(at(6)).toMatchObject({ completed: 5, skipped: 1, pct: expect.closeTo(500 / 6, 6) });
	expect(at(7)).toMatchObject({ completed: 6, moved: 1, pct: 100 });
	expect(at(10)).toMatchObject({ completed: 5, missed: 1, pct: expect.closeTo(500 / 6, 6) });
	const thisWeek = await general.adherence(
		seeded.weekStart,
		addDays(seeded.weekStart, 6),
		seeded.today
	);
	expect(thisWeek[0]!.completed + thisWeek[0]!.pending).toBe(6);

	const disciplines = await general.disciplineWeeks(seeded.today);
	const of = (n: number) =>
		disciplines.filter((d) => d.weekStart === monday(n)).map(({ weekStart: _, ...d }) => d);
	expect(of(9)).toEqual([
		{ discipline: 'muay_thai', sessions: 1, minutes: 90, unknownDuration: 0 },
		{
			discipline: 'running',
			sessions: 4,
			minutes: expect.closeTo(12389 / 60, 6),
			unknownDuration: 0
		},
		{ discipline: 'strength', sessions: 2, minutes: 120, unknownDuration: 0 }
	]);
	expect(of(10).find((d) => d.discipline === 'strength')!.sessions).toBe(1);
	expect(of(11).find((d) => d.discipline === 'strength')!.sessions).toBe(2);

	// 60 × 7.5 + 60 × 8 + 2294 s × 8 + 2355 s × 7 + 5940 s × 6 + 1800 s × 4 + 90 × 7.
	const load = await general.weeklyLoad(seeded.today);
	const week9 = load.find((w) => w.weekStart === monday(9))!;
	expect(week9.unknown).toBe(0);
	expect(week9.loadAu).toBeCloseTo(
		450 + 480 + (2294 * 8 + 2355 * 7 + 5940 * 6 + 1800 * 4) / 60 + 630,
		6
	);

	const muayThai = await general.muayThaiWeeks(seeded.today);
	expect(muayThai.find((w) => w.weekStart === monday(9))).toEqual({
		weekStart: monday(9),
		sessions: 1,
		minutes: 90,
		rounds: 6,
		sparringRounds: 0
	});
	expect(muayThai.find((w) => w.weekStart === monday(10))).toMatchObject({
		rounds: 7,
		sparringRounds: 2
	});
});
