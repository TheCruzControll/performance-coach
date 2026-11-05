import { sql } from 'drizzle-orm';
import type { Executor } from '../types';

export function createSystemRepository(db: Executor) {
	return {
		/** A real round-trip to Postgres. Returns the server's current time. */
		async ping(): Promise<Date> {
			const result = await db.execute<{ now: string | Date }>(sql`select now() as now`);
			const value = result.rows[0]?.now;
			return value instanceof Date ? value : new Date(String(value));
		}
	};
}
