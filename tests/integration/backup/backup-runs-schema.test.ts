/**
 * The backup run log on the real migrated database (M9 'backup-runs-db'): each CHECK refuses what
 * it names, a finished run never changes, a running run finishes once, a run younger than 400 days
 * is never deleted, expireAbandoned expires only runs older than 15 minutes, free-text codes never
 * reach the table, and the app's login (coach_app, a member of coach_runtime) reaches the table
 * through default privileges. The table is emptied once, here, so every assertion is about the
 * runs this file opened; the guard refuses to delete a young row, so nothing is deleted row by row.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backupClient } from '../../../src/lib/server/db/backup/connect';
import {
	expireAbandoned,
	finishRun,
	lastRun,
	lastSucceeded,
	recent,
	startRun
} from '../../../src/lib/server/db/backup/runs';
import { connectionConfig } from '../../../src/lib/server/db/connection';
import { runtimeUrl } from '../helpers';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

/** A fixed timeline, far from the real clock, so the expiry cut-off is exact. */
const at = (year: number, minutes = 0) => new Date(Date.UTC(year, 0, 1) + minutes * MINUTE);

/** The error a refused statement carries: its SQLSTATE and the constraint or guard it names. */
const refused = (code: string, constraint: string) => expect.objectContaining({ code, constraint });

const SUCCESS = {
	status: 'succeeded',
	pathname: 'backups/2040/01/01.enc',
	bytes: 2048,
	sha256: 'a'.repeat(64),
	format: 'performance-coach-backup@1',
	schemaTag: 'b'.repeat(64),
	rowCounts: { owners: 1, set_records: 12 }
} as const;

let owner: pg.Client;
let app: pg.Client;

beforeAll(async () => {
	const url = process.env.DATABASE_URL!;
	owner = await backupClient(url);
	app = new pg.Client(connectionConfig(runtimeUrl(url)));
	await app.connect();
	await owner.query('TRUNCATE backup_runs');
}, 30_000);

afterAll(async () => {
	await owner?.query('TRUNCATE backup_runs');
	await app?.end();
	await owner?.end();
});

/** The stored state of one run, as the table holds it. */
async function rowOf(id: number) {
	const { rows } = await owner.query<{
		status: string;
		error_code: string | null;
		finished_at: Date | null;
	}>('SELECT status, error_code, finished_at FROM backup_runs WHERE id = $1', [id]);
	return rows[0]!;
}

describe('backup_runs', () => {
	it('refuses each CHECK by its name, and accepts a code, or none', async () => {
		const insert = (
			trigger: string,
			status: string,
			finishedAt: Date | null,
			code: string | null
		) =>
			owner.query(
				'INSERT INTO backup_runs (trigger, status, finished_at, error_code) VALUES ($1, $2, $3, $4)',
				[trigger, status, finishedAt, code]
			);

		await expect(insert('nightly', 'skipped', at(2040), null)).rejects.toMatchObject(
			refused('23514', 'backup_runs_trigger_ck')
		);
		await expect(insert('cron', 'done', at(2040), null)).rejects.toMatchObject(
			refused('23514', 'backup_runs_status_ck')
		);
		await expect(insert('cron', 'running', at(2040), null)).rejects.toMatchObject(
			refused('23514', 'backup_runs_running_ck')
		);
		await expect(
			insert('cron', 'failed', at(2040), 'Disk full at /Users/owner')
		).rejects.toMatchObject(refused('23514', 'backup_runs_error_code_ck'));
		await expect(insert('cron', 'failed', at(2040), 'a'.repeat(65))).rejects.toMatchObject(
			refused('23514', 'backup_runs_error_code_ck')
		);
		await expect(insert('cron', 'failed', at(2040), 'a'.repeat(64))).resolves.toBeDefined();
		await expect(insert('manual', 'skipped', at(2040), null)).resolves.toBeDefined();
	});

	it('a run is running exactly when it has no finish time', async () => {
		// Refusals only: no row is written, so the table holds nothing the later tests did not open.
		const insert = (status: string, finishedAt: Date | null) =>
			owner.query(
				'INSERT INTO backup_runs (trigger, status, started_at, finished_at) VALUES ($1, $2, $3, $4)',
				['cron', status, at(2040, 40), finishedAt]
			);
		for (const status of ['succeeded', 'failed', 'skipped']) {
			await expect(insert(status, null)).rejects.toMatchObject(
				refused('23514', 'backup_runs_running_ck')
			);
		}
		await expect(insert('running', at(2040, 41))).rejects.toMatchObject(
			refused('23514', 'backup_runs_running_ck')
		);
	});

	it('a finished run never changes, and is never deleted while young', async () => {
		const id = await startRun(owner, { trigger: 'manual', appVersion: '1.0.0', now: at(2040, 0) });
		expect(await finishRun(owner, id, SUCCESS, at(2040, 5))).toBe(true);

		await expect(
			owner.query('UPDATE backup_runs SET app_version = $2 WHERE id = $1', [id, '2.0.0'])
		).rejects.toMatchObject(refused('23001', 'backup_runs_update_guard'));
		await expect(
			owner.query("UPDATE backup_runs SET status = 'failed' WHERE id = $1", [id])
		).rejects.toMatchObject(refused('23001', 'backup_runs_update_guard'));
		await expect(owner.query('DELETE FROM backup_runs WHERE id = $1', [id])).rejects.toMatchObject(
			refused('23001', 'backup_runs_delete_guard')
		);
		expect(await rowOf(id)).toMatchObject({ status: 'succeeded', error_code: null });
	});

	it('a running run finishes once, and only its finishing columns change', async () => {
		const id = await startRun(owner, { trigger: 'cron', appVersion: '1.0.0', now: at(2040, 10) });

		await expect(
			owner.query("UPDATE backup_runs SET trigger = 'manual' WHERE id = $1", [id])
		).rejects.toMatchObject(refused('23001', 'backup_runs_update_guard'));
		await expect(
			owner.query('UPDATE backup_runs SET started_at = now() WHERE id = $1', [id])
		).rejects.toMatchObject(refused('23001', 'backup_runs_update_guard'));
		await expect(
			owner.query("UPDATE backup_runs SET pathname = 'backups/x.enc' WHERE id = $1", [id])
		).rejects.toMatchObject(refused('23001', 'backup_runs_update_guard'));

		expect(
			await finishRun(owner, id, { status: 'failed', errorCode: 'upload_failed' }, at(2040, 11))
		).toBe(true);
		expect(await finishRun(owner, id, SUCCESS, at(2040, 12))).toBe(false);
		expect(await rowOf(id)).toMatchObject({ status: 'failed', error_code: 'upload_failed' });
	});

	it('expires a run still running 15 minutes after it started, and only that', async () => {
		const base = at(2030, 0);
		const old = await startRun(owner, {
			trigger: 'cron',
			appVersion: '1.0.0',
			now: new Date(base.getTime() - 16 * MINUTE)
		});
		const young = await startRun(owner, {
			trigger: 'cron',
			appVersion: '1.0.0',
			now: new Date(base.getTime() - 14 * MINUTE)
		});

		expect(await expireAbandoned(owner, base)).toBe(1);
		expect(await rowOf(old)).toEqual({
			status: 'failed',
			error_code: 'abandoned',
			finished_at: base
		});
		expect(await rowOf(young)).toEqual({ status: 'running', error_code: null, finished_at: null });
		expect(await expireAbandoned(owner, base)).toBe(0);
	});

	it('refuses a free-text error code before it is sent, and leaves the run running', async () => {
		const id = await startRun(owner, { trigger: 'manual', appVersion: '1.0.0', now: at(2040, 20) });
		await expect(
			finishRun(
				owner,
				id,
				{ status: 'failed', errorCode: 'Disk full at /Users/owner' },
				at(2040, 21)
			)
		).rejects.toBeInstanceOf(RangeError);
		expect(await rowOf(id)).toMatchObject({ status: 'running', finished_at: null });
	});

	it('reads the newest run, the newest success and the newest n, by start time', async () => {
		const first = await startRun(owner, { trigger: 'cron', appVersion: '1.0.0', now: at(2041, 0) });
		await finishRun(owner, first, SUCCESS, at(2041, 1));
		const second = await startRun(owner, {
			trigger: 'cron',
			appVersion: '1.0.0',
			now: at(2041, 10)
		});
		await finishRun(owner, second, { status: 'failed', errorCode: 'upload_failed' }, at(2041, 11));
		const third = await startRun(owner, {
			trigger: 'manual',
			appVersion: '1.0.0',
			now: at(2041, 20)
		});

		expect((await lastRun(owner))?.id).toBe(third);
		expect((await lastSucceeded(owner))?.id).toBe(first);
		expect((await recent(owner, 2)).map((run) => run.id)).toEqual([third, second]);

		const success = await lastSucceeded(owner);
		expect(success).toMatchObject({
			trigger: 'cron',
			status: 'succeeded',
			pathname: SUCCESS.pathname,
			bytes: SUCCESS.bytes,
			sha256: SUCCESS.sha256,
			format: SUCCESS.format,
			schemaTag: SUCCESS.schemaTag,
			appVersion: '1.0.0',
			rowCounts: SUCCESS.rowCounts,
			errorCode: null
		});
		await expect(recent(owner, 0)).rejects.toBeInstanceOf(RangeError);
	});

	it('deletes a run only once it is older than 400 days', async () => {
		await owner.query(
			"INSERT INTO backup_runs (trigger, status, started_at, finished_at) VALUES ('cron', 'failed', now() - interval '399 days', now() - interval '399 days')"
		);
		await expect(
			owner.query("DELETE FROM backup_runs WHERE started_at > now() - interval '400 days'")
		).rejects.toMatchObject(refused('23001', 'backup_runs_delete_guard'));

		const old = new Date(Date.now() - 401 * DAY);
		await owner.query(
			"INSERT INTO backup_runs (trigger, status, started_at, finished_at) VALUES ('cron', 'failed', $1, $1)",
			[old]
		);
		const { rowCount } = await owner.query(
			'DELETE FROM backup_runs WHERE started_at = $1 AND status = $2',
			[old, 'failed']
		);
		expect(rowCount).toBe(1);
	});

	it('refuses a malformed hash, negative bytes or a finish before its start, and takes real values', async () => {
		const insert = (startedAt: Date, finishedAt: Date, bytes: number, sha256: string) =>
			owner.query(
				"INSERT INTO backup_runs (trigger, status, started_at, finished_at, bytes, sha256) VALUES ('cron', 'succeeded', $1, $2, $3, $4)",
				[startedAt, finishedAt, bytes, sha256]
			);

		for (const sha256 of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64)]) {
			await expect(insert(at(2043), at(2043, 1), 2048, sha256)).rejects.toMatchObject(
				refused('23514', 'backup_runs_sha256_ck')
			);
		}
		await expect(insert(at(2043), at(2043, 1), -1, SUCCESS.sha256)).rejects.toMatchObject(
			refused('23514', 'backup_runs_bytes_ck')
		);
		await expect(insert(at(2043, 10), at(2043, 9), 2048, SUCCESS.sha256)).rejects.toMatchObject(
			refused('23514', 'backup_runs_finish_order_ck')
		);
		// The edges hold: zero bytes, a finish at the same instant as the start, and every hex digit.
		await expect(
			insert(at(2043, 20), at(2043, 20), 0, '0123456789abcdef'.repeat(4))
		).resolves.toBeDefined();
	});

	it('finishRun refuses a bad hash, negative bytes or a finish before its start, and leaves the run running', async () => {
		const id = await startRun(owner, { trigger: 'manual', appVersion: '1.0.0', now: at(2043, 30) });
		await expect(
			finishRun(owner, id, { ...SUCCESS, sha256: 'A'.repeat(64) }, at(2043, 31))
		).rejects.toMatchObject(refused('23514', 'backup_runs_sha256_ck'));
		await expect(
			finishRun(owner, id, { ...SUCCESS, bytes: -1 }, at(2043, 31))
		).rejects.toMatchObject(refused('23514', 'backup_runs_bytes_ck'));
		await expect(finishRun(owner, id, SUCCESS, at(2043, 29))).rejects.toMatchObject(
			refused('23514', 'backup_runs_finish_order_ck')
		);
		expect(await rowOf(id)).toMatchObject({ status: 'running', finished_at: null });

		expect(await finishRun(owner, id, SUCCESS, at(2043, 31))).toBe(true);
		expect(await rowOf(id)).toMatchObject({ status: 'succeeded', error_code: null });
	});

	it('coach_runtime has the uniform runtime grants', async () => {
		const { rows } = await owner.query<{
			select: boolean;
			insert: boolean;
			update: boolean;
			delete: boolean;
			truncate: boolean;
		}>(`SELECT has_table_privilege('coach_runtime', 'backup_runs', 'SELECT') AS "select",
			has_table_privilege('coach_runtime', 'backup_runs', 'INSERT') AS insert,
			has_table_privilege('coach_runtime', 'backup_runs', 'UPDATE') AS "update",
			has_table_privilege('coach_runtime', 'backup_runs', 'DELETE') AS delete,
			has_table_privilege('coach_runtime', 'backup_runs', 'TRUNCATE') AS truncate`);
		expect(rows[0]).toEqual({
			select: true,
			insert: true,
			update: true,
			delete: true,
			truncate: false
		});
		const { rows: defaults } = await owner.query<{ acl: string }>(
			`SELECT defaclacl::text AS acl FROM pg_default_acl
			WHERE defaclnamespace = 'public'::regnamespace AND defaclobjtype = 'r'`
		);
		expect(defaults.some((row) => row.acl.includes('coach_runtime='))).toBe(true);

		const id = await startRun(app, { trigger: 'manual', appVersion: 'runtime', now: at(2042, 0) });
		expect(
			await finishRun(app, id, { status: 'skipped', errorCode: 'already_running' }, at(2042, 1))
		).toBe(true);
		expect((await recent(app, 50)).map((run) => run.id)).toContain(id);

		await expect(
			app.query('UPDATE backup_runs SET app_version = $2 WHERE id = $1', [id, 'x'])
		).rejects.toMatchObject(refused('23001', 'backup_runs_update_guard'));
		await expect(app.query('TRUNCATE backup_runs')).rejects.toMatchObject({ code: '42501' });
	});
});
