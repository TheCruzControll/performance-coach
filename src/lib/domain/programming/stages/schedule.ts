/**
 * The week judged as scheduled (M7's generator-schedule slice): the last stage, so it sees the real
 * demands after loads and the time fit. For now it leaves the draft as it is.
 */
import type { Stage } from '../stage.ts';

export const schedule: Stage = (draft) => draft;
