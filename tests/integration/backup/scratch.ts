/**
 * The backup tests' scratch pair: a source to export from and a destination to restore into,
 * beside the shared test database so their own tables never reach it. Their names follow
 * TEST_DATABASE_URL's: coach_test → coach_backup_src_test and coach_backup_dst_test, which
 * `pnpm db:setup` creates.
 *
 * prepareSource() migrates the source afresh and seeds it through the auth, profile, program and
 * history fixtures, then adds scratch-only tables that hold every edge a backup must survive:
 * - backup_edge: an identity key, a generated column, a microsecond timestamptz,
 *   numeric(30,10), a bigint of 2^62, float8 0.1, unicode jsonb, text with newlines, quotes and
 *   U+2028, bytea, text[] with NULLs, an enum and a self-reference
 * - backup_cycle_a and backup_cycle_b: a two-table cycle, nullable on a's side
 * - backup_bulk: BULK_ROWS rows, more than two FETCHes' worth
 */
import { createDatabase, createPool } from '../../../src/lib/server/db';
import { LOCAL_DATABASE_URLS, resetDatabase } from '../../../src/lib/server/db/migrate';
import { LATE_ALLOWED } from '../../../src/lib/server/db/backup/tables';
import { createGoal, saveSchedule } from '../../../src/lib/server/services/profile';
import { createProgramFromPlan } from '../../../src/lib/server/services/programs/index';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { setUpOwner } from '../auth/fixtures';
import { clock, generalGoal } from '../profile/fixtures';
import { exerciseIds, logOther, logRun, logStrength, utc } from '../training/fixtures/history';

export type ScratchRole = 'src' | 'dst';

/** The scratch database's URL for `role`, on the same server as the test database. */
export function scratchUrl(role: ScratchRole): string {
	const url = new URL(process.env.TEST_DATABASE_URL || LOCAL_DATABASE_URLS.test);
	const name = decodeURIComponent(url.pathname.slice(1));
	if (!name.endsWith('_test')) throw new Error(`The test database ${name} does not end in _test`);
	url.pathname = `/${name.slice(0, -'_test'.length)}_backup_${role}_test`;
	return url.toString();
}

export const BULK_ROWS = 1_200;
/** The scratch cycle's nullable key is late too, reviewed here. */
export const SCRATCH_LATE = [...LATE_ALLOWED, 'backup_cycle_a.b_id'];

/** The edge row's values, as the test inserts them. */
export const EDGE = {
	at: '2026-11-07 10:41:00.123456+00',
	amount: '12345678901234567890.0123456789',
	big: '4611686018427387904',
	ratio: 0.1,
	doc: { name: 'Niko 🥊', clé: 'über', nested: [1, 2.5, null], empty: '' },
	note: 'line one\nline two after LS "quoted" \\ back\ttab',
	raw: '\\x00ff10',
	tags: ['a', null, 'c'],
	mood: 'fierce'
} as const;

/** The scratch-only tables, which a restore target needs too before the rows load. */
export const EDGE_DDL = `
	CREATE TYPE backup_edge_mood AS ENUM ('calm', 'fierce');
	CREATE TABLE backup_edge (
		id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
		parent_id bigint REFERENCES backup_edge (id),
		at timestamptz NOT NULL,
		amount numeric(30, 10) NOT NULL,
		big bigint NOT NULL,
		ratio float8 NOT NULL,
		doc jsonb NOT NULL,
		note text NOT NULL,
		raw bytea NOT NULL,
		tags text[],
		mood backup_edge_mood NOT NULL,
		doubled numeric GENERATED ALWAYS AS (amount * 2) STORED
	);
	CREATE TABLE backup_cycle_b (id int PRIMARY KEY, a_id int NOT NULL);
	CREATE TABLE backup_cycle_a (id int PRIMARY KEY, b_id int REFERENCES backup_cycle_b (id));
	ALTER TABLE backup_cycle_b ADD FOREIGN KEY (a_id) REFERENCES backup_cycle_a (id);
	CREATE TABLE backup_bulk (id int PRIMARY KEY, label text NOT NULL);`;

/** Migrate the source afresh and seed it; returns its URL and the owner's id. */
export async function prepareSource(): Promise<{ url: string; ownerId: string }> {
	const url = scratchUrl('src');
	await resetDatabase(url);
	const pool = createPool(url, { max: 1 });
	try {
		const db = createDatabase(pool);
		const time = clock('2026-11-06T09:00:00Z');
		const { ownerId } = await setUpOwner(db);
		const goal = await createGoal(ownerId, generalGoal(), { db, now: time.now });
		await saveSchedule(
			ownerId,
			{
				daysPerWeek: 4,
				availableDays: ['mon', 'tue', 'wed', 'thu'],
				preferredTimes: ['evening'],
				sessionMinutes: 75,
				constraints: null,
				commitments: [
					{
						discipline: 'muay_thai',
						label: 'Muay Thai class',
						days: ['tue', 'thu'],
						timeOfDay: 'evening',
						durationMinutes: 90,
						intensity: 'hard',
						notes: null
					}
				]
			},
			{ db, now: time.now }
		);
		const plan = programFixture('hybrid', {
			monday: '2026-11-09',
			today: '2026-11-11',
			goalRefs: [goal.id]
		});
		await createProgramFromPlan(
			ownerId,
			plan,
			{
				source: 'rules',
				generator: 'perfo-programming/1',
				fingerprint: '0123456789abcdef',
				digest: 'fedcba9876543210',
				snapshot: { daysPerWeek: 4, goals: [] }
			},
			{ db }
		);
		const ids = await exerciseIds(db, ['back_squat', 'bench_press']);
		await logStrength(db, ownerId, { startedAt: utc('2026-11-09', '17:00') }, [
			{ exercise: ids.back_squat, weight: 140, reps: 5, rpe: 8 },
			{ exercise: ids.back_squat, weight: 142.5, reps: 3 },
			{ exercise: ids.bench_press, weight: 92.5, reps: 8, warmup: true }
		]);
		await logRun(db, ownerId, { startedAt: utc('2026-11-10', '07:00'), metres: 8_042 });
		await logOther(db, ownerId, { startedAt: utc('2026-11-10', '19:00'), kind: 'class' });

		await pool.query(EDGE_DDL);
		await pool.query(
			`INSERT INTO backup_edge (parent_id, at, amount, big, ratio, doc, note, raw, tags, mood)
			VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9),
				(1, $1, '-0.0000000001', -9223372036854775808, 'Infinity', '[]', '', '\\x', '{}', 'calm')`,
			[
				EDGE.at,
				EDGE.amount,
				EDGE.big,
				EDGE.ratio,
				JSON.stringify(EDGE.doc),
				EDGE.note,
				EDGE.raw,
				EDGE.tags,
				EDGE.mood
			]
		);
		await pool.query(`INSERT INTO backup_cycle_a VALUES (1, NULL), (2, NULL)`);
		await pool.query(`INSERT INTO backup_cycle_b VALUES (1, 1), (2, 1)`);
		await pool.query(`UPDATE backup_cycle_a SET b_id = 2 WHERE id = 1`);
		await pool.query(
			`INSERT INTO backup_bulk SELECT n, 'row ' || n FROM generate_series(1, $1) AS n`,
			[BULK_ROWS]
		);
		await pool.query('ANALYZE');
		return { url, ownerId };
	} finally {
		await pool.end();
	}
}
