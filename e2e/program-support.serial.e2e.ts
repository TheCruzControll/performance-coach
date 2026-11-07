/**
 * The program specs' support (e2e/program-support.ts) against the real server: fixture programs
 * stored through the test-only route at dates the server computes from the owner's time zone,
 * and a reset that empties every M3 table but keeps the exercise catalogue. Serial: programs are
 * the one owner's, which every browser and worker shares.
 */
import { expect, test } from '@playwright/test';
import { addDays, mondayOf } from '../src/lib/domain/calendar';
import { localDay } from '../src/lib/domain/dates';
import {
	M1_M2_TABLES,
	PROGRAM_TZ,
	RESET_ROOTS,
	resetPrograms,
	seedProgram,
	type SeededProgram
} from './program-support';
import { query, SAME_ORIGIN } from './support';

test.use({ timezoneId: PROGRAM_TZ });

const ROUTE = '/api/test-support/program';

test.beforeEach(async () => {
	await resetPrograms();
});

/** The planned sessions stored for the program, by day. */
const storedSessions = (programId: string) =>
	query<{ date: string; title: string; lineage: string }>(
		`select to_char(s.scheduled_on, 'YYYY-MM-DD') as date, s.title, s.lineage_id::text as lineage
		from programs p
		join program_version_weeks vw on vw.version_id = p.current_version_id
		join planned_sessions s on s.week_id = vw.week_id
		where p.id = $1
		order by s.scheduled_on, s.order_in_day`,
		[programId]
	);

/**
 * Seed, and check the server's today against the runner's clock in PROGRAM_TZ (either side of
 * the request, in case it straddles midnight there): the route took today from the zone it
 * recorded, not from the machine's.
 */
async function seed(
	request: Parameters<typeof seedProgram>[0],
	options: Parameters<typeof seedProgram>[1]
): Promise<SeededProgram & { ms: number }> {
	const before = localDay(new Date(), PROGRAM_TZ);
	const started = performance.now();
	const seeded = await seedProgram(request, options);
	const ms = performance.now() - started;
	expect([before, localDay(new Date(), PROGRAM_TZ)]).toContain(seeded.today);
	return { ...seeded, ms };
}

test('next_week: version 1, every session after today, recorded in the owner’s zone', async ({
	request
}) => {
	const seeded = await seed(request, { fixture: 'hybrid', start: 'next_week' });
	expect(seeded.version).toBe(1);
	expect(seeded.weekStart).toBe(addDays(mondayOf(seeded.today), 7));
	// Five planned weeks of five sessions, every one of them still ahead, whatever today is.
	expect(seeded.sessions).toHaveLength(25);
	expect(seeded.sessions.filter((s) => s.date <= seeded.today)).toEqual([]);
	expect(seeded.sessions[0]).toMatchObject({
		ref: 'blocks.0.weeks.0.sessions.0',
		date: seeded.weekStart,
		title: 'Full body'
	});
	expect(seeded.sessions.at(-1)).toMatchObject({
		ref: 'blocks.1.weeks.3.sessions.4',
		date: addDays(seeded.weekStart, 7 * 4 + 3),
		title: 'Muay Thai class'
	});
	// What the route returned is what was stored, and the zone it used is on the profile.
	expect(await storedSessions(seeded.programId)).toEqual(
		seeded.sessions.map(({ date, title, lineage }) => ({ date, title, lineage }))
	);
	expect(
		await query('select number from program_versions where program_id = $1', [seeded.programId])
	).toEqual([{ number: 1 }]);
	expect(await query('select time_zone from athlete_profiles')).toEqual([
		{ time_zone: PROGRAM_TZ }
	]);
	// Seeding (a reset and the request) is quick enough for every spec's beforeEach.
	expect(seeded.ms).toBeLessThan(1_000);
});

test('today and today-rest place week 1 around the server’s today', async ({ request }) => {
	const today = await seed(request, { fixture: 'today', start: 'this_week' });
	expect(today.weekStart).toBe(mondayOf(today.today));
	expect(today.sessions.filter((s) => s.date === today.today).map((s) => s.title)).toEqual([
		'Full body',
		'Muay Thai class'
	]);
	// 'Up next' always has somewhere to go: the next week is planned too.
	expect(today.sessions.some((s) => s.date > addDays(today.weekStart, 6))).toBe(true);

	const rest = await seed(request, { fixture: 'today-rest', start: 'this_week' });
	expect(rest.sessions.filter((s) => s.date === rest.today)).toEqual([]);
	expect(rest.sessions.some((s) => s.date > rest.today)).toBe(true);
});

test('one-week on last_week: every planned session is before today', async ({ request }) => {
	const seeded = await seed(request, { fixture: 'one-week', start: 'last_week' });
	expect(seeded.weekStart).toBe(addDays(mondayOf(seeded.today), -7));
	expect(seeded.sessions).toHaveLength(5);
	expect(seeded.sessions.filter((s) => s.date >= seeded.today)).toEqual([]);
	// The outline weeks after it are stored, with nothing planned in them.
	const [row] = await query<{ weeks: number }>(
		`select count(*)::int as weeks from programs p
		join program_version_weeks vw on vw.version_id = p.current_version_id
		where p.id = $1`,
		[seeded.programId]
	);
	expect(row?.weeks).toBe(4);
});

test('the route refuses a second program and bad input, and changes no program', async ({
	request
}) => {
	const first = await seed(request, { fixture: 'hybrid', start: 'next_week' });
	const post = (data: Record<string, unknown>) =>
		request.post(ROUTE, { headers: SAME_ORIGIN, data });
	const again = await post({ fixture: 'today', start: 'this_week', timeZone: PROGRAM_TZ });
	expect(again.status()).toBe(409);
	expect(await again.json()).toMatchObject({ error: 'program_exists' });

	for (const [data, field] of [
		[{ fixture: 'marathon', start: 'next_week', timeZone: PROGRAM_TZ }, 'fixture'],
		[{ fixture: 'hybrid', start: 'tomorrow', timeZone: PROGRAM_TZ }, 'start'],
		[{ fixture: 'hybrid', start: 'next_week' }, 'timeZone'],
		[{ fixture: 'hybrid', start: 'next_week', timeZone: 'Mars/Olympus_Mons' }, 'profile'],
		// Today is never in next week's week 1.
		[{ fixture: 'today', start: 'next_week', timeZone: PROGRAM_TZ }, 'not in the week']
	] as const) {
		const res = await post(data);
		expect(res.status(), field).toBe(400);
		expect((await res.json()).message, field).toContain(field);
	}

	const programs = await query<{ id: string }>('select id from programs');
	expect(programs).toEqual([{ id: first.programId }]);
	expect(await storedSessions(first.programId)).toHaveLength(25);
});

/** One row in each root table that no fixture writes yet, so the reset has them to remove. */
async function fillRootTables(programId: string) {
	await query(
		`insert into workouts (owner_id, client_id, kind, discipline, session_type, title, started_at)
			select id, gen_random_uuid(), 'run', 'running', 'easy_run', 'Unplanned run', now() from owners;
		insert into recovery_notes (owner_id, client_mutation_id, noted_on, note)
			select id, gen_random_uuid(), current_date, 'Slept badly' from owners;
		insert into training_audit (owner_id, table_name, row_id, action, before, after, actor)
			select id, 'workouts', 'x', 'update', '{}', '{}', 'owner' from owners;
		insert into coach_proposals (owner_id, kind, title, summary, rationale, payload)
			select id, 'swap', 'Swap', 'Swap a lift', 'It hurts', '{}' from owners;
		insert into weekly_reviews (owner_id, week_starts_on, snapshot, summary)
			select id, date_trunc('week', current_date)::date, '{}', 'A good week' from owners;
		insert into cycle_reviews (owner_id, program_id, block_lineage_id, snapshot, summary)
			select id, '${programId}', gen_random_uuid(), '{}', 'A good block' from owners;
		insert into sync_mutations (mutation_id, owner_id, type, entity_id, client_at)
			select gen_random_uuid(), id, 'set.log', gen_random_uuid(), now() from owners;
		insert into exercises (owner_id, name, pattern, primary_muscles, skill_level, measure, load_type)
			select id, 'Sled push', 'carry', '{quads}', 'beginner', 'reps', 'external' from owners`
	);
}

/** Row counts of every public table outside M1 and M2, except the exercise library. */
async function laterTableCounts(): Promise<Record<string, number>> {
	const tables = await query<{ name: string }>(
		`select tablename as name from pg_tables
		where schemaname = 'public' and not (tablename = any($1)) and tablename <> 'exercises'
		order by tablename`,
		[[...M1_M2_TABLES]]
	);
	const counts: Record<string, number> = {};
	for (const { name } of tables) {
		const [row] = await query<{ n: number }>(`select count(*)::int as n from "${name}"`);
		counts[name] = row!.n;
	}
	return counts;
}

test('resetPrograms empties every table after M2, and only those', async ({ request }) => {
	const seeded = await seed(request, { fixture: 'hybrid', start: 'next_week' });
	await fillRootTables(seeded.programId);
	const before = await laterTableCounts();
	// Every M3 table is listed; the program tree and every root hold rows.
	expect(Object.keys(before).length).toBeGreaterThanOrEqual(23);
	expect(Object.entries(before).filter(([, n]) => n > 0).length).toBeGreaterThanOrEqual(18);
	const profile = await query('select owner_id, time_zone from athlete_profiles');

	await resetPrograms();

	// A table a later milestone adds, and the reset misses, fails here.
	expect(Object.entries(await laterTableCounts()).filter(([, n]) => n > 0)).toEqual([]);
	// M1 and M2 rows are not programs: the owner, their session and profile stay.
	expect(await query('select owner_id, time_zone from athlete_profiles')).toEqual(profile);
	expect(await query('select count(*)::int as n from owners')).toEqual([{ n: 1 }]);
});

test('the reset reaches every table after M2 by foreign key, rows or not', async () => {
	// What TRUNCATE ... CASCADE takes: the roots, then every table with a foreign key to one taken.
	const unreached = await query<{ name: string }>(
		`with recursive reached(oid) as (
			select to_regclass(root)::oid from unnest($1::text[]) as root
			union
			select c.conrelid from pg_constraint c join reached r on c.confrelid = r.oid
			where c.contype = 'f'
		)
		select tablename as name from pg_tables
		where schemaname = 'public' and not (tablename = any($2)) and tablename <> 'exercises'
			and to_regclass(quote_ident(tablename))::oid not in (select oid from reached)
		order by tablename`,
		[[...RESET_ROOTS], [...M1_M2_TABLES]]
	);
	// A table a later milestone adds outside these roots fails here before any spec writes to it.
	expect(unreached).toEqual([]);
});

test('resetPrograms keeps the exercise catalogue and removes custom exercises', async ({
	request
}) => {
	const catalogue = () =>
		query<{ rows: number; retired: number; keys: string }>(
			`select count(*)::int as rows, count(retired_at)::int as retired,
				md5(string_agg(key || name, ',' order by key)) as keys
			from exercises where key is not null`
		);
	const seeded = await seed(request, { fixture: 'hybrid', start: 'next_week' });
	await fillRootTables(seeded.programId);
	const before = await catalogue();
	expect(before[0]!.rows).toBeGreaterThan(150);
	expect(await query('select name from exercises where key is null')).toEqual([
		{ name: 'Sled push' }
	]);

	await resetPrograms();

	expect(await catalogue()).toEqual(before);
	expect(await query('select name from exercises where key is null')).toEqual([]);
	// The fixtures' exercises are catalogue keys, so seeding again works at once.
	await seed(request, { fixture: 'hybrid', start: 'next_week' });
});
