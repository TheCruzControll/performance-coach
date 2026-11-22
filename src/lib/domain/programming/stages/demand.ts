/**
 * The week's training days and each goal's sessions (../demand.ts): the first stage, which every
 * later one reads through demandIn.
 */
import { allocateWeek, weekBudget } from '../demand.ts';
import type { Stage } from '../stage.ts';

export const demand: Stage = (draft, { input, log }) => {
	const budget = weekBudget(input);
	return { ...draft, demand: { budget, allocation: allocateWeek(input, budget, log) } };
};
