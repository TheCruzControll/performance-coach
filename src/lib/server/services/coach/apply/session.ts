/** Applying a one-session substitution. A stub until apply-session-program-cycle replaces it. */
import { unavailable, type Appliers } from './types';

export const SESSION_APPLIERS: Pick<Appliers, 'session_substitution'> = {
	session_substitution: unavailable('session_substitution')
};
