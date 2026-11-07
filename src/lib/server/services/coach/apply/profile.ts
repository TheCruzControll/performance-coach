/** Applying goal and preference proposals. Stubs until apply-profile-proposals replaces them. */
import { unavailable, type Appliers } from './types';

export const PROFILE_APPLIERS: Pick<Appliers, 'goal_update' | 'preference_update'> = {
	goal_update: unavailable('goal_update'),
	preference_update: unavailable('preference_update')
};
