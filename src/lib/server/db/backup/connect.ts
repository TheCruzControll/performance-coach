/**
 * The backup's own connection: one named pg.Client, never the app's pool, so an export holds
 * exactly one backend for exactly its transaction and shows in pg_stat_activity as
 * 'coach-backup'. The cron export connects with DATABASE_URL (SELECT is all it needs).
 *
 * Server-only by use; imported by path with relative .ts specifiers, so scripts run it under
 * plain Node.
 */
import pg from 'pg';
import { connectionConfig } from '../connection.ts';

export const BACKUP_APPLICATION_NAME = 'coach-backup';

/** Connect, keep alive and query timeouts: a hung network never outlives a 60 s function. */
export const BACKUP_CLIENT_TIMEOUTS = {
	connectionTimeoutMillis: 10_000,
	query_timeout: 60_000,
	keepAlive: true
} as const;

/** A connected client; the caller ends it. */
export async function backupClient(url: string): Promise<pg.Client> {
	const client = new pg.Client({
		...connectionConfig(url),
		...BACKUP_CLIENT_TIMEOUTS,
		application_name: BACKUP_APPLICATION_NAME
	});
	await client.connect();
	return client;
}
