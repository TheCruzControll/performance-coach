/**
 * The week evaluation as a SQL-side oracle for the M7 specs (m7/04): domain evaluateWeek over a
 * week as the store reads it back, as program-support.ts's weekViolations runs checkWeek. Created
 * once and never edited later: later specs keep their own helpers local.
 */
import { addDays } from '../src/lib/domain/calendar';
import type { WeekEvaluation } from '../src/lib/domain/programming/evaluate/types';
import { evaluateWeek } from '../src/lib/domain/programming/evaluate/week';
import { createDatabase, createPool } from '../src/lib/server/db/client';
import { LOCAL_DATABASE_URLS } from '../src/lib/server/db/migrate';
import { createProgramsRepository } from '../src/lib/server/db/repositories/programs';
import { toStoredSessions } from '../src/lib/server/services/programs/mapping';
import { query } from './support';

/**
 * The active program's current version, judged for the week that starts on `weekStart` with the
 * Sunday before it (a clash can cross the weekend), as of `today`. Skipped sessions are left
 * out by the judge itself. Only findings that reach into the week are returned.
 */
export async function weekEvaluation(weekStart: string, today: string): Promise<WeekEvaluation> {
	const pool = createPool(process.env.E2E_DATABASE_URL || LOCAL_DATABASE_URLS.e2e, { max: 1 });
	try {
		const repo = createProgramsRepository(createDatabase(pool));
		const [owner] = await query<{ id: string }>('select id from owners');
		const current = await repo.currentProgram(owner!.id);
		if (!current) throw new Error('weekEvaluation: there is no active program');
		const sunday = addDays(weekStart, -1);
		const weekEnd = addDays(weekStart, 6);
		const { weeks } = await repo.versionOutline(current.version.id);
		const ids = weeks.filter((w) => w.startsOn <= weekEnd && w.endsOn >= sunday).map((w) => w.id);
		if (!ids.length) throw new Error(`weekEvaluation: no planned week starts on ${weekStart}`);
		const sessions = [...toStoredSessions(await repo.weekSessions(ids)).values()].filter(
			(s) => s.date >= sunday && s.date <= weekEnd
		);
		// The same open dates as the service: the week's own dates from today on. Without them the
		// judge counts the Sunday before as free room, and finds spreads the service does not.
		const openDates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)).filter(
			(date) => date >= today
		);
		const evaluation = evaluateWeek(sessions, { today, openDates });
		return {
			...evaluation,
			findings: evaluation.findings.filter((f) => f.days.at(-1)! >= weekStart)
		};
	} finally {
		await pool.end();
	}
}
