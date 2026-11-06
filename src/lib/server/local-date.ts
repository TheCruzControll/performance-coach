/**
 * The owner's calendar day, which every program route starts from: which session is today's,
 * which week is this one, whether a session can still be edited. It is the day in the time zone
 * on the owner's profile (`UTC` until the device records one), never the server's or UTC's: in
 * the New Zealand summer (UTC+13), Auckland and UTC are on different days for thirteen hours of
 * every day.
 *
 * Services take explicit dates; routes compute today here, once per request, and pass it down.
 */
import type { IsoDate } from '../domain/calendar';
import { localDay } from '../domain/dates';
import { getAthleteProfile, type ProfileDeps } from './services/profile';

/** The ISO date it is at `now` for the owner, in the time zone their profile holds. */
export async function ownerToday(
	ownerId: string,
	now: Date,
	deps: Pick<ProfileDeps, 'db'> = {}
): Promise<IsoDate> {
	const { timeZone } = await getAthleteProfile(ownerId, deps);
	return localDay(now, timeZone);
}
