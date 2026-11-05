import { desc, eq } from 'drizzle-orm';
import { appErrors } from '../schema';
import type { Executor } from '../types';

export type AppErrorRow = typeof appErrors.$inferSelect;
export type NewAppError = typeof appErrors.$inferInsert;

const MAX_TEXT = 8_000;
const clip = (value: string | null | undefined) =>
	value == null ? value : value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;

export function createAppErrorsRepository(db: Executor) {
	return {
		async insert(row: NewAppError): Promise<AppErrorRow> {
			const [created] = await db
				.insert(appErrors)
				.values({ ...row, message: clip(row.message) ?? '', stack: clip(row.stack) })
				.returning();
			if (!created) throw new Error('insert into app_errors returned no row');
			return created;
		},

		async findByRequestId(requestId: string): Promise<AppErrorRow[]> {
			return db
				.select()
				.from(appErrors)
				.where(eq(appErrors.requestId, requestId))
				.orderBy(desc(appErrors.occurredAt));
		},

		async recent(limit = 20): Promise<AppErrorRow[]> {
			return db.select().from(appErrors).orderBy(desc(appErrors.occurredAt)).limit(limit);
		}
	};
}
