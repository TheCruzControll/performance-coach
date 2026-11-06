/**
 * Column helpers shared by the schema files. They are M2's private copies in profile.ts, defined
 * exactly the same way, so a table that switches to them generates the same SQL (`pnpm db:drift`
 * proves it). profile.ts moves to these in M3's coaching-memory slice.
 */
import { sql } from 'drizzle-orm';
import { timestamp, uuid } from 'drizzle-orm/pg-core';
import { owners } from './auth';

/** A CHECK body that limits `column` to a closed list of keys. */
export const inList = (column: string, values: readonly string[]) =>
	sql.raw(`${column} in (${values.map((v) => `'${v}'`).join(', ')})`);

/** `owner_id`: the owner's foreign key, removed with the owner (ON DELETE CASCADE). */
export const ownerRef = () =>
	uuid('owner_id')
		.notNull()
		.references(() => owners.id, { onDelete: 'cascade' });

export const createdAt = () =>
	timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
export const updatedAt = () =>
	timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
