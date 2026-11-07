/**
 * Applying program proposals. Stubs until apply-program-proposals (program_adjustment,
 * workout_update) and apply-session-program-cycle (new_program, next_cycle) replace them.
 */
import { unavailable, type Appliers } from './types';

export const PROGRAM_APPLIERS: Pick<
	Appliers,
	'program_adjustment' | 'workout_update' | 'new_program' | 'next_cycle'
> = {
	program_adjustment: unavailable('program_adjustment'),
	workout_update: unavailable('workout_update'),
	new_program: unavailable('new_program'),
	next_cycle: unavailable('next_cycle')
};
