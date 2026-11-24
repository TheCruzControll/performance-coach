/**
 * About this app's data, for the three screens that show it: Profile (its About row's answer, and
 * the open side at a desk), Profile → About this app, and Speed (the vitals alone). Sections,
 * Appearance, Past goals and Security never load it, so opening them pings no database for one
 * row's answer (docs/decisions.md, v2/22f).
 *
 * Everything but the athlete streams: the page renders at once and the rows fill in. The response
 * has already started by then, so handleError never sees a streamed failure: each one is recorded
 * like any server error and its row degrades ("Can’t check now", "Not measured yet").
 */
import type { RequestEvent } from '@sveltejs/kit';
import { version } from '$app/env';
import { backupStatusView } from '#lib/domain/backup/status.ts';
import { getEnv } from '#lib/server/env.ts';
import { ownerId } from '#lib/server/forms/profile.ts';
import { logWhenSettled } from '#lib/server/observability/timing.ts';
import { backupsConfigured, readBackupLog } from '#lib/server/services/backups/status.ts';
import { recordServerError } from '#lib/server/services/errors.ts';
import { checkHealth } from '#lib/server/services/health.ts';
import { getAthleteProfile } from '#lib/server/services/profile/index.ts';
import { getVitalsSummary } from '#lib/server/services/vitals.ts';

/** What these reads need of a page's load event; a matched page always has a route id. */
type LoadEvent = Pick<RequestEvent, 'locals' | 'request' | 'url'> & { route: { id: string } };

/** A streamed read's catch: the failure is recorded under `load`, and the read answers null. */
export function failSoftFor({ locals, request, url, route }: LoadEvent) {
	return (load: string) => async (error: unknown) => {
		await recordServerError({
			error,
			kind: 'streamed',
			status: 500,
			requestId: locals.requestId,
			method: request.method,
			path: url.pathname,
			routeId: route.id,
			appVersion: version,
			context: { load }
		});
		return null;
	};
}

/** The p75 web vitals of the last 7 days, or null when the read failed. */
export const vitalsFor = (event: LoadEvent) =>
	getVitalsSummary(7).catch(failSoftFor(event)('getVitalsSummary'));

/**
 * The version, and streamed: the database's health (a 1.5 s probe, never a rejection), the
 * backups' status in words and the vitals. `also` is the caller's own streamed work, logged with
 * these once all of it has settled.
 */
export async function aboutData(event: LoadEvent, also: Promise<unknown>[] = []) {
	const failSoft = failSoftFor(event);
	const health = checkHealth({ version, timeoutMs: 1500 });
	const vitals = vitalsFor(event);
	// Only when backups are set up: a failed or slow read says "Can’t check now" (null).
	const now = new Date();
	const configured = backupsConfigured(getEnv());
	const backupLog = configured
		? readBackupLog().catch(failSoft('readBackupLog'))
		: Promise.resolve(null);
	logWhenSettled(event.route.id, [health, vitals, backupLog, ...also]);
	// The backups' words are made here, in the owner's time zone; the page only draws them.
	const athlete = await getAthleteProfile(ownerId(event.locals));

	return {
		version,
		athlete,
		health,
		vitals,
		backups: backupLog.then((log) => backupStatusView(log, configured, now, athlete.timeZone))
	};
}
