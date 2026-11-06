/**
 * The shape every generator stage shares (m3-plan 'The stage list exists from m3/13'). generate.ts
 * runs the stages in order on one draft: each takes the draft so far and returns the next one,
 * recording its choices in the shared decision log. A stage slice replaces only its own stub in
 * ./stages/, so none of them edits generate.ts.
 */
import type { IsoDate } from '../calendar.ts';
import type { BlockPlan } from '../training/types.ts';
import type { DecisionLog } from './decisions.ts';
import type { WeekDemand } from './demand.ts';
import type { ProgrammingInput } from './input.ts';

export interface GenerateOptions {
	/** The Monday of week 1. */
	startsOn: IsoDate;
	/** The first day with sessions, in week 1 (a 'This week' start is mid-week). */
	firstPlannedDay: IsoDate;
}

export interface StageContext {
	readonly input: ProgrammingInput;
	readonly options: GenerateOptions;
	readonly log: DecisionLog;
}

/** The plan so far. */
export interface Draft {
	/** The week's days and each goal's sessions: set by the demand stage. */
	demand: WeekDemand | null;
	/** The first block's weeks, then the outline: set by the blocks stage, filled by the rest. */
	blocks: BlockPlan[];
}

export type Stage = (draft: Draft, context: StageContext) => Draft;

/** The demand stage's result, for every stage after it. */
export function demandIn(draft: Draft): WeekDemand {
	if (!draft.demand) throw new Error('The demand stage runs first');
	return draft.demand;
}
