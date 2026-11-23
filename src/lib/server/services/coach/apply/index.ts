/**
 * The applier for each proposal kind (the M5 plan's 'Proposals versus committed changes'):
 * acceptProposal looks one up here by the stored proposal's kind. Each group lives in its own
 * file, which one slice owns; a later group is one import and one spread below.
 */
import { NEXT_CYCLE_APPLIERS } from './next-cycle';
import { PROFILE_APPLIERS } from './profile';
import { PROGRAM_APPLIERS } from './program';
import { PROGRAM_CREATE_APPLIERS } from './program-create';
import { REPLAN_APPLIERS } from './replan';
import { SESSION_APPLIERS } from './session';
import type { Appliers } from './types';

export { ApplierUnavailableError } from './types';
export type { Applier, Appliers, ApplyInput, ApplyOutcome } from './types';

export const APPLIERS: Appliers = {
	...PROGRAM_APPLIERS,
	...PROGRAM_CREATE_APPLIERS,
	...NEXT_CYCLE_APPLIERS,
	...PROFILE_APPLIERS,
	...SESSION_APPLIERS,
	...REPLAN_APPLIERS
};
