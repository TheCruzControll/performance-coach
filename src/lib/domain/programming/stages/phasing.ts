/**
 * Each week's main-lift prescription by the block's phase (M7's generator-phasing slice): it runs
 * after placement and before volume, because volume counts the main lifts' hard sets that phasing
 * sets. For now it leaves the draft as it is.
 */
import type { Stage } from '../stage.ts';

export const phasing: Stage = (draft) => draft;
