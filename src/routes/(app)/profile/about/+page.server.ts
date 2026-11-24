import { aboutData } from '../about.server';
import type { PageServerLoad } from './$types';

/** Profile → About this app: the version, and the health, backups and vitals, streamed. */
export const load: PageServerLoad = async (event) => {
	// The athlete only dates the backups (in the owner's time zone): the page is not sent it.
	const { athlete: _athlete, ...about } = await aboutData(event);
	return about;
};
