/**
 * The week's training days and each goal's sessions (../demand.ts): the first stage, which every
 * later one reads through demandIn. With a season planned (prepare), the goals held at
 * maintenance in week 1 cap their streams at their doses.
 */
import { allocateWeek, weekBudget } from '../demand.ts';
import type { Stage } from '../stage.ts';

export const demand: Stage = (draft, { input, log }) => {
	const budget = weekBudget(input);
	const doses = draft.periodisation?.dosesByWeek[0]?.doses ?? [];
	return { ...draft, demand: { budget, allocation: allocateWeek(input, budget, log, doses) } };
};
