import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { NodePgDatabase, NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import type * as schema from './schema';

export type Schema = typeof schema;

/** The pooled application database handle. */
export type Database = NodePgDatabase<Schema>;

/**
 * Anything that can run queries: the database itself or an open transaction. Repositories
 * accept an `Executor` so callers (services, tests) decide the transaction boundary.
 */
export type Executor = PgDatabase<NodePgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;
