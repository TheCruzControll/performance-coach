/**
 * Today's Build my program as form actions (PRD §5): ?/preview runs the generator on the owner's
 * profile and returns what it would store; ?/build stores it as version 1 once the owner starts
 * it. Both go through programAction (program.ts), so a refusal reaches the screen as its field
 * errors (400) or its conflict's reason (409: 'profile', 'library', 'start_date' or
 * 'program_exists'); the programming services stay the authority.
 *
 * The owner's today (m3-plan 'The owner's local date'):
 * - Both actions read the device's IANA time zone, which the screen sends as `timeZone`, read
 *   with Intl when it posts. Each computes today in that zone, so the preview and the build
 *   agree on it whatever the zone or the time of day. An invalid or missing zone falls back to
 *   the profile's.
 * - The build records the zone on the profile (M2's saveBasics) when it differs, once the
 *   program is stored, so Train and Today use it from then on. The fingerprint ignores the zone,
 *   so the record never makes a retried build a conflict.
 */
import type { IsoDate } from '../../domain/calendar';
import { canonicalTimeZone, localDay } from '../../domain/dates';
import { getAthleteProfile, saveBasics } from '../services/profile';
import {
	buildProgram,
	DEFAULT_PROGRAM_START,
	previewProgram,
	START_OPTIONS,
	startDates,
	type ProgrammingDeps,
	type ProgramStart,
	type StartDates
} from '../services/programming/index';
import { programAction } from './program';

export type BuildDeps = Pick<ProgrammingDeps, 'db' | 'now' | 'catalogue'>;

/** What ?/preview returns: the preview, the day and start it was made for, and each start's dates. */
export interface PreviewResult {
	today: IsoDate;
	/** The start asked for, or DEFAULT_PROGRAM_START when none was. */
	start: ProgramStart;
	/** The starts the screen offers, with week 1's dates for each. */
	starts: Partial<Record<ProgramStart, StartDates>>;
	preview: Awaited<ReturnType<typeof previewProgram>>;
}

/** The owner's profile, the zone this request counts in, and today in that zone. */
async function ownersDay(owner: string, payload: unknown, { db, now }: BuildDeps) {
	const profile = await getAthleteProfile(owner, { db });
	const sent = (payload as { timeZone?: unknown } | null | undefined)?.timeZone;
	const timeZone = (typeof sent === 'string' && canonicalTimeZone(sent)) || profile.timeZone;
	const today: IsoDate = localDay(now?.() ?? new Date(), timeZone);
	return { profile, timeZone, today };
}

/** The posted request without the zone, which the services do not take, and with today. */
function requestFor(payload: unknown, today: IsoDate): Record<string, unknown> {
	const fields =
		payload && typeof payload === 'object' && !Array.isArray(payload)
			? (payload as Record<string, unknown>)
			: {};
	const { timeZone: _, ...rest } = fields;
	return { ...rest, today };
}

/** Today's build actions, on the app's database and the code's catalogue unless `deps` says. */
export function buildActions(deps: BuildDeps = {}) {
	return {
		/** The program the generator makes now, with its rationale; nothing is written. */
		preview: programAction(async (owner, payload): Promise<PreviewResult> => {
			const { today } = await ownersDay(owner, payload, deps);
			const request = { start: DEFAULT_PROGRAM_START, ...requestFor(payload, today) };
			const preview = await previewProgram(owner, request, deps);
			const starts = Object.fromEntries(START_OPTIONS.map((s) => [s, startDates(today, s)]));
			return { today, start: request.start as ProgramStart, starts, preview };
		}),
		/** Store the previewed program as version 1, then record the device's zone. */
		build: programAction(async (owner, payload) => {
			const { profile, timeZone, today } = await ownersDay(owner, payload, deps);
			const built = await buildProgram(owner, requestFor(payload, today), deps);
			if (timeZone !== profile.timeZone) {
				const { name, weightUnit, distanceUnit } = profile;
				await saveBasics(
					owner,
					{ name, weightUnit, distanceUnit, timeZone },
					{ db: deps.db, now: deps.now }
				);
			}
			return { programId: built.programId, created: built.created };
		})
	};
}
