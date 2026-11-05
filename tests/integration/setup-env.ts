/**
 * Per-worker setup: point the application's database client at the test database.
 */
import { afterAll } from 'vitest';
import { closeDb } from '../../src/lib/server/db';
import { LOCAL_DATABASE_URLS } from '../../src/lib/server/db/migrate';
import { resetEnvCache } from '../../src/lib/server/env';

const url = process.env.TEST_DATABASE_URL || LOCAL_DATABASE_URLS.test;
process.env.DATABASE_URL = url;
process.env.DATABASE_URL_UNPOOLED = url;
process.env.APP_ENV = 'test';
process.env.LOG_LEVEL ??= 'silent';
resetEnvCache();

afterAll(async () => {
	await closeDb();
});
