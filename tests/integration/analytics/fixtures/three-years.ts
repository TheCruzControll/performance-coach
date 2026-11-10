/**
 * A sparse, steady owner over THREE_YEARS_WEEKS complete weeks (three years) before the week of
 * THREE_YEARS_TODAY, a Wednesday: long enough that 'all' buckets by month (more than 104 weeks)
 * and is read in two windows (MAX_RANGE_DAYS). Nothing ever trends:
 * - every even week from the first, a Monday squat session: 3 × 5 at 100 kg, RPE 8
 * - every fourth week from the second, a Wednesday easy run: 5 km in 30 min, RPE 6
 * - this week (in progress), Monday's squat session as every other
 * Writes go through `db` (a test's transaction), in a few batched inserts.
 */
import { addDays, mondayOf, type IsoDate } from '../../../../src/lib/domain/calendar';
import { setE1rm } from '../../../../src/lib/domain/training/metrics';
import { runRecords, setRecords, workouts, type Executor } from '../../../../src/lib/server/db';
import { resolveKeys } from '../../../../src/lib/server/services/exercises/index';
import { saveBasics } from '../../../../src/lib/server/services/profile/index';
import { atLocal } from '../../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import { makeOwner } from '../../profile/fixtures';

export const THREE_YEARS_TZ = 'America/Los_Angeles';
export const THREE_YEARS_TODAY: IsoDate = '2026-11-04';
export const THREE_YEARS_WEEKS = 156;
/** The Monday of the first complete week. */
export const THREE_YEARS_FROM: IsoDate = addDays(
	mondayOf(THREE_YEARS_TODAY),
	-7 * THREE_YEARS_WEEKS
);

const SQUAT = { weight: 100, unit: 'kg' as const, reps: 5, rpe: 8 };

export async function seedThreeYears(db: Executor): Promise<{ owner: string; squat: string }> {
	const owner = await makeOwner(db);
	const basics = { name: 'Steady', weightUnit: 'kg', distanceUnit: 'km' } as const;
	await saveBasics(owner, { ...basics, timeZone: THREE_YEARS_TZ }, { db });
	const squat = (await resolveKeys(['back_squat'], { db })).get('back_squat')!.id;

	const mondays = Array.from({ length: THREE_YEARS_WEEKS + 1 }, (_, n) =>
		addDays(THREE_YEARS_FROM, 7 * n)
	);
	const lifting = mondays.filter((_, n) => n % 2 === 0 || n === THREE_YEARS_WEEKS);
	const running = mondays.filter((_, n) => n % 4 === 1 && n < THREE_YEARS_WEEKS);
	const at = (day: IsoDate) => atLocal(day, '07:00', THREE_YEARS_TZ);
	const workout = (kind: 'strength' | 'run', startedAt: Date) => ({
		...{ ownerId: owner, clientId: crypto.randomUUID(), kind, status: 'completed' as const },
		...(kind === 'strength'
			? { discipline: 'strength' as const, sessionType: 'strength' as const, title: 'Squat' }
			: { discipline: 'running' as const, sessionType: 'easy_run' as const, title: 'Easy run' }),
		...{ startedAt, finishedAt: new Date(startedAt.getTime() + 1_800_000) },
		...{ durationSeconds: 1800, sessionRpe: kind === 'strength' ? 8 : 6 }
	});

	const lifts = await db
		.insert(workouts)
		.values(lifting.map((monday) => workout('strength', at(monday))))
		.returning({ id: workouts.id, startedAt: workouts.startedAt });
	await db.insert(setRecords).values(
		lifts.flatMap(({ id, startedAt }) =>
			[1, 2, 3].map((setIndex) => ({
				...{ ownerId: owner, clientMutationId: crypto.randomUUID(), workoutId: id },
				...{ exerciseId: squat, exercisePosition: 1, setIndex, ...SQUAT },
				...{ isWarmup: false, isSkipped: false, isExtra: false },
				e1rmKg: setE1rm({ ...SQUAT, isWarmup: false, isSkipped: false })?.value ?? null,
				performedAt: new Date(startedAt!.getTime() + 300_000 * setIndex)
			}))
		)
	);

	const runs = await db
		.insert(workouts)
		.values(running.map((monday) => workout('run', at(addDays(monday, 2)))))
		.returning({ id: workouts.id });
	await db.insert(runRecords).values(
		runs.map(({ id }) => ({
			...{ ownerId: owner, workoutId: id, distanceMetres: 5000, durationSeconds: 1800 },
			...{ avgHr: 140, rpe: 6 }
		}))
	);
	return { owner, squat };
}
