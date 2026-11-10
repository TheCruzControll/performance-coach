/**
 * Vitest global setup for the live suite: the integration suite's own (it drops and re-migrates
 * TEST_DATABASE_URL, default coach_test, and refuses a name not ending in _test), but only when
 * the suite will run. Skipped, it needs no Postgres and touches nothing.
 */
import resetTestDatabase from '../integration/global-setup';
import { liveMode } from './gate';

export default async function setup(): Promise<void> {
	if (liveMode(process.env) === 'off') return;
	await resetTestDatabase();
}
